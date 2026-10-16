// Wires the cmux adapter, event stream, state manager and stores together.
import { join } from 'node:path';
import type { ActivityEntry, ConnectionProblem, ConnectionStatus, NavigateRequest, NavigateResult, Settings } from '../../shared/types.ts';
import { ALL_GROUPS, CmuxAdapter, type SnapshotGroup } from './cmux/adapter.ts';
import { CmuxConnectionError } from './cmux/errors.ts';
import { EventStream, type AckInfo, type StreamCursor } from './cmux/eventStream.ts';
import type { Config } from './config.ts';
import { StateManager } from './domain/stateManager.ts';
import type { Logger } from './logger.ts';
import { ActivityStore, type RetentionPolicy } from './store/activityStore.ts';
import { SettingsStore } from './store/settingsStore.ts';

export interface MissionControlOptions {
  config: Config;
  log: Logger;
  retention?: RetentionPolicy;
  /** Debounce for event-triggered snapshot refreshes. */
  refreshDebounceMs?: number;
  refreshMaxWaitMs?: number;
  reconcileIntervalMs?: number;
  stallFactor?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const DAY = 24 * 60 * 60 * 1000;

export class MissionControl {
  readonly state: StateManager;
  readonly activity: ActivityStore;
  readonly settings: SettingsStore;
  readonly adapter: CmuxAdapter;
  private readonly stream: EventStream;
  private readonly cfg: Config;
  private readonly log: Logger;
  private readonly opts: MissionControlOptions;
  private readonly activityListeners = new Set<(e: ActivityEntry) => void>();

  private cursor: StreamCursor;
  private cursorDirty = false;
  private pendingGroups = new Set<SnapshotGroup>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshFirstRequestedAt = 0;
  private refreshing: Promise<void> | null = null;
  private needsFullSync = true;
  private infoBootId: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private started = false;

  constructor(opts: MissionControlOptions) {
    this.opts = opts;
    this.cfg = opts.config;
    this.log = opts.log;
    this.activity = new ActivityStore(join(this.cfg.dataDir, 'activity.sqlite'), opts.retention);
    this.settings = new SettingsStore(join(this.cfg.dataDir, 'settings.json'));
    this.adapter = new CmuxAdapter(this.cfg.socketPath, this.cfg.cmuxAppPath, this.log.child('cmux'));
    this.cursor = this.activity.getCursor();

    const connection: ConnectionStatus = {
      phase: 'connecting',
      problem: null,
      message: null,
      socketPath: this.cfg.socketPath,
      cmuxVersion: null,
      accessMode: null,
      bootId: this.cursor.bootId,
      lastSeq: this.cursor.seq,
      lastFrameAt: null,
      lastSnapshotAt: null,
      stale: true,
      gapDetectedAt: null,
      reconnectAttempt: 0,
      insideCmux: this.cfg.insideCmux,
    };
    this.state = new StateManager({
      selfSurfaceId: this.cfg.selfSurfaceId,
      settings: this.settings.get(),
      connection,
      fixtureMode: this.cfg.fixtureMode,
    });
    for (const e of this.activity.latestPerWorkspace()) this.state.noteActivity(e);
    this.state.setTurns24h(this.activity.countSince('agent.turn_completed', Date.now() - DAY));

    this.stream = new EventStream({
      socketPath: this.cfg.socketPath,
      log: this.log.child('events'),
      getCursor: () => this.cursor,
      stallFactor: opts.stallFactor,
      minBackoffMs: opts.minBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
      handlers: {
        onAck: (info) => this.onAck(info),
        onEvent: (ev, meta) => this.onEvent(ev, meta),
        onHeartbeat: () => this.state.setConnection({ lastFrameAt: Date.now() }),
        onDisconnect: (problem, message) => this.onDisconnect(problem, message),
      },
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.activity.prune();
    if (!this.adapter.isInstalled()) {
      this.state.setConnection({
        phase: 'unavailable',
        problem: 'not_installed',
        message: `cmux was not found at ${this.cfg.cmuxAppPath} and no socket exists at ${this.cfg.socketPath}.`,
      });
    }
    this.stream.start();
    this.timers.push(
      setInterval(() => {
        if (this.state.getConnection().phase === 'live') this.requestRefresh(ALL_GROUPS, true);
      }, this.opts.reconcileIntervalMs ?? 60_000),
      setInterval(() => this.flushCursor(), 1000),
      setInterval(() => {
        this.activity.prune();
        this.state.setTurns24h(this.activity.countSince('agent.turn_completed', Date.now() - DAY));
      }, 60 * 60 * 1000),
    );
  }

  async stop(): Promise<void> {
    this.stream.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.refreshing?.catch(() => {});
    this.flushCursor();
    this.activity.close();
  }

  /** Drop and re-open the event stream (used by live verification to exercise resume). */
  reconnectStream(reason: string): void {
    this.stream.restart(reason);
  }

  onActivity(fn: (e: ActivityEntry) => void): () => void {
    this.activityListeners.add(fn);
    return () => this.activityListeners.delete(fn);
  }

  // ── stream callbacks ───────────────────────────────────────────────────────

  private onAck(info: AckInfo): void {
    const { ack } = info;
    const fromStart = (this.cursor.seq ?? 0) === 0;
    if (info.restarted) {
      this.log.info('cmux restarted', { bootId: ack.boot_id, previous: this.cursor.bootId });
      this.record(this.state.connectionEntry('connection.restart', ack.boot_id, 'cmux restarted — state resynchronized from a fresh snapshot'));
      this.state.markGap();
      if (!fromStart) {
        // Our cursor belongs to the old process: replay the new boot's history from its start.
        this.cursor = { bootId: ack.boot_id, seq: 0 };
        this.cursorDirty = true;
        this.stream.restart('replay new boot');
        return;
      }
    }
    // A restart observed with a zero cursor already replays the new boot from its start.
    const gap = info.restarted ? ack.resume.gap === true : info.gap;
    if (gap) {
      this.log.warn('event replay gap; resynchronizing', { resume: ack.resume });
      this.state.markGap();
      this.record(
        this.state.connectionEntry('connection.gap', ack.boot_id, 'Event replay gap — some cmux events were missed; state was resynchronized'),
      );
    } else {
      this.state.markReplayComplete(fromStart);
    }
    this.cursor = { bootId: ack.boot_id, seq: this.cursor.bootId === ack.boot_id ? this.cursor.seq : 0 };
    this.cursorDirty = true;
    this.state.setConnection({
      phase: 'resyncing',
      problem: null,
      message: null,
      bootId: ack.boot_id,
      lastFrameAt: Date.now(),
      reconnectAttempt: 0,
      gapDetectedAt: gap ? Date.now() : this.state.getConnection().gapDetectedAt,
    });
    this.needsFullSync = true;
    if (this.infoBootId !== ack.boot_id) void this.loadInfo(ack.boot_id);
    this.requestRefresh(ALL_GROUPS, true);
  }

  private onEvent(ev: Parameters<StateManager['applyEvent']>[0], meta: { replay: boolean }): void {
    try {
      const outcome = this.state.applyEvent(ev, meta);
      if (outcome.activity) this.record(outcome.activity);
      if (!meta.replay && outcome.refresh.size) this.requestRefresh(outcome.refresh);
    } catch (err) {
      this.log.error('failed to apply event', { name: ev.name, seq: ev.seq, err });
    }
    // Advance the cursor only after the event's side effects were applied. The cursor keeps
    // the *current* process's boot id even when replaying history restored from an older one.
    this.cursor = { bootId: this.state.getConnection().bootId ?? ev.boot_id, seq: ev.seq };
    this.cursorDirty = true;
    this.state.setConnection({ lastFrameAt: Date.now() });
  }

  private record(entry: ActivityEntry): void {
    if (!this.activity.insert(entry)) return;
    this.state.noteActivity(entry);
    if (entry.kind === 'agent.turn_completed') this.state.setTurns24h(this.activity.countSince('agent.turn_completed', Date.now() - DAY));
    for (const fn of this.activityListeners) fn(entry);
  }

  private onDisconnect(problem: ConnectionProblem, message: string): void {
    const installed = this.adapter.isInstalled();
    const p: ConnectionProblem = problem === 'not_running' && !installed ? 'not_installed' : problem;
    this.state.setConnection({
      phase: p === 'access_denied' || p === 'not_installed' ? 'unavailable' : 'reconnecting',
      problem: p,
      message,
      reconnectAttempt: this.stream.reconnectAttempt,
    });
  }

  private async loadInfo(bootId: string): Promise<void> {
    try {
      const info = await this.adapter.info();
      this.infoBootId = bootId;
      this.state.setCapabilities({ methods: info.methods, features: info.features });
      this.state.setConnection({ cmuxVersion: info.version, accessMode: info.accessMode });
    } catch (err) {
      this.log.warn('could not read cmux capabilities', { err });
    }
  }

  // ── snapshot refresh scheduling ────────────────────────────────────────────

  requestRefresh(groups: Iterable<SnapshotGroup>, immediate = false): void {
    for (const g of groups) this.pendingGroups.add(g);
    if (!this.pendingGroups.size) return;
    const now = Date.now();
    if (!this.refreshTimer) this.refreshFirstRequestedAt = now;
    const maxWait = this.opts.refreshMaxWaitMs ?? 1000;
    const debounce = this.opts.refreshDebounceMs ?? 150;
    const delay = immediate ? 0 : Math.max(0, Math.min(debounce, this.refreshFirstRequestedAt + maxWait - now));
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.runRefresh();
    }, delay);
  }

  private async runRefresh(): Promise<void> {
    if (this.refreshing) {
      await this.refreshing.catch(() => {});
      if (this.pendingGroups.size && !this.refreshTimer) this.requestRefresh([], true);
      return;
    }
    const groups = new Set(this.pendingGroups);
    this.pendingGroups.clear();
    if (!groups.size) return;
    const full = this.needsFullSync;
    if (full) for (const g of ALL_GROUPS) groups.add(g);
    this.refreshing = (async () => {
      try {
        const snap = await this.adapter.snapshot(groups);
        this.state.applySnapshot(snap);
        if (full) this.needsFullSync = false;
        const conn = this.state.getConnection();
        this.state.setConnection({
          lastSnapshotAt: snap.takenAt,
          ...(conn.phase === 'resyncing' && full ? { phase: 'live' as const, gapDetectedAt: null } : {}),
        });
        if (Object.keys(snap.partialErrors).length) this.log.warn('partial snapshot', { errors: snap.partialErrors });
      } catch (err) {
        this.log.warn('snapshot failed', { err, groups: [...groups] });
        if (!(err instanceof CmuxConnectionError)) {
          // Retry once later; connection errors are handled by the event stream.
          setTimeout(() => this.requestRefresh(groups), 2000);
        } else if (full) {
          this.needsFullSync = true;
        }
      }
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
      if (this.pendingGroups.size && !this.refreshTimer) this.requestRefresh([], true);
    }
  }

  private flushCursor(): void {
    if (!this.cursorDirty) return;
    this.cursorDirty = false;
    this.activity.setCursor(this.cursor);
    this.state.setConnection({ lastSeq: this.cursor.seq });
  }

  // ── commands from the HTTP layer ───────────────────────────────────────────

  /** Delete locally stored history (never touches cmux). */
  clearHistory(): void {
    this.activity.clear();
    this.state.setTurns24h(0);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = this.settings.update(patch);
    this.state.setSettings(next);
    return next;
  }

  async navigate(req: NavigateRequest): Promise<NavigateResult> {
    const s = this.state.build();
    if (s.connection.phase !== 'live' && s.connection.phase !== 'resyncing') {
      return { ok: false, error: 'cmux is not connected; cannot navigate.' };
    }
    const ws = s.workspaces[req.workspaceId];
    if (!ws) return { ok: false, error: 'That workspace is no longer open in cmux.' };
    if (req.kind === 'surface') {
      const surface = s.surfaces[req.surfaceId];
      if (!surface || surface.workspaceId !== ws.id) return { ok: false, error: 'That tab is no longer in this workspace.' };
    }
    try {
      await this.adapter.focusWindow(ws.windowId).catch((err) => this.log.debug('window.focus failed', { err }));
      await this.adapter.selectWorkspace(ws.id);
      if (req.kind === 'surface') await this.adapter.focusSurface(ws.id, req.surfaceId);
      this.log.info('navigated', { kind: req.kind, workspaceId: ws.id });
      return { ok: true };
    } catch (err) {
      this.log.warn('navigation failed', { err });
      return { ok: false, error: err instanceof Error ? err.message : 'Navigation failed' };
    }
  }
}
