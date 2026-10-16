// `npm run verify:live` — validates Mission Control against the REAL running cmux.
// Run it from a cmux terminal. It creates a temporary "mc-verify" workspace (and briefly a
// second window), exercises it through the cmux CLI, checks that Mission Control's state
// matches cmux's own `tree` output, then closes everything it created and restores focus.
// Agent lifecycle is exercised through cmux's real hook pipeline (`cmux hooks claude …`)
// with a synthetic session id; no LLM is run.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MissionControl } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import { createLogger } from '../server/src/logger.ts';
import type { MissionState } from '../shared/types.ts';

const cli = process.env.CMUX_BUNDLED_CLI_PATH ?? '/Applications/cmux.app/Contents/Resources/bin/cmux';
const reportPath = resolve(process.argv[2] ?? '.mc-data/verify-live.json');
const results: { id: string; name: string; ok: boolean; detail: string }[] = [];

function cmux(args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(cli, args, { encoding: 'utf8', input, env: { ...env, CMUX_QUIET: '1' }, timeout: 15_000 });
}
/** Close a workspace this script created; its shells count as running processes, so force it. */
const closeWorkspace = (id: string) => cmux(['close-workspace', '--workspace', id, '--force']);
const cmuxJson = <T>(args: string[]): T => JSON.parse(cmux([...args, '--json', '--id-format', 'uuids'])) as T;

async function waitFor<T>(label: string, fn: () => T | null | undefined | false, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** cmux applies some changes asynchronously; retry the comparison until both sides settle. */
async function settledTopology(state: () => MissionState, ms = 8000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      return compareTopology(state());
    } catch (err) {
      if (Date.now() - start > ms) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function check(id: string, name: string, fn: () => Promise<string> | string) {
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail });
    console.log(`  ✓ ${id} ${name} — ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ id, name, ok: false, detail });
    console.log(`  ✗ ${id} ${name} — ${detail}`);
  }
}

interface CliTree {
  windows: { id: string; workspaces: { id: string; title: string; panes: { id: string; surfaces: { id: string; type: string }[] }[] }[] }[];
}

/** Compare Mission Control's topology with an independent `cmux tree --all` read. */
function compareTopology(s: MissionState): string {
  const t = cmuxJson<CliTree>(['tree', '--all']);
  const problems: string[] = [];
  const wsIds = t.windows.flatMap((w) => w.workspaces.map((x) => x.id));
  const paneIds = t.windows.flatMap((w) => w.workspaces.flatMap((x) => x.panes.map((p) => p.id)));
  const surfaces = t.windows.flatMap((w) => w.workspaces.flatMap((x) => x.panes.flatMap((p) => p.surfaces.map((sf) => ({ ...sf, paneId: p.id, wsId: x.id })))));
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  if (!same(t.windows.map((w) => w.id), s.windowOrder)) problems.push('window ids differ');
  if (!same(wsIds, Object.keys(s.workspaces))) problems.push('workspace ids differ');
  if (!same(paneIds, Object.keys(s.panes))) problems.push('pane ids differ');
  if (!same(surfaces.map((x) => x.id), Object.keys(s.surfaces))) problems.push('surface ids differ');
  for (const sf of surfaces) {
    const mine = s.surfaces[sf.id];
    if (mine && (mine.paneId !== sf.paneId || mine.workspaceId !== sf.wsId)) problems.push(`surface ${sf.id.slice(0, 8)} placed differently`);
  }
  if (problems.length) throw new Error(problems.join('; '));
  return `${t.windows.length} windows, ${wsIds.length} workspaces, ${paneIds.length} panes, ${surfaces.length} surfaces match cmux tree`;
}

async function main() {
  if (!process.env.CMUX_SURFACE_ID) {
    console.error('verify:live must run inside a cmux terminal (cmux socket mode "cmuxOnly").');
    process.exit(2);
  }
  console.log(`cmux Mission Control — live verification against ${cmux(['--version']).trim()}\n`);
  const dataDir = mkdtempSync(join(tmpdir(), 'mc-verify-'));
  const config = loadConfig({ ...process.env, MC_DATA_DIR: dataDir, MC_PORT: '4317' });
  const mc = new MissionControl({ config, log: createLogger('verify', { level: 'warn' }), refreshDebounceMs: 40, refreshMaxWaitMs: 200 });
  const state = () => mc.state.build();
  const originalWorkspace = cmuxJson<{ focused?: { workspace_id?: string } }>(['identify']).focused?.workspace_id ?? null;
  let wsId: string | null = null;
  let windowId: string | null = null;
  const hookRef: { proc: ReturnType<typeof spawn> | null } = { proc: null };
  const session = `mc-verify-${process.pid}`;

  try {
    mc.start();
    await check('AC-01', 'connects and shows real workspaces', async () => {
      await waitFor('live', () => state().connection.phase === 'live');
      return settledTopology(state);
    });

    await check('AC-02', 'a workspace created in cmux appears', async () => {
      const title = `mc-verify-${process.pid}`;
      cmux(['new-workspace', '--name', title, '--cwd', tmpdir(), '--focus', 'false']);
      const ws = await waitFor('workspace in state', () => Object.values(state().workspaces).find((w) => w.title === title));
      wsId = ws.id;
      return `“${title}” appeared as ${ws.id.slice(0, 8)} via ${mc.activity.query({ workspaceId: ws.id }).map((e) => e.kind).join(', ') || 'snapshot'}`;
    });

    await check('AC-04', 'splits and tab moves are reflected in the pane/tab hierarchy', async () => {
      if (!wsId) throw new Error('no test workspace');
      cmux(['new-split', 'right', '--workspace', wsId, '--focus', 'false']);
      await waitFor('two panes', () => state().workspaces[wsId!]?.paneIds.length === 2);
      cmux(['new-surface', '--workspace', wsId, '--focus', 'false']);
      const [p1, p2] = state().workspaces[wsId]!.paneIds;
      const moving = await waitFor('second tab', () => state().panes[p1!]?.surfaceIds.length === 2 && state().panes[p1!]!.surfaceIds[1]);
      cmux(['move-surface', '--surface', moving, '--pane', p2!, '--workspace', wsId, '--focus', 'false']);
      await waitFor('moved tab', () => state().surfaces[moving]?.paneId === p2);
      return `2 panes; tab ${moving.slice(0, 8)} moved to pane 2 — ${await settledTopology(state)}`;
    });

    await check('MULTI-WINDOW', 'a second window and its workspace are tracked', async () => {
      const before = new Set(state().windowOrder);
      cmux(['new-window']);
      const win = await waitFor('new window', () => state().windowOrder.find((id) => !before.has(id)));
      windowId = win;
      const ws = await waitFor('workspace in new window', () => state().windows[win]?.workspaceIds[0]);
      const cwd = state().workspaces[ws]?.cwd;
      return `window ${win.slice(0, 8)} with workspace ${ws.slice(0, 8)}; sidebar enrichment ${cwd ? 'present' : 'missing'} — ${await settledTopology(state)}`;
    });
    if (windowId) {
      cmux(['close-window', '--window', windowId, '--force']);
      await waitFor('window closed', () => !state().windows[windowId!]).catch(() => undefined);
      windowId = null;
    }

    // Agent lifecycle through cmux's real hook pipeline, attributed to the test workspace's terminal.
    const terminal = wsId ? Object.values(state().surfaces).find((s) => s.workspaceId === wsId && s.type === 'terminal') : undefined;
    const hookEnv = { ...process.env, CMUX_WORKSPACE_ID: wsId ?? '', CMUX_SURFACE_ID: terminal?.id ?? '' };
    const key = `claude:${session}`;
    const send = (sub: string, body: Record<string, unknown>) => cmux(['hooks', 'claude', sub], JSON.stringify({ session_id: session, cwd: tmpdir(), ...body }), hookEnv);

    await check('AC-05', 'agent lifecycle events update agent status', async () => {
      if (!terminal) throw new Error('no terminal in test workspace');
      send('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
      send('prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'verification prompt' });
      await waitFor('working', () => state().agents[key]?.state === 'working');
      const a = state().agents[key]!;
      if (a.surfaceId !== terminal.id) throw new Error(`agent mapped to wrong surface ${a.surfaceId}`);
      return `Claude Code session ${session} → working on ${terminal.id.slice(0, 8)} (${a.stateSource})`;
    });

    await check('AC-06', 'a permission request appears in the Attention Center', async () => {
      hookRef.proc = spawn(cli, ['hooks', 'feed', '--source', 'claude'], { env: hookEnv, stdio: ['pipe', 'ignore', 'ignore'] });
      hookRef.proc.stdin!.end(JSON.stringify({ session_id: session, hook_event_name: 'PermissionRequest', cwd: tmpdir(), tool_name: 'Bash', tool_input: { command: 'echo verify' } }));
      const item = await waitFor('permission attention', () => state().attention.find((a) => a.kind === 'permission' && a.agentKey === key));
      if (item.surfaceId !== terminal?.id) throw new Error('attention item not attributed to the terminal');
      if (state().agents[key]?.state !== 'needs_attention') throw new Error('agent not marked as needing attention');
      return `“${item.title}” on ${item.surfaceId?.slice(0, 8)} (${item.source})`;
    });

    await check('RESOLVE', 'the item clears when the agent moves on (turn completes)', async () => {
      hookRef.proc?.kill();
      send('stop', { hook_event_name: 'Stop', stop_hook_active: false });
      await waitFor('attention cleared', () => !state().attention.some((a) => a.agentKey === key && a.kind === 'permission'));
      await waitFor('idle', () => state().agents[key]?.state === 'idle');
      return `permission expired in cmux Feed; agent idle; turns observed: ${state().agents[key]?.turnsCompleted}`;
    });

    await check('PROGRAM', 'a terminal program error (OSC 7501) is surfaced', async () => {
      if (!wsId || !terminal) throw new Error('no terminal');
      const script = join(dataDir, 'osc.sh');
      writeFileSync(script, `printf '\\033]7501;state=error\\033\\\\'\n`);
      cmux(['send', '--workspace', wsId, '--surface', terminal.id, `sh ${script}\n`]);
      await waitFor('program error', () => state().attention.some((a) => a.kind === 'program_error' && a.surfaceId === terminal.id));
      return `program_error attention on ${terminal.id.slice(0, 8)}; workspacesWithErrors=${state().kpis.workspacesWithErrors}`;
    });

    await check('AC-07', 'navigation focuses the right workspace and tab in cmux', async () => {
      if (!wsId || !terminal) throw new Error('no target');
      const r = await mc.navigate({ kind: 'surface', workspaceId: wsId, surfaceId: terminal.id });
      if (!r.ok) throw new Error(r.error);
      const focused = cmuxJson<{ focused?: { workspace_id?: string; surface_id?: string } }>(['identify']).focused;
      if (focused?.workspace_id !== wsId) throw new Error(`cmux focused workspace ${focused?.workspace_id}`);
      if (focused?.surface_id !== terminal.id) throw new Error(`cmux focused surface ${focused?.surface_id}`);
      return 'cmux identify reports the requested workspace and surface as focused';
    });

    await check('AC-08', 'the event stream reconnects and replays missed events', async () => {
      if (!wsId) throw new Error('no workspace');
      const renamed = `mc-verify-renamed-${process.pid}`;
      mc.reconnectStream('live verification');
      cmux(['rename-workspace', '--workspace', wsId, renamed]);
      await waitFor('renamed after reconnect', () => state().workspaces[wsId!]?.title === renamed && state().connection.phase === 'live');
      const renames = mc.activity.query({ workspaceId: wsId, kind: 'workspace.renamed' }).length;
      if (renames !== 1) throw new Error(`expected exactly one rename event, got ${renames}`);
      return `rename during reconnect delivered once; gap=${state().connection.gapDetectedAt ? 'yes' : 'no'}`;
    });

    send('session-end', { hook_event_name: 'SessionEnd', reason: 'exit' });
    await check('AC-03', 'closing a workspace removes it from the live overview', async () => {
      if (!wsId) throw new Error('no workspace');
      closeWorkspace(wsId);
      await waitFor('workspace removed', () => !state().workspaces[wsId!]);
      const id = wsId;
      wsId = null;
      if (state().attention.some((a) => a.workspaceId === id)) throw new Error('attention items survived the workspace');
      return `removed; ${await settledTopology(state)}`;
    });
  } finally {
    hookRef.proc?.kill();
    const quietly = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        console.error('cleanup:', err instanceof Error ? err.message.split('\n')[0] : err);
      }
    };
    if (wsId) quietly(() => closeWorkspace(wsId!));
    if (windowId) quietly(() => cmux(['close-window', '--window', windowId!, '--force']));
    if (originalWorkspace) quietly(() => cmux(['select-workspace', '--workspace', originalWorkspace]));
    await mc.stop();
  }

  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), cmux: cmux(['--version']).trim(), results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed. Report: ${reportPath}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
