import { useState } from 'react';
import { Bot, Info } from 'lucide-react';
import type { AgentState, MissionState } from '../../../shared/types.ts';
import { useStale } from '../components/layout.tsx';
import { AgentTable } from '../components/mission.tsx';
import { Badge, EmptyState, Panel, cx } from '../components/ui.tsx';
import { plural, useNow } from '../lib/format.ts';
import { AGENT_STATE } from '../lib/status.ts';

const STATES: AgentState[] = ['working', 'needs_attention', 'idle', 'error', 'unknown', 'ended'];
const NOTES: Record<string, string> = {
  claude: 'Hooks are injected by cmux’s Claude wrapper. Permission prompts are actionable in cmux Feed.',
  codex: 'Hooks are injected by cmux’s Codex wrapper. Codex approvals stay inside Codex; cmux reports them as telemetry, so a Codex permission check alone does not mark it as waiting.',
};

export function Agents({ m }: { m: MissionState }) {
  const now = useNow();
  const stale = useStale();
  const [state, setState] = useState<AgentState | 'active' | 'all'>('active');
  const [kind, setKind] = useState('all');
  const all = Object.values(m.agents);
  const kinds = [...new Set(all.map((a) => a.kind))].sort();
  const list = all
    .filter((a) => (state === 'all' ? true : state === 'active' ? a.state !== 'ended' : a.state === state))
    .filter((a) => kind === 'all' || a.kind === kind)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const counts = Object.fromEntries(STATES.map((s) => [s, all.filter((a) => a.state === s).length]));

  return (
    <div className={cx('mx-auto flex max-w-[1600px] flex-col gap-5', stale && 'stale-dim')}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {STATES.map((s) => (
          <button key={s} className={cx('panel flex items-center justify-between px-4 py-3 text-left transition-colors hover:border-line-strong', state === s && 'border-accent/50')} onClick={() => setState(state === s ? 'active' : s)} aria-pressed={state === s}>
            <Badge meta={AGENT_STATE[s]} compact />
            <span className="font-mono text-[20px] text-ink">{counts[s]}</span>
          </button>
        ))}
      </div>

      <Panel
        title={`Agents (${list.length})`}
        icon={<Bot size={14} className="text-accent" />}
        actions={
          <>
            <select className="input h-7" value={state} onChange={(e) => setState(e.target.value as typeof state)} aria-label="Filter by state">
              <option value="active">Active (not ended)</option>
              <option value="all">All, including ended</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {AGENT_STATE[s].label}
                </option>
              ))}
            </select>
            <select className="input h-7" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by agent">
              <option value="all">All agents</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {all.find((a) => a.kind === k)?.displayName ?? k}
                </option>
              ))}
            </select>
          </>
        }
      >
        {list.length === 0 ? (
          <EmptyState icon={<Bot size={22} />} title={all.length ? 'No agents match these filters' : 'No AI agents detected'}>
            {all.length
              ? null
              : 'Agents appear when cmux reports them: Claude Code and Codex launched from a cmux terminal are detected automatically. A terminal without an agent is shown as a regular terminal on its workspace page.'}
          </EmptyState>
        ) : (
          <AgentTable agents={list} m={m} now={now} />
        )}
      </Panel>

      <Panel title="What the integrations can report" icon={<Info size={14} className="text-accent" />} bodyClass="p-4 text-[12px] leading-relaxed text-ink-2">
        <ul className="flex flex-col gap-2">
          {(kinds.length ? kinds : ['claude', 'codex']).map((k) => (
            <li key={k}>
              <span className="font-mono text-ink">{all.find((a) => a.kind === k)?.displayName ?? (k === 'claude' ? 'Claude Code' : k === 'codex' ? 'Codex' : k)}</span> — {NOTES[k] ?? 'Reported through the generic cmux agent-hook path; coverage depends on the agent’s cmux plugin.'}
            </li>
          ))}
          <li className="text-ink-3">
            States come from cmux’s agent registry (<code className="font-mono">current.list</code>), refreshed whenever a hook event arrives. “Idle” after a turn means the agent stopped generating — not that a task succeeded, and background work may continue. {plural(all.length, 'session')} known.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
