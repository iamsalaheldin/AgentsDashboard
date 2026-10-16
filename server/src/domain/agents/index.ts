// Agent-specific knowledge lives here and nowhere else. Each definition maps the agent's
// native hook names (as relayed by cmux in `agent.hook.<Name>` events) onto normalized
// states and timeline entries.
import type { ActivityKind, AgentState } from '../../../../shared/types.ts';

export interface HookEffect {
  /** New normalized state, or null when the hook does not change state. */
  state: AgentState | null;
  activity: ActivityKind | null;
  /** Human-readable, deterministic description of what the hook means. */
  describe: (ctx: { agent: string; tool: string | null }) => string;
}

export interface AgentDefinition {
  kind: string;
  displayName: string;
  /** Whether a PermissionRequest hook means the agent is actually blocked on the user. */
  permissionHookBlocks: boolean;
  /** Shown next to the agent so users know what the integration can and cannot report. */
  integrationNote: string;
  hooks: Record<string, HookEffect>;
}

const toolSuffix = (tool: string | null) => (tool ? ` (${tool})` : '');

const COMMON_HOOKS: Record<string, HookEffect> = {
  SessionStart: { state: 'idle', activity: 'agent.session_started', describe: ({ agent }) => `${agent} session started` },
  UserPromptSubmit: { state: 'working', activity: 'agent.turn_started', describe: ({ agent }) => `${agent} started working on a prompt` },
  PreToolUse: { state: 'working', activity: null, describe: ({ agent, tool }) => `${agent} is using a tool${toolSuffix(tool)}` },
  PostToolUse: { state: 'working', activity: null, describe: ({ agent, tool }) => `${agent} finished a tool call${toolSuffix(tool)}` },
  PermissionRequest: {
    state: 'needs_attention',
    activity: 'agent.permission_requested',
    describe: ({ agent, tool }) => `${agent} requested permission${toolSuffix(tool)}`,
  },
  Notification: { state: 'needs_attention', activity: 'agent.needs_input', describe: ({ agent }) => `${agent} is waiting for you` },
  Stop: { state: 'idle', activity: 'agent.turn_completed', describe: ({ agent }) => `${agent} finished its turn` },
  StopFailure: { state: 'error', activity: 'agent.turn_failed', describe: ({ agent }) => `${agent} turn ended with an error` },
  SubagentStop: { state: null, activity: null, describe: ({ agent }) => `${agent} subagent finished` },
  SessionEnd: { state: 'ended', activity: 'agent.session_ended', describe: ({ agent }) => `${agent} session ended` },
};

const claude: AgentDefinition = {
  kind: 'claude',
  displayName: 'Claude Code',
  permissionHookBlocks: true,
  integrationNote: 'Hooks injected by the cmux Claude wrapper. Permission prompts are actionable in cmux Feed.',
  hooks: COMMON_HOOKS,
};

const codex: AgentDefinition = {
  kind: 'codex',
  displayName: 'Codex',
  // cmux records Codex PermissionRequest hooks as telemetry: Codex's own reviewer may still
  // approve, so the hook alone does not prove the agent is waiting on the user.
  permissionHookBlocks: false,
  integrationNote: 'Hooks injected by the cmux Codex wrapper. Approvals stay in Codex; cmux reports them as telemetry only.',
  hooks: {
    ...COMMON_HOOKS,
    PermissionRequest: {
      state: null,
      activity: 'agent.permission_requested',
      describe: ({ tool }) => `Codex raised a permission check${toolSuffix(tool)} (handled inside Codex)`,
    },
  },
};

const DISPLAY_NAMES: Record<string, string> = {
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  amp: 'Amp',
  cursor: 'Cursor CLI',
  grok: 'Grok',
  pi: 'Pi',
  omp: 'OMP',
  kiro: 'Kiro CLI',
  copilot: 'Copilot CLI',
  antigravity: 'Antigravity',
  rovodev: 'Rovo Dev',
  'hermes-agent': 'Hermes Agent',
  codebuddy: 'CodeBuddy',
  factory: 'Factory Droid',
  qoder: 'Qoder',
  kimi: 'Kimi Code',
  muse: 'Muse Code',
  campfire: 'Campfire',
};

const DEFINITIONS = new Map<string, AgentDefinition>([
  ['claude', claude],
  ['codex', codex],
]);

export function agentDefinition(kind: string): AgentDefinition {
  const known = DEFINITIONS.get(kind);
  if (known) return known;
  const displayName = DISPLAY_NAMES[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
  const generic: AgentDefinition = {
    kind,
    displayName,
    permissionHookBlocks: true,
    integrationNote: 'Reported through the generic cmux agent-hook path; coverage depends on the agent plugin.',
    hooks: COMMON_HOOKS,
  };
  DEFINITIONS.set(kind, generic);
  return generic;
}

/** Map a state string from cmux's agent registry (`current.list`) onto a normalized state. */
export function normalizeRegistryState(state: string): AgentState {
  switch (state) {
    case 'working':
    case 'running':
    case 'thinking':
      return 'working';
    case 'needs_input':
    case 'needsInput':
    case 'blocked':
    case 'waiting':
      return 'needs_attention';
    case 'idle':
    case 'done':
      return 'idle';
    case 'ended':
    case 'exited':
      return 'ended';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return 'unknown';
  }
}

/**
 * cmux wraps hook session ids as `cmux-feed-v1:<base64 source>:<base64 session>`
 * (the Feed workstream id). Decode back to the agent's own session id so hook events
 * correlate with `current.list` entries.
 */
export function decodeWorkstreamId(id: string): { source: string; sessionId: string } | null {
  const m = /^cmux-feed-v1:([A-Za-z0-9+/=_-]+):([A-Za-z0-9+/=_-]+)$/.exec(id);
  if (!m) return null;
  try {
    const source = Buffer.from(m[1]!, 'base64').toString('utf8');
    const sessionId = Buffer.from(m[2]!, 'base64').toString('utf8');
    return source && sessionId ? { source, sessionId } : null;
  } catch {
    return null;
  }
}

export const agentKey = (kind: string, sessionId: string) => `${kind}:${sessionId}`;
