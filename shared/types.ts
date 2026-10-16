// Normalized Mission Control domain model, shared by the server and the web UI.
// Everything here is derived from verified cmux interfaces; see docs/CAPABILITIES.md.

export type ConnectionPhase =
  | 'connecting' // first attempt in progress
  | 'live' // event stream open, snapshot applied, heartbeats arriving
  | 'resyncing' // stream open again after a gap/restart; snapshot in flight
  | 'reconnecting' // stream lost, retrying
  | 'unavailable'; // cmux cannot be reached for a known reason (see reason)

export type ConnectionProblem =
  | 'not_installed'
  | 'not_running'
  | 'access_denied'
  | 'protocol_error'
  | 'timeout'
  | 'stream_stalled'
  | 'unknown';

export interface ConnectionStatus {
  phase: ConnectionPhase;
  problem: ConnectionProblem | null;
  message: string | null;
  socketPath: string;
  cmuxVersion: string | null;
  accessMode: string | null;
  bootId: string | null;
  lastSeq: number | null;
  /** Wall-clock ms of the last frame (event or heartbeat) from cmux. */
  lastFrameAt: number | null;
  lastSnapshotAt: number | null;
  /** True whenever displayed data may not reflect cmux right now. */
  stale: boolean;
  /** Set after a replay gap or cmux restart; cleared by the next complete snapshot. */
  gapDetectedAt: number | null;
  reconnectAttempt: number;
  /** True when this backend process runs inside a cmux terminal. */
  insideCmux: boolean;
}

export interface CmuxWindow {
  id: string;
  ref: string | null;
  index: number;
  isKey: boolean;
  visible: boolean;
  selectedWorkspaceId: string | null;
  workspaceIds: string[];
}

export interface GitInfo {
  branch: string | null;
  dirty: boolean | null;
}

export interface StatusPill {
  key: string;
  value: string;
  color: string | null;
  updatedAt: number;
}

export interface Workspace {
  id: string;
  ref: string | null;
  windowId: string;
  index: number;
  title: string;
  description: string | null;
  pinned: boolean;
  selected: boolean;
  cwd: string | null;
  projectRoot: string | null;
  git: GitInfo | null;
  pullRequestUrls: string[];
  listeningPorts: number[];
  unreadCount: number;
  /** Only populated when the user enabled prompt previews. */
  latestPrompt: { text: string; at: string | null } | null;
  /** Whether cmux has a submitted prompt for this workspace (independent of the privacy toggle). */
  hasSubmittedPrompt: boolean;
  paneIds: string[];
  statusPills: StatusPill[];
}

export interface Pane {
  id: string;
  ref: string | null;
  workspaceId: string;
  index: number;
  focused: boolean;
  selectedSurfaceId: string | null;
  surfaceIds: string[];
}

export type SurfaceType = 'terminal' | 'browser' | 'markdown' | 'agent-session' | 'other';

export type ProgramState = 'working' | 'blocked' | 'error' | 'done' | 'idle';

export interface ProgramStatusRecord {
  id: string;
  state: ProgramState;
  kind: string;
  progress: number | null;
  updatedAt: number;
}

export interface Surface {
  id: string;
  ref: string | null;
  paneId: string;
  workspaceId: string;
  index: number;
  title: string;
  type: SurfaceType;
  rawType: string;
  url: string | null;
  tty: string | null;
  focused: boolean;
  selectedInPane: boolean;
  renderHealth: string | null;
  /** Event-derived OSC 7501 records; null means unknown (e.g. after a replay gap). */
  programStatus: ProgramStatusRecord[] | null;
  lastActivityAt: number | null;
  /** True for the terminal running this Mission Control backend. */
  isMissionControl: boolean;
}

export type AgentState = 'working' | 'needs_attention' | 'idle' | 'ended' | 'error' | 'unknown';

export interface AgentSession {
  /** `${kind}:${sessionId}` */
  key: string;
  kind: string;
  displayName: string;
  sessionId: string;
  surfaceId: string | null;
  workspaceId: string | null;
  state: AgentState;
  /** The state exactly as cmux reported it (e.g. "needs_input") or the hook name. */
  sourceState: string;
  stateSource: 'cmux-registry' | 'hook-event';
  lastHook: { name: string; toolName: string | null; at: number } | null;
  lastActivityAt: number | null;
  stateSince: number | null;
  /** Turns observed ending (Stop hooks) since Mission Control started watching. */
  turnsCompleted: number;
  pendingPermission: { requestId: string | null; toolName: string | null; since: number } | null;
}

export type AttentionKind =
  | 'permission'
  | 'question'
  | 'plan_approval'
  | 'needs_input'
  | 'agent_error'
  | 'program_error'
  | 'program_blocked'
  | 'notification';

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  urgency: number;
  workspaceId: string | null;
  surfaceId: string | null;
  agentKey: string | null;
  agentKind: string | null;
  title: string;
  reason: string;
  since: number;
  source: string;
}

export type ActivityKind =
  | 'workspace.created'
  | 'workspace.closed'
  | 'workspace.renamed'
  | 'workspace.moved'
  | 'surface.created'
  | 'surface.closed'
  | 'surface.moved'
  | 'agent.session_started'
  | 'agent.session_ended'
  | 'agent.turn_started'
  | 'agent.turn_completed'
  | 'agent.turn_failed'
  | 'agent.permission_requested'
  | 'agent.permission_resolved'
  | 'agent.needs_input'
  | 'notification.created'
  | 'program.error'
  | 'program.blocked'
  | 'program.done'
  | 'program.working'
  | 'connection.gap'
  | 'connection.restart';

export type ActivitySeverity = 'info' | 'success' | 'attention' | 'error';

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  severity: ActivitySeverity;
  at: number;
  workspaceId: string | null;
  workspaceTitle: string | null;
  surfaceId: string | null;
  surfaceTitle: string | null;
  agentKey: string | null;
  agentKind: string | null;
  summary: string;
  detail: string | null;
  bootId: string | null;
  seq: number | null;
}

export interface Kpis {
  windows: number;
  workspaces: number;
  panes: number;
  surfaces: number;
  terminals: number;
  agentsDetected: number;
  agentsWorking: number;
  agentsNeedingAttention: number;
  attentionItems: number;
  /** Stop hooks recorded in the activity store in the last 24 h (turns, not tasks). */
  turnsCompleted24h: number | null;
  workspacesWithErrors: number;
}

export interface WorkspaceSummary {
  workspaceId: string;
  health: 'needs_attention' | 'error' | 'working' | 'idle' | 'quiet';
  headline: string;
  headlineSource: 'agent' | 'program-status' | 'notification' | 'activity' | 'none';
  lastActivityAt: number | null;
  attentionCount: number;
  agentKeys: string[];
}

export interface Settings {
  showPromptPreviews: boolean;
}

export interface MissionState {
  version: number;
  generatedAt: number;
  connection: ConnectionStatus;
  windows: Record<string, CmuxWindow>;
  windowOrder: string[];
  workspaces: Record<string, Workspace>;
  panes: Record<string, Pane>;
  surfaces: Record<string, Surface>;
  agents: Record<string, AgentSession>;
  attention: AttentionItem[];
  summaries: Record<string, WorkspaceSummary>;
  kpis: Kpis;
  settings: Settings;
  /** Methods cmux advertised via system.capabilities, for the Settings diagnostics page. */
  capabilities: { methods: string[]; features: string[] } | null;
  fixtureMode: boolean;
}

export type NavigateRequest =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'surface'; workspaceId: string; surfaceId: string };

export interface NavigateResult {
  ok: boolean;
  error?: string;
}

export interface ActivityQuery {
  workspaceId?: string;
  agentKey?: string;
  kind?: string;
  severity?: ActivitySeverity;
  before?: number;
  limit?: number;
}
