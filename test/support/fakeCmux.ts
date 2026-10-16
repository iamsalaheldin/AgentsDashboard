// A fake cmux control socket that speaks the protocol verified against cmux 0.65.2:
// v2 JSON-line RPC (one request per connection) and `events.stream` with ack/replay/
// heartbeats/boot ids. Used ONLY by tests and the Playwright preview.
import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

export interface FakeSurface {
  id: string;
  type: string;
  title: string;
  url?: string | null;
}
export interface FakePane {
  id: string;
  surfaces: FakeSurface[];
  selected?: string;
}
export interface FakeWorkspace {
  id: string;
  title: string;
  cwd?: string;
  branch?: string | null;
  panes: FakePane[];
  prompt?: string | null;
  unread?: number;
}
export interface FakeWindow {
  id: string;
  workspaces: FakeWorkspace[];
  selected?: string;
}
export interface FakeAgent {
  kind: string;
  sessionId: string;
  surfaceId: string;
  workspaceId: string;
  state: string;
}
export interface FakeFeedItem {
  id: string;
  kind: string;
  status: string;
  source: string;
  workstreamId: string;
  requestId: string | null;
  toolName: string | null;
}
export interface FakeNotification {
  id: string;
  title: string;
  body: string;
  isRead: boolean;
  workspaceId: string;
  surfaceId: string | null;
}

export const uuid = () => randomUUID().toUpperCase();
export const workstreamId = (source: string, sessionId: string) =>
  `cmux-feed-v1:${Buffer.from(source).toString('base64')}:${Buffer.from(sessionId).toString('base64')}`;

interface StoredEvent {
  seq: number;
  frame: Record<string, unknown>;
}

export interface FakeCmuxOptions {
  socketPath: string;
  heartbeatSeconds?: number;
  bufferLimit?: number;
}

export class FakeCmux {
  readonly socketPath: string;
  windows: FakeWindow[] = [];
  agents: FakeAgent[] = [];
  feed: FakeFeedItem[] = [];
  notifications: FakeNotification[] = [];
  calls: { method: string; params: Record<string, unknown> }[] = [];
  accessDenied = false;
  /** When set, streams stop sending heartbeats (simulates a stalled stream). */
  muteHeartbeats = false;
  /** When set, a stream is ended after this many replayed events (as cmux does on big bursts). */
  cutReplayAfter: number | null = null;
  bootId = uuid();
  private seq = 0;
  private buffer: StoredEvent[] = [];
  private readonly bufferLimit: number;
  private readonly heartbeatSeconds: number;
  private server: Server | null = null;
  private readonly streams = new Set<Socket>();
  private readonly sockets = new Set<Socket>();
  private hbTimer: NodeJS.Timeout | null = null;

  constructor(opts: FakeCmuxOptions) {
    this.socketPath = opts.socketPath;
    this.heartbeatSeconds = opts.heartbeatSeconds ?? 15;
    this.bufferLimit = opts.bufferLimit ?? 4096;
  }

  async start(): Promise<void> {
    rmSync(this.socketPath, { force: true });
    this.server = createServer((sock) => this.onConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    this.hbTimer = setInterval(() => this.heartbeat(), this.heartbeatSeconds * 1000);
  }

  async stop(): Promise<void> {
    if (this.hbTimer) clearInterval(this.hbTimer);
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.streams.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    rmSync(this.socketPath, { force: true });
  }

  /** Simulates quitting and relaunching cmux: new boot id, sequence restarts at 1. */
  async restart(): Promise<void> {
    await this.stop();
    this.bootId = uuid();
    this.seq = 0;
    this.buffer = [];
    await this.start();
  }

  /** Drops every live event-stream connection without restarting. */
  dropStreams(): void {
    for (const s of this.streams) s.destroy();
    this.streams.clear();
  }

  get latestSeq(): number {
    return this.seq;
  }

  // ── topology helpers ───────────────────────────────────────────────────────

  allWorkspaces(): FakeWorkspace[] {
    return this.windows.flatMap((w) => w.workspaces);
  }

  addWorkspace(windowId: string, ws: FakeWorkspace, emit = true): void {
    const win = this.windows.find((w) => w.id === windowId)!;
    win.workspaces.push(ws);
    if (emit) {
      this.emit('workspace.created', 'workspace', { workspace_id: ws.id, title: ws.title, custom_title: null, tab_count: 1 }, { workspace_id: ws.id }, 'workspace.lifecycle');
      for (const p of ws.panes)
        for (const s of p.surfaces) this.emit('surface.created', 'surface', { kind: s.type, pane_id: p.id, surface_id: s.id }, { workspace_id: ws.id, surface_id: s.id, pane_id: p.id }, 'workspace.lifecycle');
    }
  }

  closeWorkspace(workspaceId: string): void {
    for (const w of this.windows) {
      const ws = w.workspaces.find((x) => x.id === workspaceId);
      if (!ws) continue;
      w.workspaces = w.workspaces.filter((x) => x.id !== workspaceId);
      this.agents = this.agents.filter((a) => a.workspaceId !== workspaceId);
      this.emit('workspace.closed', 'workspace', { workspace_id: workspaceId, title: ws.title, tab_count: 0 }, { workspace_id: workspaceId }, 'workspace.lifecycle');
    }
  }

  moveSurface(surfaceId: string, toWorkspaceId: string, toPaneId: string): void {
    let moved: FakeSurface | undefined;
    let fromWs: string | undefined;
    for (const ws of this.allWorkspaces())
      for (const p of ws.panes) {
        const i = p.surfaces.findIndex((s) => s.id === surfaceId);
        if (i >= 0) {
          moved = p.surfaces.splice(i, 1)[0];
          fromWs = ws.id;
        }
      }
    if (!moved) throw new Error('no such surface');
    const target = this.allWorkspaces().find((w) => w.id === toWorkspaceId)!.panes.find((p) => p.id === toPaneId)!;
    target.surfaces.push(moved);
    for (const a of this.agents) if (a.surfaceId === surfaceId) a.workspaceId = toWorkspaceId;
    this.emit('program_status.changed', 'terminal', { event: 'removed', id: null, record: null, records: [], records_total: 0, snapshot_count: 1, snapshot_index: 0, snapshot_id: uuid() }, { workspace_id: fromWs!, surface_id: surfaceId }, 'terminal.program_status');
    this.emit('surface.moved', 'surface', { kind: moved.type, surface_id: surfaceId, pane_id: toPaneId }, { workspace_id: toWorkspaceId, surface_id: surfaceId, pane_id: toPaneId }, 'workspace.lifecycle');
  }

  // ── agent helpers (mirror the event sequence captured from real cmux) ──────

  hook(kind: string, sessionId: string, hookName: string, ids: { workspaceId: string; surfaceId: string }, extra: Record<string, unknown> = {}): void {
    const payload = {
      _source: kind,
      hook_event_name: hookName,
      session_id: workstreamId(kind, sessionId),
      surface_id: ids.surfaceId,
      workspace_id: ids.workspaceId,
      tool_name: null,
      redacted_fields: ['extra_fields'],
      ...extra,
    };
    const env = { workspace_id: ids.workspaceId, surface_id: ids.surfaceId };
    this.emit(`agent.hook.${hookName}`, 'agent', { ...payload, phase: 'received' }, env, kind);
    this.emit('feed.item.received', 'feed', { ...payload, phase: 'received' }, env, kind);
    if (hookName !== 'PermissionRequest') {
      this.emit(`agent.hook.${hookName}`, 'agent', { ...payload, phase: 'completed', result: { status: 'acknowledged' } }, env, kind);
      this.emit('feed.item.completed', 'feed', { ...payload, phase: 'completed', result: { status: 'acknowledged' } }, env, kind);
    }
  }

  setAgent(agent: FakeAgent): void {
    const existing = this.agents.find((a) => a.kind === agent.kind && a.sessionId === agent.sessionId);
    if (existing) Object.assign(existing, agent);
    else this.agents.push(agent);
  }

  requestPermission(agent: FakeAgent, toolName: string): FakeFeedItem {
    const requestId = uuid();
    const item: FakeFeedItem = {
      id: uuid(),
      kind: 'permissionRequest',
      status: 'pending',
      source: agent.kind,
      workstreamId: workstreamId(agent.kind, agent.sessionId),
      requestId,
      toolName,
    };
    this.feed.push(item);
    this.setAgent({ ...agent, state: 'needs_input' });
    this.hook(agent.kind, agent.sessionId, 'PermissionRequest', agent, { tool_name: toolName, _opencode_request_id: requestId, tool_input: null });
    return item;
  }

  resolvePermission(item: FakeFeedItem, agent: FakeAgent, decision = 'allow'): void {
    item.status = 'resolved';
    this.setAgent({ ...agent, state: 'working' });
    this.emit(
      'feed.item.completed',
      'feed',
      { _source: agent.kind, hook_event_name: 'PermissionRequest', session_id: item.workstreamId, _opencode_request_id: item.requestId, phase: 'completed', result: { decision } },
      { workspace_id: agent.workspaceId, surface_id: agent.surfaceId },
      agent.kind,
    );
  }

  programStatus(workspaceId: string, surfaceId: string, state: string): void {
    const record = { id: '', kind: 'none', progress: null, state, updated_seq: this.seq + 1 };
    this.emit('program_status.changed', 'terminal', { event: 'report', id: null, record, records: [record], records_total: 1, snapshot_count: 1, snapshot_index: 0, snapshot_id: uuid() }, { workspace_id: workspaceId, surface_id: surfaceId }, 'terminal.program_status');
  }

  // ── events ─────────────────────────────────────────────────────────────────

  emit(name: string, category: string, payload: Record<string, unknown>, env: { workspace_id?: string; surface_id?: string; pane_id?: string; window_id?: string } = {}, source = 'test'): number {
    const seq = ++this.seq;
    const frame = {
      type: 'event',
      protocol: 'cmux-events',
      version: 1,
      boot_id: this.bootId,
      seq,
      id: `${this.bootId}-${seq}`,
      name,
      category,
      source,
      occurred_at: new Date().toISOString(),
      workspace_id: env.workspace_id ?? null,
      surface_id: env.surface_id ?? null,
      pane_id: env.pane_id ?? null,
      window_id: env.window_id ?? null,
      payload,
    };
    this.buffer.push({ seq, frame });
    if (this.buffer.length > this.bufferLimit) this.buffer.shift();
    const line = JSON.stringify(frame) + '\n';
    for (const s of this.streams) s.write(line);
    return seq;
  }

  /** Put events from an earlier cmux process into the replay buffer, as real cmux does. */
  seedPriorBootHistory(count: number): string {
    const oldBoot = uuid();
    for (let i = 0; i < count; i++) {
      const seq = ++this.seq;
      this.buffer.push({
        seq,
        frame: { type: 'event', protocol: 'cmux-events', version: 1, boot_id: oldBoot, seq, id: `${oldBoot}-${seq}`, name: 'workspace.closed', category: 'workspace', source: 'workspace.lifecycle', occurred_at: new Date(Date.now() - 3_600_000).toISOString(), workspace_id: uuid(), surface_id: null, pane_id: null, window_id: null, payload: { title: `old-${i}` } },
      });
    }
    return oldBoot;
  }

  /** Re-send an already-delivered event (duplicate delivery). */
  redeliver(seq: number): void {
    const e = this.buffer.find((b) => b.seq === seq);
    if (!e) return;
    for (const s of this.streams) s.write(JSON.stringify(e.frame) + '\n');
  }

  private heartbeat(): void {
    if (this.muteHeartbeats) return;
    const line = JSON.stringify({ type: 'heartbeat', protocol: 'cmux-events', version: 1, boot_id: this.bootId, latest_seq: this.seq, occurred_at: new Date().toISOString() }) + '\n';
    for (const s of this.streams) s.write(line);
  }

  // ── socket protocol ────────────────────────────────────────────────────────

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('close', () => {
      this.sockets.delete(sock);
      this.streams.delete(sock);
    });
    sock.on('error', () => {});
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0 || this.streams.has(sock)) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (this.accessDenied) {
        sock.end('ERROR: Access denied - only processes started inside cmux can connect\n');
        return;
      }
      let req: { id?: string; method?: string; params?: Record<string, unknown> };
      try {
        req = JSON.parse(line);
      } catch {
        sock.end(JSON.stringify({ ok: false, error: { code: 'parse_error', message: 'invalid json' } }) + '\n');
        return;
      }
      const method = req.method ?? '';
      const params = req.params ?? {};
      if (method === 'events.stream') {
        this.startStream(sock, params);
        return;
      }
      this.calls.push({ method, params });
      try {
        const result = this.handle(method, params);
        sock.end(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
      } catch (err) {
        sock.end(JSON.stringify({ id: req.id, ok: false, error: { code: (err as { code?: string }).code ?? 'method_not_found', message: (err as Error).message } }) + '\n');
      }
    });
  }

  private startStream(sock: Socket, params: Record<string, unknown>): void {
    this.streams.add(sock);
    const after = typeof params.after_seq === 'number' ? params.after_seq : this.seq;
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    const gap = after > this.seq || (after < oldest - 1 && after !== 0) || (after === 0 && oldest > 1);
    const replay = this.buffer.filter((b) => b.seq > after);
    sock.write(
      JSON.stringify({
        type: 'ack',
        protocol: 'cmux-events',
        version: 1,
        boot_id: this.bootId,
        subscription_id: uuid(),
        heartbeat_interval_seconds: this.heartbeatSeconds,
        replay_count: replay.length,
        resume: { after_seq: after, requested_after_seq: after, oldest_seq: oldest, latest_seq: this.seq, next_seq: this.seq + 1, gap, restore_gap: false },
        filters: { names: [], categories: [] },
      }) + '\n',
    );
    const cut = this.cutReplayAfter;
    const sent = cut !== null && replay.length > cut ? replay.slice(0, cut) : replay;
    for (const r of sent) sock.write(JSON.stringify(r.frame) + '\n');
    if (sent.length < replay.length) {
      this.streams.delete(sock);
      sock.end();
    }
  }

  private handle(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'system.ping':
        return { pong: true };
      case 'system.capabilities':
        return { access_mode: 'cmuxOnly', protocol: 'cmux-socket', version: 2, methods: ['system.tree', 'current.list', 'events.stream'], capabilities: ['events.v1'] };
      case 'system.identify':
        return { app: 'cmux', version: '0.65.2-fake', build: '0' };
      case 'system.tree':
        // Like cmux 0.65.2: only the focused (first) window unless all_windows is set.
        return params.all_windows === true ? this.tree() : { ...this.tree(), windows: this.tree().windows.slice(0, 1) };
      case 'extension.sidebar.snapshot':
        return this.sidebar(params.window_id as string | undefined);
      case 'current.list':
        return this.current();
      case 'feed.list':
        return {
          items: this.feed.map((f) => ({ id: f.id, kind: f.kind, status: f.status, source: f.source, workstream_id: f.workstreamId, request_id: f.requestId, tool_name: f.toolName, title: f.toolName, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })),
        };
      case 'notification.list':
        return {
          notifications: this.notifications.map((n) => ({ id: n.id, title: n.title, subtitle: '', body: n.body, is_read: n.isRead, created_at: new Date().toISOString(), workspace_id: n.workspaceId, surface_id: n.surfaceId })),
        };
      case 'window.focus':
        return { window_id: params.window_id };
      case 'workspace.select': {
        const ws = this.allWorkspaces().find((w) => w.id === params.workspace_id);
        if (!ws) throw Object.assign(new Error('workspace not found'), { code: 'not_found' });
        for (const win of this.windows) if (win.workspaces.includes(ws)) win.selected = ws.id;
        this.emit('workspace.selected', 'workspace', { workspace_id: ws.id, title: ws.title }, { workspace_id: ws.id }, 'workspace.lifecycle');
        return { workspace_id: ws.id };
      }
      case 'surface.focus':
        return { surface_id: params.surface_id };
      default:
        throw Object.assign(new Error('Unknown method'), { code: 'method_not_found' });
    }
  }

  private tree() {
    return {
      active: null,
      caller: null,
      windows: this.windows.map((w, wi) => ({
        id: w.id,
        ref: `window:${wi + 1}`,
        index: wi,
        key: wi === 0,
        visible: true,
        selected_workspace_id: w.selected ?? w.workspaces[0]?.id ?? null,
        workspace_count: w.workspaces.length,
        workspaces: w.workspaces.map((ws, i) => ({
          id: ws.id,
          ref: `workspace:${i + 1}`,
          index: i,
          title: ws.title,
          description: null,
          pinned: false,
          selected: (w.selected ?? w.workspaces[0]?.id) === ws.id,
          panes: ws.panes.map((p, pi) => ({
            id: p.id,
            ref: `pane:${pi + 1}`,
            index: pi,
            focused: pi === 0,
            selected_surface_id: p.selected ?? p.surfaces[0]?.id ?? null,
            surface_count: p.surfaces.length,
            surface_ids: p.surfaces.map((s) => s.id),
            surfaces: p.surfaces.map((s, si) => ({
              id: s.id,
              ref: `surface:${si + 1}`,
              index: si,
              index_in_pane: si,
              pane_id: p.id,
              title: s.title,
              type: s.type,
              url: s.url ?? null,
              tty: s.type === 'terminal' ? `ttys00${si}` : null,
              focused: si === 0,
              selected_in_pane: (p.selected ?? p.surfaces[0]?.id) === s.id,
              render_health: 'rendering',
            })),
          })),
        })),
      })),
    };
  }

  private sidebar(windowId?: string) {
    const win = (windowId && this.windows.find((w) => w.id === windowId)) || this.windows[0];
    return {
      seq: this.seq,
      window_id: win?.id ?? null,
      selected_workspace_id: win?.selected ?? win?.workspaces[0]?.id ?? null,
      workspaces: (win?.workspaces ?? []).map((ws) => ({
        id: ws.id,
        title: ws.title,
        current_directory: ws.cwd ?? '/Users/dev',
        root_path: ws.cwd ?? '/Users/dev',
        project_root_path: ws.branch ? ws.cwd ?? null : null,
        git_branches: ws.branch ? [{ branch: ws.branch, is_dirty: false, directory: ws.cwd }] : [],
        branch_summary: null,
        pull_request_urls: [],
        listening_ports: [],
        unread_count: ws.unread ?? 0,
        latest_submitted_message: ws.prompt ?? null,
        latest_submitted_at: ws.prompt ? new Date().toISOString() : null,
      })),
    };
  }

  private current() {
    const items = [];
    for (const ws of this.allWorkspaces())
      for (const p of ws.panes)
        for (const s of p.surfaces) {
          const agents = this.agents.filter((a) => a.surfaceId === s.id);
          items.push({
            kind: s.type,
            label: s.title,
            lifecycle: 'running',
            resource_ref: `local/${s.type}/${s.id}`,
            agents: agents.map((a, i) => ({ kind: a.kind, session_id: a.sessionId, state: a.state, last_activity_at: new Date().toISOString(), has_hook_lifecycle_state: true, version: i + 1 })),
            attention: agents.filter((a) => a.state === 'needs_input').map(() => ({ kind: 'needs_input', scope: 'agent' })),
            projections: [{ panel_id: s.id, workspace_id: ws.id }],
          });
        }
    return { authority: 'read_only_projection', items };
  }
}

/** A small, realistic two-window topology used by integration and UI tests. */
export function seedDemo(fake: FakeCmux) {
  const ids = {
    win1: uuid(),
    win2: uuid(),
    wsApi: uuid(),
    wsWeb: uuid(),
    wsOps: uuid(),
    paneApi1: uuid(),
    paneApi2: uuid(),
    paneWeb: uuid(),
    paneOps: uuid(),
    sClaude: uuid(),
    sTests: uuid(),
    sBrowser: uuid(),
    sCodex: uuid(),
    sShell: uuid(),
  };
  fake.windows = [
    {
      id: ids.win1,
      workspaces: [
        {
          id: ids.wsApi,
          title: 'billing-api',
          cwd: '/Users/dev/src/billing-api',
          branch: 'feature/invoices',
          prompt: 'Add pagination to the invoices endpoint',
          panes: [
            { id: ids.paneApi1, surfaces: [{ id: ids.sClaude, type: 'terminal', title: 'claude' }, { id: ids.sTests, type: 'terminal', title: 'npm test' }] },
            { id: ids.paneApi2, surfaces: [{ id: ids.sBrowser, type: 'browser', title: 'localhost:3000', url: 'http://localhost:3000' }] },
          ],
        },
        { id: ids.wsWeb, title: 'web-app', cwd: '/Users/dev/src/web-app', branch: 'main', panes: [{ id: ids.paneWeb, surfaces: [{ id: ids.sCodex, type: 'terminal', title: 'codex' }] }] },
      ],
    },
    { id: ids.win2, workspaces: [{ id: ids.wsOps, title: 'ops', cwd: '/Users/dev', branch: null, panes: [{ id: ids.paneOps, surfaces: [{ id: ids.sShell, type: 'terminal', title: 'zsh' }] }] }] },
  ];
  const claude: FakeAgent = { kind: 'claude', sessionId: 'sess-claude-1', surfaceId: ids.sClaude, workspaceId: ids.wsApi, state: 'working' };
  const codex: FakeAgent = { kind: 'codex', sessionId: 'sess-codex-1', surfaceId: ids.sCodex, workspaceId: ids.wsWeb, state: 'idle' };
  fake.agents = [claude, codex];
  return { ids, claude, codex };
}
