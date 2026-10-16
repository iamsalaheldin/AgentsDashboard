import {
  OctagonAlert,
  TriangleAlert,
  Bell,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CirclePause,
  CircleStop,
  HandHelping,
  KeyRound,
  ListChecks,
  Loader,
  MessageCircleQuestionMark,
  Moon,
  type LucideIcon,
} from 'lucide-react';
import type { ActivitySeverity, AgentState, AttentionKind, WorkspaceSummary } from '../../../shared/types.ts';

export interface StatusMeta {
  label: string;
  color: string;
  icon: LucideIcon;
}

export const AGENT_STATE: Record<AgentState, StatusMeta> = {
  working: { label: 'Working', color: 'var(--color-st-working)', icon: Loader },
  needs_attention: { label: 'Needs attention', color: 'var(--color-st-attention)', icon: HandHelping },
  idle: { label: 'Idle', color: 'var(--color-st-idle)', icon: CirclePause },
  ended: { label: 'Ended', color: 'var(--color-st-ended)', icon: CircleStop },
  error: { label: 'Error', color: 'var(--color-st-error)', icon: OctagonAlert },
  unknown: { label: 'Unknown', color: 'var(--color-st-unknown)', icon: CircleQuestionMark },
};

export const HEALTH: Record<WorkspaceSummary['health'], StatusMeta> = {
  needs_attention: { label: 'Needs attention', color: 'var(--color-st-attention)', icon: HandHelping },
  error: { label: 'Error', color: 'var(--color-st-error)', icon: OctagonAlert },
  working: { label: 'Working', color: 'var(--color-st-working)', icon: Loader },
  idle: { label: 'Idle', color: 'var(--color-st-idle)', icon: CirclePause },
  quiet: { label: 'Quiet', color: 'var(--color-st-ended)', icon: Moon },
};

export const ATTENTION: Record<AttentionKind, StatusMeta> = {
  permission: { label: 'Permission', color: 'var(--color-st-attention)', icon: KeyRound },
  question: { label: 'Question', color: 'var(--color-st-attention)', icon: MessageCircleQuestionMark },
  plan_approval: { label: 'Plan approval', color: 'var(--color-st-attention)', icon: ListChecks },
  needs_input: { label: 'Needs input', color: 'var(--color-st-attention)', icon: HandHelping },
  agent_error: { label: 'Agent error', color: 'var(--color-st-error)', icon: OctagonAlert },
  program_error: { label: 'Process error', color: 'var(--color-st-error)', icon: TriangleAlert },
  program_blocked: { label: 'Blocked', color: 'var(--color-st-attention)', icon: CircleDashed },
  notification: { label: 'Notification', color: 'var(--color-st-info)', icon: Bell },
};

export const SEVERITY: Record<ActivitySeverity, StatusMeta> = {
  info: { label: 'Info', color: 'var(--color-ink-3)', icon: CircleDashed },
  success: { label: 'Success', color: 'var(--color-st-working)', icon: CircleCheck },
  attention: { label: 'Attention', color: 'var(--color-st-attention)', icon: HandHelping },
  error: { label: 'Error', color: 'var(--color-st-error)', icon: OctagonAlert },
};
