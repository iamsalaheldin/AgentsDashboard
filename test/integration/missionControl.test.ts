// End-to-end backend tests: the real SocketRpc / EventStream / StateManager / HTTP stack
// against a fake cmux socket that speaks the verified protocol. Passing these proves the
// logic, NOT live cmux integration — see `npm run verify:live` for that.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MissionControl } from '../../server/src/app.ts';
import { createHttpServer } from '../../server/src/http/server.ts';
import { silentLogger } from '../../server/src/logger.ts';
import type { MissionState } from '../../shared/types.ts';
import { FakeCmux, seedDemo, uuid } from '../support/fakeCmux.ts';
import { tempDir, testConfig, waitFor } from '../support/helpers.ts';

let dir: string;
let fake: FakeCmux;
let mc: MissionControl;
let demo: ReturnType<typeof seedDemo>;

function makeMc(overrides: Parameters<typeof testConfig>[1] = {}) {
  return new MissionControl({
    config: testConfig(dir, { socketPath: fake.socketPath, ...overrides }),
    log: silentLogger,
    refreshDebounceMs: 10,
    refreshMaxWaitMs: 50,
    minBackoffMs: 20,
    maxBackoffMs: 100,
    stallFactor: 2.5,
  });
}

const state = (): MissionState => mc.state.build();
const live = () => waitFor(() => state().connection.phase === 'live', 5000, 'live connection');

beforeEach(async () => {
  dir = tempDir('mc-it-');
  fake = new FakeCmux({ socketPath: join(dir, 'cmux.sock'), heartbeatSeconds: 0.2 });
  demo = seedDemo(fake);
  await fake.start();
  mc = makeMc();
});

afterEach(async () => {
  await mc.stop();
  await fake.stop();
});

describe('initial synchronization', () => {
  it('shows real workspaces across multiple windows with correct hierarchy (AC-01, AC-04)', async () => {
    mc.start();
    await live();
    const s = state();
    expect(s.windowOrder).toHaveLength(2);
    expect(Object.values(s.workspaces).map((w) => w.title).sort()).toEqual(['billing-api', 'ops', 'web-app']);
    const api = s.workspaces[demo.ids.wsApi]!;
    expect(api.paneIds).toEqual([demo.ids.paneApi1, demo.ids.paneApi2]);
    expect(s.panes[demo.ids.paneApi1]!.surfaceIds).toEqual([demo.ids.sClaude, demo.ids.sTests]);
    expect(s.surfaces[demo.ids.sBrowser]!.type).toBe('browser');
    expect(api.git?.branch).toBe('feature/invoices');
    expect(s.workspaces[demo.ids.wsOps]!.windowId).toBe(fake.windows[1]!.id);
    expect(s.kpis).toMatchObject({ windows: 2, workspaces: 3, panes: 4, surfaces: 5, agentsDetected: 2, agentsWorking: 1 });
    // Regular terminals and browsers are not agents.
    expect(Object.values(s.agents).map((a) => a.surfaceId).sort()).toEqual([demo.ids.sClaude, demo.ids.sCodex].sort());
    expect(s.capabilities?.methods).toContain('current.list');
    expect(s.connection.cmuxVersion).toBe('0.65.2-fake');
  });
});

describe('replay history from an earlier cmux process (seen on real cmux 0.65.2)', () => {
  it('records prior-boot replay as history and still processes live events', async () => {
    fake.seedPriorBootHistory(3);
    mc.start();
    await live();
    await waitFor(() => mc.activity.query({ kind: 'workspace.closed' }).length === 3, 3000, 'old history recorded');
    fake.hook('claude', 'sess-claude-1', 'Stop', demo.claude);
    await waitFor(() => state().agents['claude:sess-claude-1']?.turnsCompleted === 1, 3000, 'live event processed');
    expect(state().connection.bootId).toBe(fake.bootId);
    expect(state().connection.reconnectAttempt).toBe(0);
  });
});

describe('interrupted replay (seen on real cmux 0.65.2)', () => {
  it('resumes a replay that cmux cuts short without reporting a disconnect', async () => {
    for (let i = 0; i < 25; i++) fake.emit('workspace.closed', 'workspace', { title: `w${i}` }, { workspace_id: uuid() });
    fake.cutReplayAfter = 10;
    const phases: string[] = [];
    mc.state.subscribe(() => phases.push(mc.state.getConnection().phase));
    mc.start();
    await waitFor(() => mc.activity.query({ kind: 'workspace.closed' }).length === 25, 5000, 'full replay');
    fake.cutReplayAfter = null;
    await live();
    expect(phases).not.toContain('reconnecting');
  });
});

describe('live updates', () => {
  beforeEach(async () => {
    mc.start();
    await live();
  });

  it('adds a created workspace and removes a closed one (AC-02, AC-03)', async () => {
    const id = uuid();
    fake.addWorkspace(fake.windows[0]!.id, { id, title: 'new-ws', panes: [{ id: uuid(), surfaces: [{ id: uuid(), type: 'terminal', title: 'zsh' }] }] });
    await waitFor(() => state().workspaces[id], 3000, 'workspace created');
    fake.closeWorkspace(id);
    await waitFor(() => !state().workspaces[id], 3000, 'workspace closed');
    const kinds = mc.activity.query({ workspaceId: id }).map((e) => e.kind);
    expect(kinds).toContain('workspace.created');
    expect(kinds).toContain('workspace.closed');
  });

  it('tracks a surface moving between workspaces', async () => {
    fake.moveSurface(demo.ids.sTests, demo.ids.wsOps, demo.ids.paneOps);
    await waitFor(() => state().surfaces[demo.ids.sTests]?.workspaceId === demo.ids.wsOps, 3000, 'surface moved');
    expect(state().panes[demo.ids.paneApi1]!.surfaceIds).toEqual([demo.ids.sClaude]);
  });

  it('surfaces a permission request in the Attention Center and clears it on resolution (AC-05, AC-06)', async () => {
    const item = fake.requestPermission(demo.claude, 'Bash');
    const att = await waitFor(() => state().attention.find((a) => a.kind === 'permission'), 3000, 'permission attention');
    expect(att).toMatchObject({ workspaceId: demo.ids.wsApi, surfaceId: demo.ids.sClaude, agentKind: 'claude', title: 'Permission request: Bash' });
    expect(state().attention.filter((a) => a.surfaceId === demo.ids.sClaude)).toHaveLength(1);
    expect(state().summaries[demo.ids.wsApi]!.health).toBe('needs_attention');

    fake.resolvePermission(item, demo.claude, 'allow');
    await waitFor(() => !state().attention.some((a) => a.kind === 'permission'), 3000, 'permission resolved');
    expect(state().agents['claude:sess-claude-1']!.state).toBe('working');
    expect(mc.activity.query({ kind: 'agent.permission_resolved' })[0]?.summary).toContain('allow');
  });

  it('records a completed turn as a turn, with the agent idle — not a completed task', async () => {
    fake.setAgent({ ...demo.claude, state: 'idle' });
    fake.hook('claude', 'sess-claude-1', 'Stop', demo.claude);
    await waitFor(() => state().agents['claude:sess-claude-1']?.state === 'idle', 3000, 'idle');
    const a = state().agents['claude:sess-claude-1']!;
    expect(a.turnsCompleted).toBe(1);
    expect(state().kpis.turnsCompleted24h).toBe(1);
    expect(state().summaries[demo.ids.wsApi]!.headline).toBe('Claude Code finished its turn · idle');
  });

  it('reports a terminal program error and its workspace in KPIs', async () => {
    fake.programStatus(demo.ids.wsOps, demo.ids.sShell, 'error');
    await waitFor(() => state().kpis.workspacesWithErrors === 1, 3000, 'error kpi');
    expect(state().attention[0]).toMatchObject({ kind: 'program_error', surfaceId: demo.ids.sShell });
  });

  it('ignores duplicate event delivery', async () => {
    const seq = fake.emit('notification.created', 'notification', { notification_id: uuid() }, { workspace_id: demo.ids.wsOps });
    fake.redeliver(seq);
    fake.redeliver(seq);
    await waitFor(() => mc.activity.query({ kind: 'notification.created' }).length > 0, 3000, 'notification recorded');
    await new Promise((r) => setTimeout(r, 100));
    expect(mc.activity.query({ kind: 'notification.created' })).toHaveLength(1);
  });
});

describe('recovery', () => {
  beforeEach(async () => {
    mc.start();
    await live();
  });

  it('reconnects after a dropped stream and resumes from its cursor without duplicates (AC-08)', async () => {
    const before = mc.activity.query().length;
    fake.dropStreams();
    // An event emitted while disconnected must arrive via replay.
    const id = uuid();
    fake.addWorkspace(fake.windows[0]!.id, { id, title: 'while-away', panes: [{ id: uuid(), surfaces: [{ id: uuid(), type: 'terminal', title: 'zsh' }] }] });
    await waitFor(() => state().workspaces[id] && state().connection.phase === 'live', 5000, 'resumed');
    expect(mc.activity.query().length).toBe(before + 2); // workspace.created + surface.created, exactly once
    expect(mc.activity.query({ kind: 'connection.gap' })).toHaveLength(0);
  });

  it('marks state stale while cmux is gone and resyncs after a cmux restart', async () => {
    await fake.stop();
    await waitFor(() => state().connection.phase === 'reconnecting', 3000, 'reconnecting');
    expect(state().connection).toMatchObject({ stale: true, problem: 'not_running' });
    // The previous topology is still displayed, but flagged stale.
    expect(Object.keys(state().workspaces)).toHaveLength(3);

    const oldBoot = fake.bootId;
    fake.closeWorkspace(demo.ids.wsOps); // a change that happens "during" the restart
    await fake.restart();
    await waitFor(() => state().connection.phase === 'live' && state().connection.bootId === fake.bootId, 5000, 'live after restart');
    expect(fake.bootId).not.toBe(oldBoot);
    expect(state().workspaces[demo.ids.wsOps]).toBeUndefined();
    expect(mc.activity.query({ kind: 'connection.restart' })).toHaveLength(1);
    expect(state().connection.stale).toBe(false);
  });

  it('detects a replay gap, resynchronizes and marks program status unknown', async () => {
    await mc.stop();
    await fake.stop();
    fake = new FakeCmux({ socketPath: join(dir, 'cmux.sock'), heartbeatSeconds: 0.2, bufferLimit: 5 });
    demo = seedDemo(fake);
    await fake.start();
    mc = makeMc();
    mc.start();
    await live();
    const gapsBefore = mc.activity.query({ kind: 'connection.gap' }).length;
    fake.programStatus(demo.ids.wsOps, demo.ids.sShell, 'working');
    await waitFor(() => state().surfaces[demo.ids.sShell]?.programStatus?.length === 1, 3000, 'program status');
    fake.dropStreams();
    fake.muteHeartbeats = true;
    for (let i = 0; i < 20; i++) fake.emit('surface.action', 'surface', {}, { workspace_id: demo.ids.wsOps }); // overflow the 5-event buffer
    fake.muteHeartbeats = false;
    await waitFor(() => mc.activity.query({ kind: 'connection.gap' }).length === gapsBefore + 1, 5000, 'gap entry');
    await live();
    expect(state().surfaces[demo.ids.sShell]!.programStatus).toBeNull();
  });

  it('reconnects when the stream stalls (no heartbeats)', async () => {
    const firstSub = fake.calls.length;
    fake.muteHeartbeats = true;
    await waitFor(() => state().connection.problem === 'stream_stalled', 5000, 'stall detected');
    fake.muteHeartbeats = false;
    await live();
    expect(fake.calls.length).toBeGreaterThan(firstSub); // re-snapshotted after reconnect
  });
});

describe('connection problems', () => {
  it('reports access denied without retrying aggressively', async () => {
    fake.accessDenied = true;
    mc.start();
    await waitFor(() => state().connection.problem === 'access_denied', 3000, 'access denied');
    expect(state().connection.phase).toBe('unavailable');
    expect(state().connection.message).toMatch(/only processes started inside cmux/);
    fake.accessDenied = false;
    await live(); // recovers once access is granted
  });

  it('reports not_installed when neither the app nor a socket exists', async () => {
    await fake.stop();
    await mc.stop();
    mc = makeMc({ cmuxAppPath: join(dir, 'missing.app') });
    mc.start();
    await waitFor(() => state().connection.problem === 'not_installed', 3000, 'not installed');
    expect(state().connection.phase).toBe('unavailable');
  });

  it('reports not_running when cmux is installed but not running', async () => {
    await fake.stop();
    await mc.stop();
    mc = makeMc(); // "installed": the app path exists
    mc.start();
    await waitFor(() => state().connection.problem === 'not_running', 3000, 'not running');
    expect(state().connection.phase).toBe('reconnecting');
    expect(Object.keys(state().workspaces)).toHaveLength(0); // never fabricates data
  });
});

describe('HTTP API', () => {
  let server: Server;
  let base: string;
  let port: number;

  beforeEach(async () => {
    mc.start();
    await live();
    server = createHttpServer({ mc, log: silentLogger, host: '127.0.0.1', port: 0, staticDir: join(dir, 'none'), sseThrottleMs: 10 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('navigates through allowlisted cmux methods only (AC-07)', async () => {
    fake.calls = [];
    const res = await post('/api/navigate', { kind: 'surface', workspaceId: demo.ids.wsWeb, surfaceId: demo.ids.sCodex });
    expect(res.status).toBe(200);
    expect(fake.calls.map((c) => c.method)).toEqual(['window.focus', 'workspace.select', 'surface.focus']);
    expect(fake.calls[2]!.params).toEqual({ workspace_id: demo.ids.wsWeb, surface_id: demo.ids.sCodex });
  });

  it('rejects navigation to targets that do not exist or do not match', async () => {
    expect((await post('/api/navigate', { kind: 'workspace', workspaceId: uuid() })).status).toBe(409);
    expect((await post('/api/navigate', { kind: 'surface', workspaceId: demo.ids.wsApi, surfaceId: demo.ids.sCodex })).status).toBe(409);
    expect((await post('/api/navigate', { kind: 'workspace', workspaceId: 'workspace:1' })).status).toBe(400);
  });

  it('guards against DNS rebinding, cross-origin writes and non-JSON bodies', async () => {
    const http = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'attacker.example' } }, (r) => resolve(r.statusCode ?? 0));
    });
    expect(status).toBe(421);
    expect((await post('/api/navigate', { kind: 'workspace', workspaceId: demo.ids.wsApi }, { origin: 'https://evil.example' })).status).toBe(403);
    const res = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
  });

  it('serves state, filtered activity, settings and an SSE stream', async () => {
    const s = (await (await fetch(base + '/api/state')).json()) as MissionState;
    expect(Object.keys(s.workspaces)).toHaveLength(3);
    const put = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ showPromptPreviews: true }) });
    expect(await put.json()).toEqual({ showPromptPreviews: true });
    expect(state().workspaces[demo.ids.wsApi]!.latestPrompt?.text).toBe('Add pagination to the invoices endpoint');
    expect((await fetch(base + '/api/activity?limit=abc')).status).toBe(400);

    const ctrl = new AbortController();
    const res = await fetch(base + '/api/stream', { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first.startsWith('event: state\n')).toBe(true);
    ctrl.abort();
  });
});
