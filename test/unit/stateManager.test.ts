import { describe, expect, it } from 'vitest';
import type { ConnectionStatus } from '../../shared/types.ts';
import type { CmuxSnapshot, SnapshotGroup } from '../../server/src/cmux/adapter.ts';
import {
  CurrentListSchema,
  FeedListSchema,
  NotificationListSchema,
  SidebarSnapshotSchema,
  SystemTreeSchema,
  type RawEvent,
} from '../../server/src/cmux/schemas.ts';
import { StateManager } from '../../server/src/domain/stateManager.ts';
import { fixture, fixtureEvents } from '../support/helpers.ts';

const connection: ConnectionStatus = {
  phase: 'live',
  problem: null,
  message: null,
  socketPath: '/tmp/x.sock',
  cmuxVersion: null,
  accessMode: null,
  bootId: null,
  lastSeq: null,
  lastFrameAt: null,
  lastSnapshotAt: null,
  stale: false,
  gapDetectedAt: null,
  reconnectAttempt: 0,
  insideCmux: true,
};

const groups = (...g: SnapshotGroup[]) => new Set<SnapshotGroup>(g);

function realSnapshot(currentFixture: string, takenAt: number, withPendingFeed = false): CmuxSnapshot {
  return {
    takenAt,
    groups: groups('topology', 'agents', 'notifications'),
    tree: SystemTreeSchema.parse(fixture('system-tree.json')),
    sidebar: SidebarSnapshotSchema.parse(fixture('sidebar-snapshot.json')).workspaces,
    current: CurrentListSchema.parse(fixture(currentFixture)),
    feed: withPendingFeed ? FeedListSchema.parse(fixture('feed-list-pending.json')).items : [],
    notifications: NotificationListSchema.parse({ notifications: [] }).notifications,
    partialErrors: {},
  };
}

const newManager = (showPromptPreviews = false) =>
  new StateManager({ selfSurfaceId: null, settings: { showPromptPreviews }, connection });

describe('StateManager with real cmux captures', () => {
  it('builds the window → workspace → pane → surface hierarchy', () => {
    const sm = newManager();
    sm.applySnapshot(realSnapshot('current-list-idle.json', Date.now()));
    const s = sm.build();
    expect(s.windowOrder).toHaveLength(1);
    expect(Object.keys(s.workspaces)).toHaveLength(2);
    for (const ws of Object.values(s.workspaces)) {
      expect(ws.paneIds.length).toBeGreaterThan(0);
      for (const pid of ws.paneIds) {
        const pane = s.panes[pid]!;
        expect(pane.workspaceId).toBe(ws.id);
        for (const sid of pane.surfaceIds) expect(s.surfaces[sid]?.paneId).toBe(pid);
      }
    }
    expect(s.kpis.workspaces).toBe(2);
    expect(s.kpis.surfaces).toBe(2);
  });

  it('hides prompt text unless previews are enabled', () => {
    const off = newManager(false);
    off.applySnapshot(realSnapshot('current-list-idle.json', Date.now()));
    expect(Object.values(off.build().workspaces).every((w) => w.latestPrompt === null)).toBe(true);
    const on = newManager(true);
    const snap = realSnapshot('current-list-idle.json', Date.now());
    // The sidebar capture with a prompt came from a different probe workspace; align ids.
    const treeWs = snap.tree!.windows[0]!.workspaces[0]!.id;
    const withPrompt = snap.sidebar!.find((w) => w.latest_submitted_message)!;
    snap.sidebar = [{ ...withPrompt, id: treeWs }];
    on.applySnapshot(snap);
    expect(Object.values(on.build().workspaces).some((w) => w.latestPrompt?.text === 'Probe prompt: list files')).toBe(true);
  });

  it('turns the real Claude session into a correlated permission attention item', () => {
    const sm = newManager();
    const events = fixtureEvents('events-claude-session.jsonl');
    // Events up to (and including) the PermissionRequest, then a snapshot taken afterwards.
    const permIdx = events.findIndex((e) => e.name === 'agent.hook.PermissionRequest');
    for (const ev of events.slice(0, permIdx + 2)) sm.applyEvent(ev, { replay: false });
    sm.applySnapshot(realSnapshot('current-list-permission.json', Date.now() + 1000, true));
    const s = sm.build();
    const agent = Object.values(s.agents)[0]!;
    expect(agent).toMatchObject({ kind: 'claude', sessionId: 'mc-probe-58287', state: 'needs_attention', displayName: 'Claude Code' });
    expect(agent.pendingPermission?.toolName).toBe('Bash');
    expect(s.attention).toHaveLength(1); // feed permission + registry needs_input deduplicated
    expect(s.attention[0]).toMatchObject({ kind: 'permission', surfaceId: agent.surfaceId, title: 'Permission request: Bash' });
    expect(s.kpis.agentsNeedingAttention).toBe(1);
  });

  it('maps the full captured lifecycle: working → idle (turn) → ended', () => {
    const sm = newManager();
    const events = fixtureEvents('events-claude-session.jsonl');
    const kinds: string[] = [];
    for (const ev of events) {
      const out = sm.applyEvent(ev, { replay: false });
      if (out.activity) kinds.push(out.activity.kind);
    }
    expect(kinds).toEqual([
      'agent.session_started',
      'agent.turn_started',
      'agent.permission_requested',
      'agent.needs_input',
      'agent.turn_completed',
      'program.error',
      'notification.created',
      'agent.session_ended',
    ]);
    const agent = Object.values(sm.build().agents)[0]!;
    expect(agent.state).toBe('ended');
    expect(agent.turnsCompleted).toBe(1);
  });

  it('lets a later current.list snapshot override an earlier hook overlay', () => {
    const sm = newManager();
    const events = fixtureEvents('events-claude-session.jsonl');
    const prompt = events.find((e) => e.name === 'agent.hook.UserPromptSubmit')!;
    sm.applyEvent(prompt, { replay: false });
    expect(Object.values(sm.build().agents)[0]?.state).toBe('working');
    sm.applySnapshot(realSnapshot('current-list-idle.json', Date.parse(prompt.occurred_at) + 5000));
    const a = Object.values(sm.build().agents)[0]!;
    expect(a.state).toBe('idle');
    expect(a.stateSource).toBe('cmux-registry');
  });

  it('does not apply optimistic state from replayed history', () => {
    const sm = newManager();
    const prompt = fixtureEvents('events-claude-session.jsonl').find((e) => e.name === 'agent.hook.UserPromptSubmit')!;
    const out = sm.applyEvent(prompt, { replay: true });
    expect(out.activity?.kind).toBe('agent.turn_started'); // still recorded in the timeline
    expect(Object.keys(sm.build().agents)).toHaveLength(0);
  });

  it('records program-status errors as attention until removed', () => {
    const sm = newManager();
    sm.applySnapshot(realSnapshot('current-list-idle.json', Date.now()));
    const s0 = sm.build();
    const surface = Object.values(s0.surfaces)[0]!;
    const ev = (event: string, state: string | null, seq: number): RawEvent => ({
      type: 'event',
      boot_id: 'b',
      seq,
      id: `b-${seq}`,
      name: 'program_status.changed',
      category: 'terminal',
      source: 'terminal.program_status',
      occurred_at: new Date().toISOString(),
      workspace_id: surface.workspaceId,
      surface_id: surface.id,
      pane_id: null,
      window_id: null,
      payload: {
        event,
        record: state ? { id: '', state, kind: 'none', progress: null } : null,
        records: state ? [{ id: '', state, kind: 'none', progress: null }] : [],
        snapshot_count: 1,
        snapshot_index: 0,
        snapshot_id: `s${seq}`,
      },
    });
    sm.applyEvent(ev('report', 'error', 1), { replay: false });
    let s = sm.build();
    expect(s.attention.map((a) => a.kind)).toEqual(['program_error']);
    expect(s.kpis.workspacesWithErrors).toBe(1);
    expect(s.summaries[surface.workspaceId]?.health).toBe('error');
    sm.applyEvent(ev('dismissed', null, 2), { replay: false });
    s = sm.build();
    expect(s.attention).toHaveLength(0);
    sm.markGap();
    expect(sm.build().surfaces[surface.id]?.programStatus).toBeNull(); // unknown after a gap
  });

  it('treats a Codex PermissionRequest hook as telemetry, not as waiting on the user', () => {
    const sm = newManager();
    const ws = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
    const sf = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';
    const sid = `cmux-feed-v1:${Buffer.from('codex').toString('base64')}:${Buffer.from('c1').toString('base64')}`;
    const hook = (name: string, seq: number): RawEvent => ({
      type: 'event', boot_id: 'b', seq, id: `b-${seq}`, name: `agent.hook.${name}`, category: 'agent', source: 'codex',
      occurred_at: new Date().toISOString(), workspace_id: ws, surface_id: sf, pane_id: null, window_id: null,
      payload: { hook_event_name: name, session_id: sid, phase: 'received', tool_name: 'shell' },
    });
    sm.applyEvent(hook('UserPromptSubmit', 1), { replay: false });
    const out = sm.applyEvent(hook('PermissionRequest', 2), { replay: false });
    expect(out.activity?.severity).toBe('info');
    const a = sm.build().agents['codex:c1']!;
    expect(a.state).toBe('working');
    expect(a.displayName).toBe('Codex');
  });

  it('maps unknown registry states to unknown and keeps the source state', () => {
    const sm = newManager();
    const snap = realSnapshot('current-list-idle.json', Date.now());
    snap.current!.items.find((i) => i.agents.length)!.agents[0]!.state = 'hibernated';
    sm.applySnapshot(snap);
    const a = Object.values(sm.build().agents)[0]!;
    expect(a).toMatchObject({ state: 'unknown', sourceState: 'hibernated' });
  });

  it('parses sidebar status pills from set_status events', () => {
    const sm = newManager();
    sm.applySnapshot(realSnapshot('current-list-idle.json', Date.now()));
    const pillEvent = fixtureEvents('events-claude-session.jsonl').find((e) => e.name === 'sidebar.metadata.updated')!;
    // Point the pill at a workspace present in the tree fixture.
    const wsId = Object.keys(sm.build().workspaces)[0]!;
    pillEvent.payload = { ...pillEvent.payload, args: String(pillEvent.payload!.args).replace(/--tab=\S+/, `--tab=${wsId}`) };
    sm.applyEvent(pillEvent, { replay: false });
    expect(sm.build().workspaces[wsId]?.statusPills[0]).toMatchObject({ key: 'claude_code', value: 'Idle', color: '#8E8E93' });
  });
});
