import { existsSync } from 'node:fs';
import { SocketRpc } from './socketRpc.ts';
import {
  CapabilitiesSchema,
  CurrentListSchema,
  FeedListSchema,
  IdentifySchema,
  NotificationListSchema,
  SidebarSnapshotSchema,
  SystemTreeSchema,
  type RawCurrent,
  type RawFeedItem,
  type RawNotification,
  type RawSidebar,
  type RawTree,
} from './schemas.ts';
import { CmuxConnectionError, CmuxRpcError } from './errors.ts';
import type { Logger } from '../logger.ts';
import type { z } from 'zod';

export type SnapshotGroup = 'topology' | 'agents' | 'notifications';
export const ALL_GROUPS: ReadonlySet<SnapshotGroup> = new Set(['topology', 'agents', 'notifications']);

export interface CmuxSnapshot {
  takenAt: number;
  groups: ReadonlySet<SnapshotGroup>;
  /** Present when the `topology` group was requested. */
  tree: RawTree | null;
  sidebar: RawSidebar['workspaces'] | null;
  current: RawCurrent | null;
  feed: RawFeedItem[] | null;
  notifications: RawNotification[] | null;
  /** Non-fatal failures of the enrichment queries, keyed by method. */
  partialErrors: Record<string, string>;
}

export interface CmuxInfo {
  version: string | null;
  accessMode: string | null;
  methods: string[];
  features: string[];
}

/** The only cmux methods the dashboard may invoke on the user's behalf. */
export const NAVIGATION_METHODS = ['window.focus', 'workspace.select', 'surface.focus'] as const;

export class CmuxAdapter {
  readonly rpc: SocketRpc;
  private readonly log: Logger;
  private readonly appPath: string;

  constructor(socketPath: string, appPath: string, log: Logger) {
    this.rpc = new SocketRpc(socketPath, log.child('rpc'));
    this.log = log;
    this.appPath = appPath;
  }

  isInstalled(): boolean {
    return existsSync(this.appPath) || existsSync(this.rpc.socketPath);
  }

  async info(): Promise<CmuxInfo> {
    const caps = await this.query('system.capabilities', {}, CapabilitiesSchema);
    let version: string | null = null;
    try {
      const id = await this.query('system.identify', {}, IdentifySchema);
      version = id.version ?? null;
    } catch (err) {
      this.log.debug('system.identify failed', { err });
    }
    return { version, accessMode: caps.access_mode ?? null, methods: caps.methods, features: caps.capabilities };
  }

  /**
   * Fetch the requested snapshot groups. `system.tree` is authoritative for topology and
   * must succeed; the enrichment queries degrade to null with an entry in partialErrors.
   */
  async snapshot(groups: ReadonlySet<SnapshotGroup> = ALL_GROUPS): Promise<CmuxSnapshot> {
    const takenAt = Date.now();
    const partialErrors: Record<string, string> = {};
    const optional = async <T>(method: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof CmuxConnectionError) throw err;
        partialErrors[method] = err instanceof Error ? err.message : String(err);
        this.log.warn('snapshot enrichment failed', { method, err });
        return null;
      }
    };

    const none = async () => null;
    // Without `all_windows`, cmux 0.65.2 returns only the focused window (verified live).
    const tree = groups.has('topology') ? await this.query('system.tree', { all_windows: true }, SystemTreeSchema) : null;
    const [sidebar, current, feed, notifications] = await Promise.all([
      tree ? optional('extension.sidebar.snapshot', () => this.sidebarForWindows(tree.windows.map((w) => w.id))) : none(),
      groups.has('agents') ? optional('current.list', () => this.query('current.list', { limit: 200 }, CurrentListSchema)) : none(),
      groups.has('agents') ? optional('feed.list', async () => (await this.query('feed.list', {}, FeedListSchema)).items) : none(),
      groups.has('notifications')
        ? optional('notification.list', async () => (await this.query('notification.list', {}, NotificationListSchema)).notifications)
        : none(),
    ]);
    return { takenAt, groups, tree, sidebar, current, feed, notifications, partialErrors };
  }

  /** The sidebar snapshot is scoped to one window; ask for each and merge by workspace id. */
  private async sidebarForWindows(windowIds: string[]): Promise<RawSidebar['workspaces']> {
    const merged = new Map<string, RawSidebar['workspaces'][number]>();
    const base = await this.query('extension.sidebar.snapshot', {}, SidebarSnapshotSchema);
    for (const w of base.workspaces) merged.set(w.id, w);
    const others = windowIds.filter((id) => id !== base.window_id);
    for (const windowId of others) {
      try {
        const snap = await this.query('extension.sidebar.snapshot', { window_id: windowId }, SidebarSnapshotSchema);
        for (const w of snap.workspaces) if (!merged.has(w.id)) merged.set(w.id, w);
      } catch (err) {
        if (err instanceof CmuxConnectionError) throw err;
        this.log.debug('per-window sidebar snapshot unavailable', { windowId, err });
      }
    }
    return [...merged.values()];
  }

  async focusWindow(windowId: string): Promise<void> {
    await this.rpc.call('window.focus', { window_id: windowId });
  }

  async selectWorkspace(workspaceId: string): Promise<void> {
    await this.rpc.call('workspace.select', { workspace_id: workspaceId });
  }

  async focusSurface(workspaceId: string, surfaceId: string): Promise<void> {
    await this.rpc.call('surface.focus', { workspace_id: workspaceId, surface_id: surfaceId });
  }

  private async query<S extends z.ZodType>(method: string, params: Record<string, unknown>, schema: S): Promise<z.infer<S>> {
    const raw = await this.rpc.call(method, params);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new CmuxRpcError(method, 'schema_mismatch', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    return parsed.data;
  }
}
