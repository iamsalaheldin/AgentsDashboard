// Single source of truth for normalized Mission Control state.
//
// Inputs: cmux snapshots (authoritative) and cmux events (low latency + timeline).
// Hook events produce short-lived "overlays" on agent state that are superseded as soon as
// a `current.list` snapshot taken after the hook arrives.
import type {
  ActivityEntry,
  ActivityKind,
  ActivitySeverity,
  AgentSession,
  AgentState,
  ConnectionStatus,
  MissionState,
  Settings,
  StatusPill,
  Surface,
} from '../../../shared/types.ts';
import type { CmuxSnapshot, SnapshotGroup } from '../cmux/adapter.ts';
import type { RawCurrent, RawEvent, RawFeedItem, RawNotification, RawSidebar, RawTree } from '../cmux/schemas.ts';
import { agentDefinition, agentKey, decodeWorkstreamId, normalizeRegistryState } from './agents/index.ts';
import { buildAttention, feedKind, type PendingFeedItem } from './attention.ts';
import { normalizeTopology, type Topology } from './normalize.ts';
import { ProgramStatusStore } from './programStatus.ts';
import { parseStatusCommand } from './statusPills.ts';
import { computeKpis, deterministicSummarizer, type Summarizer } from './summarize.ts';

interface RegistryAgent {
  key: string;
  kind: string;
  sessionId: string;
  state: string;
  lastActivityAt: number | null;
  workspaceId: string | null;
  surfaceId: string | null;
}

interface Overlay {
  key: string;
  kind: string;
  sessionId: string;
  state: AgentState;
  sourceState: string;
  at: number;
  workspaceId: string | null;
  surfaceId: string | null;
}

interface Located {
  workspaceId: string | null;
  surfaceId: string | null;
  agentKey: string | null;
  agentKind: string | null;
}

export interface EventOutcome {
  activity: ActivityEntry | null;
  refresh: Set<SnapshotGroup>;
}

export interface StateManagerOptions {
  selfSurfaceId: string | null;
  settings: Settings;
  connection: ConnectionStatus;
  fixtureMode?: boolean;
  summarizer?: Summarizer;
  now?: () => number;
}

const MAX_CORRELATIONS = 2000;
const parseTime = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

export class StateManager {
  private readonly now: () => number;
  private readonly summarizer: Summarizer;
  private readonly selfSurfaceId: string | null;
  private readonly fixtureMode: boolean;
  private settings: Settings;
  private connection: ConnectionStatus;
  private capabilities: MissionState['capabilities'] = null;

  // Last raw snapshot pieces (kept so a settings change can re-normalize without cmux).
  private rawTree: RawTree | null = null;
  private rawSidebar: RawSidebar['workspaces'] | null = null;
  private topology: Topology = { windows: {}, windowOrder: [], workspaces: {}, panes: {}, surfaces: {} };

  private registry = new Map<string, RegistryAgent>();
  private registryTakenAt = 0;
  private readonly overlays = new Map<string, Overlay>();
  private readonly lastHook = new Map<string, { name: string; toolName: string | null; at: number }>();
  private readonly turns = new Map<string, number>();
  private readonly stateSince = new Map<string, { state: AgentState; since: number }>();
  /** Agents seen only through hooks, kept until a snapshot taken after them disagrees. */
  private readonly hookOnly = new Map<string, Overlay>();

  private feed: RawFeedItem[] = [];
  private readonly feedLocation = new Map<string, { workspaceId: string | null; surfaceId: string | null }>();
  private notifications: RawNotification[] = [];
  readonly programStatus = new ProgramStatusStore();
  private readonly pills = new Map<string, Map<string, StatusPill>>();
  private readonly surfaceActivity = new Map<string, number>();
  private readonly latestByWorkspace = new Map<string, ActivityEntry>();
  private turns24h: number | null = null;

  private version = 0;
  private cached: MissionState | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(opts: StateManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.summarizer = opts.summarizer ?? deterministicSummarizer;
    this.selfSurfaceId = opts.selfSurfaceId;
    this.settings = opts.settings;
    this.connection = opts.connection;
    this.fixtureMode = opts.fixtureMode ?? false;
  }

  // ── subscriptions ──────────────────────────────────────────────────────────

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.version++;
    this.cached = null;
    for (const fn of this.listeners) fn();
  }

  // ── simple setters ─────────────────────────────────────────────────────────

  setConnection(patch: Partial<ConnectionStatus>): void {
    const next = { ...this.connection, ...patch };
    next.stale = next.phase !== 'live';
    if (JSON.stringify(next) === JSON.stringify(this.connection)) return;
    this.connection = next;
    this.changed();
  }

  getConnection(): ConnectionStatus {
    return this.connection;
  }

  setCapabilities(caps: MissionState['capabilities']): void {
    this.capabilities = caps;
    this.changed();
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.renormalize();
    this.changed();
  }

  setTurns24h(n: number | null): void {
    if (n === this.turns24h) return;
    this.turns24h = n;
    this.changed();
  }

  noteActivity(entry: ActivityEntry): void {
    if (!entry.workspaceId) return;
    const prev = this.latestByWorkspace.get(entry.workspaceId);
    if (!prev || prev.at <= entry.at) this.latestByWorkspace.set(entry.workspaceId, entry);
  }

  /** Called when cmux replay could not cover the gap since our cursor, or cmux restarted. */
  markGap(): void {
    this.programStatus.markUnknown();
    this.overlays.clear();
    this.hookOnly.clear();
    this.changed();
  }

  markReplayComplete(fromStart: boolean): void {
    if (fromStart) this.programStatus.markComplete();
  }

  // ── snapshots ──────────────────────────────────────────────────────────────

  applySnapshot(snap: CmuxSnapshot): void {
    if (snap.tree) {
      this.rawTree = snap.tree;
      // Keep the previous sidebar enrichment if this round failed to fetch it.
      if (snap.sidebar) this.rawSidebar = snap.sidebar;
      this.renormalize();
      this.pruneDetached();
    }
    if (snap.groups.has('agents')) {
      if (snap.current) this.applyRegistry(snap.current, snap.takenAt);
      if (snap.feed) this.feed = snap.feed;
    }
    if (snap.groups.has('notifications') && snap.notifications) this.notifications = snap.notifications;
    this.changed();
  }

  private renormalize(): void {
    if (!this.rawTree) return;
    this.topology = normalizeTopology(this.rawTree, this.rawSidebar, {
      showPromptPreviews: this.settings.showPromptPreviews,
      selfSurfaceId: this.selfSurfaceId,
    });
  }

  private pruneDetached(): void {
    const live = new Set(Object.values(this.topology.surfaces).map((s) => `${s.workspaceId}/${s.id}`));
    this.programStatus.retain(live);
    for (const id of this.pills.keys()) if (!this.topology.workspaces[id]) this.pills.delete(id);
    for (const id of this.surfaceActivity.keys()) if (!this.topology.surfaces[id]) this.surfaceActivity.delete(id);
  }

  private applyRegistry(current: RawCurrent, takenAt: number): void {
    const next = new Map<string, RegistryAgent>();
    for (const item of current.items) {
      const proj = item.projections.find((p) => p.panel_id) ?? item.projections[0];
      for (const a of item.agents) {
        const key = agentKey(a.kind, a.session_id);
        next.set(key, {
          key,
          kind: a.kind,
          sessionId: a.session_id,
          state: a.state,
          lastActivityAt: parseTime(a.last_activity_at),
          workspaceId: proj?.workspace_id ?? null,
          surfaceId: proj?.panel_id ?? null,
        });
      }
    }
    this.registry = next;
    this.registryTakenAt = takenAt;
    // Overlays older than this snapshot are superseded by cmux's registry.
    for (const [k, o] of this.overlays) if (o.at <= takenAt) this.overlays.delete(k);
    for (const [k, o] of this.hookOnly) if (o.at <= takenAt || next.has(k)) this.hookOnly.delete(k);
  }

  // ── events ─────────────────────────────────────────────────────────────────

  applyEvent(ev: RawEvent, meta: { replay: boolean }): EventOutcome {
    const refresh = new Set<SnapshotGroup>();
    const at = parseTime(ev.occurred_at) ?? this.now();
    const payload = ev.payload ?? {};
    let activity: ActivityEntry | null = null;
    const touch = (surfaceId: string | null) => {
      if (surfaceId && !meta.replay) this.surfaceActivity.set(surfaceId, Math.max(at, this.surfaceActivity.get(surfaceId) ?? 0));
    };

    const name = ev.name;
    switch (ev.category) {
      case 'window':
      case 'pane':
        refresh.add('topology');
        break;
      case 'workspace': {
        refresh.add('topology');
        // Lifecycle events carry the title at the top level; socket-sourced ones (e.g. a CLI
        // rename) carry it under params/result.
        const nested = (k: string) => {
          const o = payload[k];
          return o && typeof o === 'object' ? str((o as Record<string, unknown>).title) : null;
        };
        const title = str(payload.custom_title) ?? str(payload.title) ?? nested('result') ?? nested('params');
        if (name === 'workspace.created') activity = this.entry(ev, at, 'workspace.created', 'info', `Workspace ${q(title)} opened`, { workspaceTitle: title });
        else if (name === 'workspace.closed') activity = this.entry(ev, at, 'workspace.closed', 'info', `Workspace ${q(title)} closed`, { workspaceTitle: title });
        else if (name === 'workspace.renamed') activity = this.entry(ev, at, 'workspace.renamed', 'info', `Workspace renamed to ${q(title)}`, { workspaceTitle: title });
        else if (name === 'workspace.moved') activity = this.entry(ev, at, 'workspace.moved', 'info', `Workspace ${q(title ?? this.wsTitle(ev.workspace_id))} moved to another window`);
        break;
      }
      case 'surface': {
        refresh.add('topology');
        const kind = str(payload.kind) ?? 'surface';
        const label = kind === 'terminal' ? 'Terminal tab' : kind === 'browser' ? 'Browser tab' : `${kind} tab`;
        if (name === 'surface.created') activity = this.entry(ev, at, 'surface.created', 'info', `${label} opened`);
        else if (name === 'surface.closed') activity = this.entry(ev, at, 'surface.closed', 'info', `${label} closed`);
        else if (name === 'surface.moved') activity = this.entry(ev, at, 'surface.moved', 'info', `${label} moved`);
        if (name === 'surface.created' || name === 'surface.moved') touch(ev.surface_id);
        break;
      }
      case 'agent':
        if (name.startsWith('agent.hook.')) {
          refresh.add('agents');
          activity = this.applyHook(ev, at, payload, meta);
          touch(ev.surface_id);
        }
        break;
      case 'feed':
        this.rememberFeedLocation(ev, payload);
        if (name === 'feed.item.completed' || name === 'feed.item.resolved') {
          refresh.add('agents');
          if (payload.hook_event_name === 'PermissionRequest' || name === 'feed.item.resolved') activity = this.permissionResolved(ev, at, payload);
        } else if (name === 'feed.item.received') {
          refresh.add('agents');
        }
        break;
      case 'notification':
        refresh.add('notifications');
        refresh.add('topology'); // unread counts live on the sidebar snapshot
        if (name === 'notification.created') {
          activity = this.entry(ev, at, 'notification.created', 'info', 'cmux notification posted');
          touch(ev.surface_id);
        }
        break;
      case 'sidebar': {
        const pill = parseStatusCommand(payload);
        if (pill) {
          const map = this.pills.get(pill.workspaceId) ?? new Map<string, StatusPill>();
          if (pill.op === 'set') map.set(pill.key, { key: pill.key, value: pill.value, color: pill.color, updatedAt: at });
          else map.delete(pill.key);
          this.pills.set(pill.workspaceId, map);
          // Agent integrations publish their status pills alongside registry changes.
          if (/claude|codex|agent|opencode|amp|gemini/i.test(pill.key)) refresh.add('agents');
        } else if (name === 'sidebar.reset') {
          refresh.add('topology');
        }
        break;
      }
      case 'terminal':
        if (name === 'program_status.changed') {
          const change = this.programStatus.apply(ev.workspace_id, ev.surface_id, payload, at);
          touch(ev.surface_id);
          const rec = change?.record;
          if (change && change.event === 'report' && rec) {
            if (rec.state === 'error') activity = this.entry(ev, at, 'program.error', 'error', 'Terminal program reported an error');
            else if (rec.state === 'blocked') activity = this.entry(ev, at, 'program.blocked', 'attention', 'Terminal program is blocked');
            else if (rec.state === 'done') activity = this.entry(ev, at, 'program.done', 'success', 'Terminal program reported done');
          }
        }
        break;
      default:
        break;
    }

    if (activity) this.noteActivity(activity);
    this.changed();
    return { activity, refresh };
  }

  private applyHook(ev: RawEvent, at: number, payload: Record<string, unknown>, meta: { replay: boolean }): ActivityEntry | null {
    // Each hook is published twice (phase received + completed). Only the first counts.
    if (payload.phase && payload.phase !== 'received') return null;
    const hookName = str(payload.hook_event_name) ?? ev.name.slice('agent.hook.'.length);
    const decoded = decodeWorkstreamId(str(payload.session_id) ?? '');
    const kind = decoded?.source ?? str(payload._source) ?? ev.source ?? 'agent';
    const sessionId = decoded?.sessionId ?? str(payload.session_id) ?? 'unknown';
    const key = agentKey(kind, sessionId);
    const def = agentDefinition(kind);
    const tool = str(payload.tool_name);
    const workspaceId = ev.workspace_id ?? str(payload.workspace_id);
    const surfaceId = ev.surface_id ?? str(payload.surface_id);

    this.lastHook.set(key, { name: hookName, toolName: tool, at });
    if (hookName === 'Stop') this.turns.set(key, (this.turns.get(key) ?? 0) + 1);

    const effect = def.hooks[hookName];
    if (effect?.state && !meta.replay) {
      const overlay: Overlay = { key, kind, sessionId, state: effect.state, sourceState: `hook:${hookName}`, at, workspaceId, surfaceId };
      this.overlays.set(key, overlay);
      if (!this.registry.has(key)) this.hookOnly.set(key, overlay);
    }
    if (!effect?.activity) return null;
    const severity: ActivitySeverity =
      effect.activity === 'agent.turn_failed'
        ? 'error'
        : effect.activity === 'agent.permission_requested' || effect.activity === 'agent.needs_input'
          ? def.permissionHookBlocks || effect.activity === 'agent.needs_input'
            ? 'attention'
            : 'info'
          : effect.activity === 'agent.turn_completed'
            ? 'success'
            : 'info';
    return this.entry(ev, at, effect.activity, severity, effect.describe({ agent: def.displayName, tool }), {
      agentKey: key,
      agentKind: kind,
      workspaceId,
      surfaceId,
      detail: [`hook ${hookName}`, tool ? `tool ${tool}` : null].filter(Boolean).join(' · '),
    });
  }

  private rememberFeedLocation(ev: RawEvent, payload: Record<string, unknown>): void {
    const loc = { workspaceId: ev.workspace_id ?? str(payload.workspace_id), surfaceId: ev.surface_id ?? str(payload.surface_id) };
    if (!loc.workspaceId && !loc.surfaceId) return;
    for (const id of [str(payload._opencode_request_id), str(payload.request_id), str(payload.session_id)]) {
      if (id) this.feedLocation.set(id, loc);
    }
    while (this.feedLocation.size > MAX_CORRELATIONS) this.feedLocation.delete(this.feedLocation.keys().next().value!);
  }

  private permissionResolved(ev: RawEvent, at: number, payload: Record<string, unknown>): ActivityEntry {
    const result = (payload.result ?? {}) as Record<string, unknown>;
    const decision = str(result.decision) ?? str(result.behavior) ?? str(result.status) ?? str(payload.decision);
    const decoded = decodeWorkstreamId(str(payload.session_id) ?? '');
    const kind = decoded?.source ?? str(payload._source);
    const def = kind ? agentDefinition(kind) : null;
    return this.entry(
      ev,
      at,
      'agent.permission_resolved',
      'info',
      `${def?.displayName ?? 'Agent'} permission request ${decision ? `resolved (${decision})` : 'resolved'}`,
      { agentKey: decoded ? agentKey(decoded.source, decoded.sessionId) : null, agentKind: kind ?? null },
    );
  }

  // ── activity helpers ───────────────────────────────────────────────────────

  private wsTitle(id: string | null): string | null {
    return id ? this.topology.workspaces[id]?.title ?? null : null;
  }

  private entry(
    ev: RawEvent,
    at: number,
    kind: ActivityKind,
    severity: ActivitySeverity,
    summary: string,
    extra: Partial<Pick<ActivityEntry, 'workspaceTitle' | 'agentKey' | 'agentKind' | 'detail' | 'workspaceId' | 'surfaceId'>> = {},
  ): ActivityEntry {
    const workspaceId = extra.workspaceId ?? ev.workspace_id;
    const surfaceId = extra.surfaceId ?? ev.surface_id;
    return {
      id: ev.id,
      kind,
      severity,
      at,
      workspaceId,
      workspaceTitle: extra.workspaceTitle ?? this.wsTitle(workspaceId),
      surfaceId,
      surfaceTitle: surfaceId ? this.topology.surfaces[surfaceId]?.title ?? null : null,
      agentKey: extra.agentKey ?? null,
      agentKind: extra.agentKind ?? null,
      summary,
      detail: extra.detail ?? null,
      bootId: ev.boot_id,
      seq: ev.seq,
    };
  }

  /** Synthetic timeline entry for connection-level facts (gaps, restarts). */
  connectionEntry(kind: 'connection.gap' | 'connection.restart', bootId: string | null, summary: string): ActivityEntry {
    const at = this.now();
    return {
      id: `mc:${kind}:${bootId ?? 'none'}:${at}`,
      kind,
      severity: 'attention',
      at,
      workspaceId: null,
      workspaceTitle: null,
      surfaceId: null,
      surfaceTitle: null,
      agentKey: null,
      agentKind: null,
      summary,
      detail: null,
      bootId,
      seq: null,
    };
  }

  // ── derived state ──────────────────────────────────────────────────────────

  private locate(item: RawFeedItem): Located {
    const decoded = decodeWorkstreamId(item.workstream_id ?? '');
    const key = decoded ? agentKey(decoded.source, decoded.sessionId) : null;
    const viaEvents = (item.request_id && this.feedLocation.get(item.request_id)) || (item.workstream_id && this.feedLocation.get(item.workstream_id));
    const viaRegistry = key ? this.registry.get(key) : undefined;
    return {
      workspaceId: viaEvents ? viaEvents.workspaceId : viaRegistry?.workspaceId ?? null,
      surfaceId: viaEvents ? viaEvents.surfaceId : viaRegistry?.surfaceId ?? null,
      agentKey: key,
      agentKind: decoded?.source ?? item.source ?? null,
    };
  }

  private pendingFeed(): PendingFeedItem[] {
    const out: PendingFeedItem[] = [];
    for (const item of this.feed) {
      if (item.status !== 'pending') continue;
      const kind = feedKind(item.kind);
      if (!kind) continue;
      const loc = this.locate(item);
      out.push({
        id: item.id,
        kind,
        requestId: item.request_id ?? null,
        toolName: item.tool_name ?? null,
        ...loc,
        since: parseTime(item.created_at) ?? this.now(),
      });
    }
    return out;
  }

  private buildAgents(pending: PendingFeedItem[]): Record<string, AgentSession> {
    const out: Record<string, AgentSession> = {};
    const keys = new Set([...this.registry.keys(), ...this.hookOnly.keys()]);
    for (const key of keys) {
      const reg = this.registry.get(key);
      const overlay = this.overlays.get(key);
      const useOverlay = overlay && overlay.at > this.registryTakenAt;
      const base = reg ?? this.hookOnly.get(key)!;
      const state: AgentState = useOverlay ? overlay.state : reg ? normalizeRegistryState(reg.state) : (base as Overlay).state;
      const sourceState = useOverlay ? overlay.sourceState : reg ? reg.state : (base as Overlay).sourceState;
      const since = this.stateSince.get(key);
      const stateSince = since && since.state === state ? since.since : this.now();
      if (!since || since.state !== state) this.stateSince.set(key, { state, since: stateSince });
      const perm = pending.find((p) => p.agentKey === key && p.kind === 'permission');
      const hook = this.lastHook.get(key) ?? null;
      const def = agentDefinition(base.kind);
      const surfaceId = (useOverlay && overlay.surfaceId) || (reg?.surfaceId ?? (base as Overlay).surfaceId ?? null);
      const workspaceId = (useOverlay && overlay.workspaceId) || (reg?.workspaceId ?? (base as Overlay).workspaceId ?? null);
      out[key] = {
        key,
        kind: base.kind,
        displayName: def.displayName,
        sessionId: base.sessionId,
        surfaceId,
        workspaceId,
        // A pending Feed permission is authoritative evidence of waiting on the user.
        state: perm && state !== 'ended' ? 'needs_attention' : state,
        sourceState: perm ? 'feed:permission_pending' : sourceState,
        stateSource: useOverlay || !reg ? 'hook-event' : 'cmux-registry',
        lastHook: hook,
        lastActivityAt: Math.max(reg?.lastActivityAt ?? 0, hook?.at ?? 0) || null,
        stateSince,
        turnsCompleted: this.turns.get(key) ?? 0,
        pendingPermission: perm ? { requestId: perm.requestId, toolName: perm.toolName, since: perm.since } : null,
      };
    }
    return out;
  }

  build(): MissionState {
    if (this.cached) return this.cached;
    const now = this.now();
    const surfaces: Record<string, Surface> = {};
    for (const s of Object.values(this.topology.surfaces)) {
      surfaces[s.id] = {
        ...s,
        programStatus: this.programStatus.get(s.workspaceId, s.id),
        lastActivityAt: this.surfaceActivity.get(s.id) ?? null,
      };
    }
    const workspaces = { ...this.topology.workspaces };
    for (const [id, ws] of Object.entries(workspaces)) {
      const pills = this.pills.get(id);
      if (pills?.size) workspaces[id] = { ...ws, statusPills: [...pills.values()].sort((a, b) => a.key.localeCompare(b.key)) };
    }
    const pending = this.pendingFeed();
    const agents = this.buildAgents(pending);
    const attention = buildAttention({
      agents: Object.values(agents),
      pendingFeed: pending,
      surfaces,
      workspaces,
      notifications: this.notifications,
    });
    const summaries: MissionState['summaries'] = {};
    for (const ws of Object.values(workspaces)) {
      const wsSurfaces = Object.values(surfaces).filter((s) => s.workspaceId === ws.id);
      summaries[ws.id] = this.summarizer.summarizeWorkspace({
        workspace: ws,
        surfaces: wsSurfaces,
        agents: Object.values(agents).filter((a) => a.workspaceId === ws.id),
        attention: attention.filter((a) => a.workspaceId === ws.id),
        latestActivity: this.latestByWorkspace.get(ws.id) ?? null,
        now,
      });
    }
    const partial = {
      windows: this.topology.windows,
      workspaces,
      panes: this.topology.panes,
      surfaces,
      agents,
      attention,
      summaries,
    };
    this.cached = {
      version: this.version,
      generatedAt: now,
      connection: this.connection,
      windowOrder: this.topology.windowOrder,
      ...partial,
      kpis: computeKpis(partial, this.turns24h),
      settings: this.settings,
      capabilities: this.capabilities,
      fixtureMode: this.fixtureMode,
    };
    return this.cached;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function q(title: string | null): string {
  return title ? `“${title}”` : '(untitled)';
}
