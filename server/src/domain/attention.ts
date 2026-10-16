// Builds the Attention Center from already-normalized state. Pure and deterministic:
// an item exists exactly as long as its source condition holds in cmux.
import type { AgentSession, AttentionItem, AttentionKind, Surface, Workspace } from '../../../shared/types.ts';
import type { RawNotification } from '../cmux/schemas.ts';
import { agentDefinition } from './agents/index.ts';

export const URGENCY: Record<AttentionKind, number> = {
  permission: 100,
  question: 95,
  plan_approval: 90,
  needs_input: 80,
  agent_error: 70,
  program_error: 60,
  program_blocked: 50,
  notification: 20,
};

export interface PendingFeedItem {
  id: string;
  kind: 'permission' | 'question' | 'plan_approval';
  requestId: string | null;
  toolName: string | null;
  agentKind: string | null;
  agentKey: string | null;
  workspaceId: string | null;
  surfaceId: string | null;
  since: number;
}

export interface AttentionInput {
  agents: AgentSession[];
  pendingFeed: PendingFeedItem[];
  surfaces: Record<string, Surface>;
  workspaces: Record<string, Workspace>;
  notifications: RawNotification[];
}

const ts = (iso: string | null | undefined, fallback: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

export function feedKind(kind: string): PendingFeedItem['kind'] | null {
  if (/permission/i.test(kind)) return 'permission';
  if (/question/i.test(kind)) return 'question';
  if (/plan/i.test(kind)) return 'plan_approval';
  return null;
}

export function buildAttention(input: AttentionInput, now = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];
  // Surfaces (or agents) that already have a specific item; less specific sources for the
  // same target are suppressed so one unresolved event never shows up twice.
  const coveredSurfaces = new Set<string>();
  const coveredAgents = new Set<string>();
  const cover = (it: AttentionItem) => {
    if (it.surfaceId) coveredSurfaces.add(it.surfaceId);
    if (it.agentKey) coveredAgents.add(it.agentKey);
    items.push(it);
  };

  for (const f of input.pendingFeed) {
    const agentName = f.agentKind ? agentDefinition(f.agentKind).displayName : 'An agent';
    const what = f.kind === 'permission' ? 'Permission request' : f.kind === 'question' ? 'Question' : 'Plan approval';
    cover({
      id: `feed:${f.id}`,
      kind: f.kind,
      urgency: URGENCY[f.kind],
      workspaceId: f.workspaceId,
      surfaceId: f.surfaceId,
      agentKey: f.agentKey,
      agentKind: f.agentKind,
      title: f.toolName && f.kind === 'permission' ? `${what}: ${f.toolName}` : what,
      reason:
        f.kind === 'permission'
          ? `${agentName} is waiting for permission${f.toolName ? ` to use ${f.toolName}` : ''}. Answer in cmux Feed or the terminal.`
          : f.kind === 'question'
            ? `${agentName} asked a question and is waiting for an answer.`
            : `${agentName} finished planning and is waiting for plan approval.`,
      since: f.since,
      source: 'cmux Feed (feed.list)',
    });
  }

  for (const a of input.agents) {
    if (coveredAgents.has(a.key) || (a.surfaceId && coveredSurfaces.has(a.surfaceId))) continue;
    const def = agentDefinition(a.kind);
    if (a.state === 'needs_attention') {
      const viaPermissionHook = a.lastHook?.name === 'PermissionRequest';
      cover({
        id: `agent:${a.key}:needs_input`,
        kind: 'needs_input',
        urgency: URGENCY.needs_input,
        workspaceId: a.workspaceId,
        surfaceId: a.surfaceId,
        agentKey: a.key,
        agentKind: a.kind,
        title: viaPermissionHook ? 'Waiting on a permission prompt' : 'Waiting for input',
        reason: `${def.displayName} reported that it needs your input (${a.sourceState}).`,
        since: a.stateSince ?? a.lastActivityAt ?? now,
        source: a.stateSource === 'cmux-registry' ? 'cmux agent registry (current.list)' : `agent hook ${a.lastHook?.name ?? ''}`.trim(),
      });
    } else if (a.state === 'error') {
      cover({
        id: `agent:${a.key}:error`,
        kind: 'agent_error',
        urgency: URGENCY.agent_error,
        workspaceId: a.workspaceId,
        surfaceId: a.surfaceId,
        agentKey: a.key,
        agentKind: a.kind,
        title: 'Agent turn failed',
        reason: `${def.displayName} reported a failed turn (${a.sourceState}).`,
        since: a.stateSince ?? now,
        source: `agent hook ${a.lastHook?.name ?? a.sourceState}`,
      });
    }
  }

  for (const s of Object.values(input.surfaces)) {
    if (!s.programStatus || coveredSurfaces.has(s.id)) continue;
    const err = s.programStatus.find((r) => r.state === 'error');
    const blocked = s.programStatus.find((r) => r.state === 'blocked');
    const rec = err ?? blocked;
    if (!rec) continue;
    cover({
      id: `program:${s.id}:${rec.id || 'root'}:${rec.state}`,
      kind: err ? 'program_error' : 'program_blocked',
      urgency: err ? URGENCY.program_error : URGENCY.program_blocked,
      workspaceId: s.workspaceId,
      surfaceId: s.id,
      agentKey: null,
      agentKind: null,
      title: err ? 'Process reported an error' : 'Process is blocked',
      reason: err
        ? 'A program in this terminal reported state "error" via OSC 7501. It clears when you focus the pane in cmux.'
        : 'A program in this terminal reported state "blocked" via OSC 7501 (usually waiting for input).',
      since: rec.updatedAt,
      source: 'program status (OSC 7501)',
    });
  }

  for (const n of input.notifications) {
    if (n.is_read) continue;
    if (n.surface_id && coveredSurfaces.has(n.surface_id)) continue;
    const title = [n.title, n.subtitle].filter(Boolean).join(' — ') || 'Notification';
    cover({
      id: `notification:${n.id}`,
      kind: 'notification',
      urgency: URGENCY.notification,
      workspaceId: n.workspace_id ?? null,
      surfaceId: n.surface_id ?? null,
      agentKey: null,
      agentKind: null,
      title,
      reason: n.body ? n.body.slice(0, 200) : 'Unread cmux notification.',
      since: ts(n.created_at, now),
      source: 'cmux notifications (notification.list)',
    });
  }

  return items.sort((a, b) => b.urgency - a.urgency || b.since - a.since);
}
