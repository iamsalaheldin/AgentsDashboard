// Deterministic, fact-only description of an agent's state. Shared by server summaries
// and the UI so both say exactly the same thing.
import type { AgentSession } from './types.ts';

const RECENT_TOOL_MS = 2 * 60_000;

export function describeAgent(a: AgentSession, now: number): string {
  const name = a.displayName;
  switch (a.state) {
    case 'working': {
      const tool = a.lastHook?.toolName && now - a.lastHook.at < RECENT_TOOL_MS ? a.lastHook.toolName : null;
      return tool ? `${name} is working · last tool: ${tool}` : `${name} is working`;
    }
    case 'needs_attention':
      return a.pendingPermission
        ? `${name} requested permission${a.pendingPermission.toolName ? ` (${a.pendingPermission.toolName})` : ''}`
        : `${name} is waiting for input`;
    case 'idle':
      return a.turnsCompleted > 0 || a.lastHook?.name === 'Stop' ? `${name} finished its turn · idle` : `${name} is idle`;
    case 'ended':
      return `${name} session ended`;
    case 'error':
      return `${name} turn failed`;
    default:
      return `${name} state unknown (${a.sourceState})`;
  }
}
