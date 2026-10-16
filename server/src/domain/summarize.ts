// Workspace summaries. The MVP summarizer is deterministic and only restates structured
// facts. The `Summarizer` interface is the seam for a richer (e.g. opt-in LLM) implementation.
import type {
  ActivityEntry,
  AgentSession,
  AttentionItem,
  Kpis,
  MissionState,
  Surface,
  Workspace,
  WorkspaceSummary,
} from '../../../shared/types.ts';
import { describeAgent } from '../../../shared/describe.ts';

export { describeAgent };

export interface WorkspaceSummaryInput {
  workspace: Workspace;
  surfaces: Surface[];
  agents: AgentSession[];
  attention: AttentionItem[];
  latestActivity: ActivityEntry | null;
  now: number;
}

export interface Summarizer {
  summarizeWorkspace(input: WorkspaceSummaryInput): WorkspaceSummary;
}

export const deterministicSummarizer: Summarizer = {
  summarizeWorkspace({ workspace, surfaces, agents, attention, latestActivity, now }) {
    const live = agents.filter((a) => a.state !== 'ended');
    const top = attention[0];
    const working = live.filter((a) => a.state === 'working');
    const hasError =
      live.some((a) => a.state === 'error') || surfaces.some((s) => s.programStatus?.some((r) => r.state === 'error'));
    const programWorking = surfaces.some((s) => s.programStatus?.some((r) => r.state === 'working'));
    const lastActivityAt = Math.max(
      latestActivity?.at ?? 0,
      ...surfaces.map((s) => s.lastActivityAt ?? 0),
      ...agents.map((a) => a.lastActivityAt ?? 0),
    );

    let headline = 'No reported activity';
    let headlineSource: WorkspaceSummary['headlineSource'] = 'none';
    if (top && top.kind !== 'notification') {
      headline = top.title;
      headlineSource = 'agent';
    } else if (working[0]) {
      headline = describeAgent(working[0], now) + (working.length > 1 ? ` (+${working.length - 1} more)` : '');
      headlineSource = 'agent';
    } else if (programWorking) {
      headline = 'A terminal program reports it is working';
      headlineSource = 'program-status';
    } else if (top) {
      headline = top.title;
      headlineSource = 'notification';
    } else if (live[0]) {
      headline = describeAgent(live[0], now);
      headlineSource = 'agent';
    } else if (latestActivity) {
      headline = latestActivity.summary;
      headlineSource = 'activity';
    }

    const actionable = attention.filter((a) => a.kind !== 'notification');
    const health: WorkspaceSummary['health'] = actionable.some((a) => a.urgency >= 80)
      ? 'needs_attention'
      : hasError
        ? 'error'
        : working.length || programWorking
          ? 'working'
          : live.length
            ? 'idle'
            : 'quiet';

    return {
      workspaceId: workspace.id,
      health,
      headline,
      headlineSource,
      lastActivityAt: lastActivityAt > 0 ? lastActivityAt : null,
      attentionCount: attention.length,
      agentKeys: agents.map((a) => a.key),
    };
  },
};

export function computeKpis(state: Pick<MissionState, 'windows' | 'workspaces' | 'panes' | 'surfaces' | 'agents' | 'attention' | 'summaries'>, turns24h: number | null): Kpis {
  const surfaces = Object.values(state.surfaces);
  const agents = Object.values(state.agents).filter((a) => a.state !== 'ended');
  const errorWorkspaces = new Set<string>();
  for (const a of agents) if (a.state === 'error' && a.workspaceId) errorWorkspaces.add(a.workspaceId);
  for (const s of surfaces) if (s.programStatus?.some((r) => r.state === 'error')) errorWorkspaces.add(s.workspaceId);
  return {
    windows: Object.keys(state.windows).length,
    workspaces: Object.keys(state.workspaces).length,
    panes: Object.keys(state.panes).length,
    surfaces: surfaces.length,
    terminals: surfaces.filter((s) => s.type === 'terminal').length,
    agentsDetected: agents.length,
    agentsWorking: agents.filter((a) => a.state === 'working').length,
    agentsNeedingAttention: agents.filter((a) => a.state === 'needs_attention').length,
    attentionItems: state.attention.filter((a) => a.kind !== 'notification').length,
    turnsCompleted24h: turns24h,
    workspacesWithErrors: [...errorWorkspaces].filter((id) => state.workspaces[id]).length,
  };
}
