import { describe, expect, it } from 'vitest';
import { agentDefinition, decodeWorkstreamId, normalizeRegistryState } from '../../server/src/domain/agents/index.ts';
import { buildAttention } from '../../server/src/domain/attention.ts';
import { ProgramStatusStore } from '../../server/src/domain/programStatus.ts';
import { parseStatusCommand, tokenize } from '../../server/src/domain/statusPills.ts';
import { deterministicSummarizer, describeAgent } from '../../server/src/domain/summarize.ts';
import { createLogger, redact } from '../../server/src/logger.ts';
import { NavigateSchema, ActivityQuerySchema, SettingsPatchSchema } from '../../server/src/http/server.ts';
import type { AgentSession, Surface, Workspace } from '../../shared/types.ts';

const WS = '11111111-1111-1111-1111-111111111111';
const SF = '22222222-2222-2222-2222-222222222222';

const agent = (over: Partial<AgentSession> = {}): AgentSession => ({
  key: 'claude:s1',
  kind: 'claude',
  displayName: 'Claude Code',
  sessionId: 's1',
  surfaceId: SF,
  workspaceId: WS,
  state: 'working',
  sourceState: 'working',
  stateSource: 'cmux-registry',
  lastHook: null,
  lastActivityAt: 1000,
  stateSince: 1000,
  turnsCompleted: 0,
  pendingPermission: null,
  ...over,
});

const surface = (over: Partial<Surface> = {}): Surface => ({
  id: SF,
  ref: null,
  paneId: 'p',
  workspaceId: WS,
  index: 0,
  title: 't',
  type: 'terminal',
  rawType: 'terminal',
  url: null,
  tty: null,
  focused: false,
  selectedInPane: true,
  renderHealth: null,
  programStatus: [],
  lastActivityAt: null,
  isMissionControl: false,
  ...over,
});

describe('agents', () => {
  it('decodes the real cmux workstream id', () => {
    expect(decodeWorkstreamId('cmux-feed-v1:Y2xhdWRl:bWMtcHJvYmUtNTgyODc=')).toEqual({ source: 'claude', sessionId: 'mc-probe-58287' });
    expect(decodeWorkstreamId('plain-session')).toBeNull();
  });

  it('normalizes registry states without collapsing distinct ones', () => {
    expect(normalizeRegistryState('working')).toBe('working');
    expect(normalizeRegistryState('needs_input')).toBe('needs_attention');
    expect(normalizeRegistryState('idle')).toBe('idle');
    expect(normalizeRegistryState('ended')).toBe('ended');
    expect(normalizeRegistryState('something-new')).toBe('unknown');
  });

  it('has generic definitions for other cmux-integrated agents', () => {
    expect(agentDefinition('opencode').displayName).toBe('OpenCode');
    expect(agentDefinition('brand-new').displayName).toBe('Brand-new');
    expect(agentDefinition('codex').permissionHookBlocks).toBe(false);
  });
});

describe('attention', () => {
  const ws = {} as Record<string, Workspace>;
  it('dedupes a pending permission with the agent needs_input state and lower-priority sources', () => {
    const items = buildAttention({
      agents: [agent({ state: 'needs_attention', sourceState: 'needs_input' })],
      pendingFeed: [{ id: 'f1', kind: 'permission', requestId: 'r', toolName: 'Bash', agentKind: 'claude', agentKey: 'claude:s1', workspaceId: WS, surfaceId: SF, since: 5 }],
      surfaces: { [SF]: surface({ programStatus: [{ id: '', state: 'blocked', kind: 'none', progress: null, updatedAt: 1 }] }) },
      workspaces: ws,
      notifications: [{ id: 'n1', title: 'Claude Code', subtitle: null, body: 'needs permission', is_read: false, created_at: null, workspace_id: WS, surface_id: SF }],
    });
    expect(items.map((i) => i.kind)).toEqual(['permission']);
  });

  it('orders by urgency then recency and ignores read notifications', () => {
    const other = '33333333-3333-3333-3333-333333333333';
    const items = buildAttention({
      agents: [agent({ state: 'error', sourceState: 'hook:StopFailure', surfaceId: other })],
      pendingFeed: [],
      surfaces: { [SF]: surface({ programStatus: [{ id: '', state: 'error', kind: 'none', progress: null, updatedAt: 9 }] }) },
      workspaces: ws,
      notifications: [
        { id: 'n1', title: 'Build', subtitle: null, body: null, is_read: false, created_at: null, workspace_id: WS, surface_id: null },
        { id: 'n2', title: 'Old', subtitle: null, body: null, is_read: true, created_at: null, workspace_id: WS, surface_id: null },
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['agent_error', 'program_error', 'notification']);
  });

  it('produces nothing for unknown program status (null)', () => {
    expect(buildAttention({ agents: [], pendingFeed: [], surfaces: { [SF]: surface({ programStatus: null }) }, workspaces: ws, notifications: [] })).toEqual([]);
  });
});

describe('program status store', () => {
  it('assembles chunked snapshots only when complete', () => {
    const st = new ProgramStatusStore();
    const rec = (state: string) => ({ id: state, state, kind: 'none', progress: null });
    expect(st.apply(WS, SF, { event: 'report', snapshot_id: 'x', snapshot_count: 2, snapshot_index: 1, records: [rec('done')] }, 1)).toBeNull();
    const ch = st.apply(WS, SF, { event: 'report', snapshot_id: 'x', snapshot_count: 2, snapshot_index: 0, records: [rec('working')] }, 2);
    expect(ch?.records.map((r) => r.state)).toEqual(['working', 'done']);
    st.apply(WS, SF, { event: 'removed', records: [] }, 3);
    expect(st.get(WS, SF)).toEqual([]);
  });

  it('handles a move as removed (old workspace) then adopted (new workspace)', () => {
    const st = new ProgramStatusStore();
    const WS2 = '44444444-4444-4444-4444-444444444444';
    st.apply(WS, SF, { event: 'report', records: [{ id: '', state: 'working' }], snapshot_count: 1 }, 1);
    st.apply(WS, SF, { event: 'removed', records: [] }, 2);
    st.apply(WS2, SF, { event: 'adopted', records: [{ id: '', state: 'working' }], snapshot_count: 1 }, 3);
    expect(st.get(WS, SF)).toEqual([]);
    expect(st.get(WS2, SF)?.[0]?.state).toBe('working');
  });

  it('ignores unknown states and reports unknown after a gap', () => {
    const st = new ProgramStatusStore();
    st.apply(WS, SF, { event: 'report', records: [{ state: 'weird' }] }, 1);
    expect(st.get(WS, SF)).toEqual([]);
    st.markUnknown();
    expect(st.get(WS, SF)).toBeNull();
    st.markComplete();
    expect(st.get(WS, SF)).toEqual([]);
  });
});

describe('status pills', () => {
  it('parses the real set_status command line', () => {
    const p = parseStatusCommand({ command: 'set_status', args: `claude_code Needs input --icon=bell.fill --color=#4C8DFF --tab=${WS} --panel=${SF}` });
    expect(p).toEqual({ op: 'set', workspaceId: WS, surfaceId: SF, key: 'claude_code', value: 'Needs input', color: '#4C8DFF' });
    expect(parseStatusCommand({ command: 'clear_status', args: `build --tab=${WS}` })?.op).toBe('clear');
    expect(parseStatusCommand({ command: 'log', args: 'x' })).toBeNull();
    expect(tokenize(`a "b c" 'd e'`)).toEqual(['a', 'b c', 'd e']);
  });
});

describe('summaries', () => {
  const workspace = { id: WS } as Workspace;
  it('never claims task completion — only turn completion', () => {
    expect(describeAgent(agent({ state: 'idle', turnsCompleted: 2 }), 0)).toBe('Claude Code finished its turn · idle');
    expect(describeAgent(agent({ state: 'working', lastHook: { name: 'PreToolUse', toolName: 'Bash', at: 100 } }), 200)).toBe('Claude Code is working · last tool: Bash');
    expect(describeAgent(agent({ state: 'working', lastHook: { name: 'PreToolUse', toolName: 'Bash', at: 0 } }), 10 * 60_000)).toBe('Claude Code is working');
  });

  it('reports a quiet workspace honestly', () => {
    const s = deterministicSummarizer.summarizeWorkspace({ workspace, surfaces: [], agents: [], attention: [], latestActivity: null, now: 0 });
    expect(s).toMatchObject({ health: 'quiet', headline: 'No reported activity', headlineSource: 'none', lastActivityAt: null });
  });
});

describe('request validation', () => {
  it('only accepts allowlisted navigation shapes with cmux UUIDs', () => {
    expect(NavigateSchema.safeParse({ kind: 'workspace', workspaceId: WS }).success).toBe(true);
    expect(NavigateSchema.safeParse({ kind: 'surface', workspaceId: WS, surfaceId: SF }).success).toBe(true);
    expect(NavigateSchema.safeParse({ kind: 'surface', workspaceId: WS }).success).toBe(false);
    expect(NavigateSchema.safeParse({ kind: 'workspace', workspaceId: 'workspace:1' }).success).toBe(false);
    expect(NavigateSchema.safeParse({ kind: 'workspace', workspaceId: WS, command: 'rm -rf /' }).success).toBe(false);
    expect(NavigateSchema.safeParse({ kind: 'send', workspaceId: WS }).success).toBe(false);
  });

  it('validates activity queries and settings', () => {
    expect(ActivityQuerySchema.safeParse({ limit: '50', kind: 'agent.*' }).success).toBe(true);
    expect(ActivityQuerySchema.safeParse({ kind: "x'; drop table" }).success).toBe(false);
    expect(ActivityQuerySchema.safeParse({ limit: '100000' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ showPromptPreviews: 'yes' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ other: true }).success).toBe(false);
  });
});

describe('logger', () => {
  it('redacts prompt, tool input, body and secrets', () => {
    expect(redact({ prompt: 'secret plan', tool_input: { command: 'cat .env' }, body: 'x', password: 'p', ok: 1, nested: { message: 'm' } })).toEqual({
      prompt: '[redacted]',
      tool_input: '[redacted]',
      body: '[redacted]',
      password: '[redacted]',
      ok: 1,
      nested: { message: '[redacted]' },
    });
    const lines: string[] = [];
    createLogger('t', { sink: (l) => lines.push(l), level: 'info' }).info('hello', { text: 'private' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: 'hello', text: '[redacted]', component: 't' });
  });
});
