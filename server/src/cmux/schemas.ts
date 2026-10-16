// Zod schemas for the cmux responses Mission Control consumes. Shapes were captured from
// cmux 0.65.2 (see test/fixtures). Schemas are deliberately lenient: unknown fields pass
// through and optional fields default, so additive cmux changes do not break parsing.
import { z } from 'zod';

const str = z.string();
const nstr = z.string().nullable().optional();
const nnum = z.number().nullable().optional();
const nbool = z.boolean().nullable().optional();

// ── Event stream frames ───────────────────────────────────────────────────────

export const AckSchema = z.looseObject({
  type: z.literal('ack'),
  boot_id: str,
  subscription_id: nstr,
  heartbeat_interval_seconds: nnum,
  replay_count: nnum,
  resume: z.looseObject({
    after_seq: nnum,
    requested_after_seq: nnum,
    oldest_seq: nnum,
    latest_seq: nnum,
    next_seq: nnum,
    gap: nbool,
    restore_gap: nbool,
  }),
});
export type RawAck = z.infer<typeof AckSchema>;

export const HeartbeatSchema = z.looseObject({
  type: z.literal('heartbeat'),
  boot_id: str,
  latest_seq: nnum,
  occurred_at: nstr,
});
export type RawHeartbeat = z.infer<typeof HeartbeatSchema>;

export const EventSchema = z.looseObject({
  type: z.literal('event'),
  boot_id: str,
  seq: z.number(),
  id: str,
  name: str,
  category: z.string().default(''),
  source: z.string().nullable().default(null),
  occurred_at: str,
  workspace_id: z.string().nullable().default(null),
  surface_id: z.string().nullable().default(null),
  pane_id: z.string().nullable().default(null),
  window_id: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).nullable().default({}),
});
export type RawEvent = z.infer<typeof EventSchema>;

export type Frame =
  | { kind: 'ack'; ack: RawAck }
  | { kind: 'heartbeat'; heartbeat: RawHeartbeat }
  | { kind: 'event'; event: RawEvent }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'invalid'; reason: string };

export function parseFrame(line: string): Frame {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: 'not json' };
  }
  const type = (json as { type?: unknown })?.type;
  if (type === 'ack') {
    const r = AckSchema.safeParse(json);
    return r.success ? { kind: 'ack', ack: r.data } : { kind: 'invalid', reason: 'bad ack' };
  }
  if (type === 'heartbeat') {
    const r = HeartbeatSchema.safeParse(json);
    return r.success ? { kind: 'heartbeat', heartbeat: r.data } : { kind: 'invalid', reason: 'bad heartbeat' };
  }
  if (type === 'event') {
    const r = EventSchema.safeParse(json);
    return r.success ? { kind: 'event', event: r.data } : { kind: 'invalid', reason: 'bad event' };
  }
  // Errors arrive either as {type:"error",...} or as an RPC-style {ok:false,error:{...}}.
  const obj = json as { ok?: boolean; error?: unknown; message?: unknown; code?: unknown };
  if (type === 'error' || obj?.ok === false) {
    const e = (typeof obj.error === 'object' && obj.error ? obj.error : obj) as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' ? e.code : typeof obj.error === 'string' ? obj.error : 'error';
    const message = typeof e.message === 'string' ? e.message : code;
    return { kind: 'error', code: /access denied/i.test(message) ? 'access_denied' : code, message };
  }
  return { kind: 'invalid', reason: `unknown frame type ${String(type)}` };
}

// ── system.tree ──────────────────────────────────────────────────────────────

export const TreeSurfaceSchema = z.looseObject({
  id: str,
  ref: nstr,
  index: z.number().default(0),
  index_in_pane: nnum,
  pane_id: nstr,
  title: z.string().nullable().default(''),
  type: z.string().default('terminal'),
  url: nstr,
  tty: nstr,
  focused: nbool,
  selected: nbool,
  selected_in_pane: nbool,
  render_health: nstr,
});

export const TreePaneSchema = z.looseObject({
  id: str,
  ref: nstr,
  index: z.number().default(0),
  focused: nbool,
  selected_surface_id: nstr,
  surface_ids: z.array(str).default([]),
  surfaces: z.array(TreeSurfaceSchema).default([]),
});

export const TreeWorkspaceSchema = z.looseObject({
  id: str,
  ref: nstr,
  index: z.number().default(0),
  title: z.string().nullable().default(''),
  description: nstr,
  pinned: nbool,
  selected: nbool,
  panes: z.array(TreePaneSchema).default([]),
});

export const TreeWindowSchema = z.looseObject({
  id: str,
  ref: nstr,
  index: z.number().default(0),
  key: nbool,
  visible: nbool,
  selected_workspace_id: nstr,
  workspaces: z.array(TreeWorkspaceSchema).default([]),
});

export const SystemTreeSchema = z.looseObject({
  windows: z.array(TreeWindowSchema).default([]),
});
export type RawTree = z.infer<typeof SystemTreeSchema>;

// ── extension.sidebar.snapshot ───────────────────────────────────────────────

const GitBranchSchema = z.union([
  z.string(),
  z.looseObject({ branch: nstr, name: nstr, is_dirty: nbool, dirty: nbool, directory: nstr, path: nstr }),
]);

export const SidebarWorkspaceSchema = z.looseObject({
  id: str,
  title: nstr,
  current_directory: nstr,
  root_path: nstr,
  project_root_path: nstr,
  branch_summary: z.unknown().optional(),
  git_branches: z.array(GitBranchSchema).nullable().default([]),
  pull_request_urls: z.array(z.string()).nullable().default([]),
  listening_ports: z.array(z.union([z.number(), z.looseObject({ port: z.number() })])).nullable().default([]),
  unread_count: nnum,
  latest_submitted_message: nstr,
  latest_submitted_at: nstr,
  latest_notification_text: nstr,
});

export const SidebarSnapshotSchema = z.looseObject({
  seq: nnum,
  window_id: nstr,
  selected_workspace_id: nstr,
  workspaces: z.array(SidebarWorkspaceSchema).default([]),
});
export type RawSidebar = z.infer<typeof SidebarSnapshotSchema>;

// ── current.list ─────────────────────────────────────────────────────────────

export const CurrentAgentSchema = z.looseObject({
  kind: str,
  session_id: str,
  state: z.string().default('unknown'),
  last_activity_at: nstr,
  has_hook_lifecycle_state: nbool,
  version: nnum,
});

export const CurrentItemSchema = z.looseObject({
  kind: z.string().default('unknown'),
  label: nstr,
  cwd: nstr,
  lifecycle: nstr,
  resource_ref: nstr,
  agents: z.array(CurrentAgentSchema).default([]),
  attention: z.array(z.looseObject({ kind: z.string().default('unknown'), scope: nstr })).default([]),
  projections: z.array(z.looseObject({ panel_id: nstr, workspace_id: nstr })).default([]),
});

export const CurrentListSchema = z.looseObject({
  authority: nstr,
  items: z.array(CurrentItemSchema).default([]),
});
export type RawCurrent = z.infer<typeof CurrentListSchema>;

// ── feed.list ────────────────────────────────────────────────────────────────

export const FeedItemSchema = z.looseObject({
  id: str,
  kind: z.string().default('unknown'),
  status: z.string().default('unknown'),
  source: nstr,
  workstream_id: nstr,
  request_id: nstr,
  tool_name: nstr,
  title: nstr,
  text: nstr,
  cwd: nstr,
  created_at: nstr,
  updated_at: nstr,
});
export const FeedListSchema = z.looseObject({ items: z.array(FeedItemSchema).default([]) });
export type RawFeedItem = z.infer<typeof FeedItemSchema>;

// ── notification.list ────────────────────────────────────────────────────────

export const NotificationSchema = z.looseObject({
  id: str,
  title: nstr,
  subtitle: nstr,
  body: nstr,
  is_read: nbool,
  created_at: nstr,
  workspace_id: nstr,
  surface_id: nstr,
});
export const NotificationListSchema = z.looseObject({ notifications: z.array(NotificationSchema).default([]) });
export type RawNotification = z.infer<typeof NotificationSchema>;

// ── system.capabilities / system.identify ────────────────────────────────────

export const CapabilitiesSchema = z.looseObject({
  access_mode: nstr,
  protocol: nstr,
  version: z.union([z.number(), z.string()]).nullable().optional(),
  methods: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
});

export const IdentifySchema = z.looseObject({
  version: nstr,
  build: z.union([z.string(), z.number()]).nullable().optional(),
});
