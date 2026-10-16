import { Link } from 'react-router';
import { Activity, Bot, CircleCheck, HandHelping, OctagonAlert, PanelsTopLeft, SquareTerminal } from 'lucide-react';
import type { MissionState } from '../../../shared/types.ts';
import { ActivityChart } from '../components/ActivityChart.tsx';
import { useStale } from '../components/layout.tsx';
import { ActivityRow, AgentTable, AttentionRow, WorkspaceCard } from '../components/mission.tsx';
import { DotMeter, EmptyState, Kpi, Panel, cx } from '../components/ui.tsx';
import { clock, plural, useNow } from '../lib/format.ts';
import { markSeen, useLastSeen } from '../lib/seen.ts';
import { useActivity } from '../lib/useActivity.ts';
import { SetupGuide } from './Setup.tsx';

const STATE_ORDER = { needs_attention: 0, error: 1, working: 2, idle: 3, unknown: 4, ended: 5 } as const;

export function Overview({ m }: { m: MissionState }) {
  const now = useNow();
  const stale = useStale();
  const k = m.kpis;
  const workspaces = m.windowOrder.flatMap((w) => m.windows[w]?.workspaceIds ?? []).map((id) => m.workspaces[id]!).filter(Boolean);
  const agents = Object.values(m.agents)
    .filter((a) => a.state !== 'ended')
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const attention = m.attention;
  const lastSeen = useLastSeen();
  const { entries } = useActivity({ limit: 40 });
  const unseen = lastSeen ? entries.filter((e) => e.at > lastSeen).length : null;
  const neverConnected = !m.connection.lastSnapshotAt && workspaces.length === 0;

  if (neverConnected && m.connection.phase !== 'connecting') return <SetupGuide m={m} />;

  return (
    <div className={cx('mx-auto flex max-w-[1600px] flex-col gap-5', stale && 'stale-dim')}>
      <section className="panel grid grid-cols-1 divide-line sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 xl:divide-x" aria-label="Key metrics">
        <Kpi
          icon={<PanelsTopLeft size={14} />}
          label="Workspaces"
          value={k.workspaces}
          detail={`${plural(k.windows, 'window')} · ${plural(k.panes, 'pane')}`}
          definition="Open cmux workspaces across all windows (system.tree)."
        />
        <Kpi
          icon={<SquareTerminal size={14} />}
          label="Tabs"
          value={k.surfaces}
          detail={`${k.terminals} terminals · ${k.surfaces - k.terminals} other`}
          definition="Open surfaces (tabs) in all panes: terminals, browsers and other panels."
        />
        <Kpi
          icon={<Bot size={14} />}
          label="Active agents"
          value={k.agentsWorking}
          detail={`of ${plural(k.agentsDetected, 'detected agent')}`}
          definition="Agents cmux reports as working right now. Detected agents excludes ended sessions."
          meter={<DotMeter filled={k.agentsWorking} total={k.agentsDetected} max={12} label={`${k.agentsWorking} of ${k.agentsDetected} agents working`} />}
        />
        <Kpi
          icon={<HandHelping size={14} />}
          label="Needs attention"
          value={k.attentionItems}
          tone={k.attentionItems ? 'var(--color-st-attention)' : undefined}
          detail={k.agentsNeedingAttention ? `${plural(k.agentsNeedingAttention, 'agent')} waiting` : 'nothing waiting on you'}
          definition="Unresolved permission requests, questions, agents waiting for input, failed turns and terminal errors. Unread notifications are listed separately."
        />
        <Kpi
          icon={<CircleCheck size={14} />}
          label="Turns completed"
          value={k.turnsCompleted24h ?? <span className="text-ink-3">n/a</span>}
          detail="last 24 h · turns, not tasks"
          definition="Agent turns that ended (Stop hook) recorded in local history in the last 24 hours. A finished turn does not mean a task succeeded."
        />
        <Kpi
          icon={<OctagonAlert size={14} />}
          label="With errors"
          value={k.workspacesWithErrors}
          tone={k.workspacesWithErrors ? 'var(--color-st-error)' : undefined}
          detail="workspaces"
          definition="Workspaces with an agent in error state or a terminal program reporting an error (OSC 7501)."
        />
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel
            title="Workspaces"
            icon={<PanelsTopLeft size={14} className="text-accent" />}
            actions={
              <Link to="/workspaces" className="btn">
                View all
              </Link>
            }
            bodyClass="p-4"
          >
            {workspaces.length === 0 ? (
              <EmptyState icon={<PanelsTopLeft size={22} />} title="No workspaces open">
                cmux reports no open workspaces.
              </EmptyState>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {workspaces.map((ws) => (
                  <WorkspaceCard key={ws.id} ws={ws} m={m} now={now} />
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Agent activity" icon={<Bot size={14} className="text-accent" />} actions={<Link to="/agents" className="btn">All agents</Link>}>
            {agents.length === 0 ? (
              <EmptyState icon={<Bot size={22} />} title="No AI agents detected">
                cmux has not reported any agent sessions. Claude Code and Codex are detected automatically when launched from a cmux terminal; other agents need their cmux hooks (<code className="font-mono">cmux hooks setup</code>).
              </EmptyState>
            ) : (
              <AgentTable agents={agents} m={m} now={now} />
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel
            title="Attention Center"
            icon={<HandHelping size={14} className="text-st-attention" />}
            actions={
              <Link to="/attention" className="btn">
                {attention.length ? `All ${attention.length}` : 'Open'}
              </Link>
            }
          >
            {attention.length === 0 ? (
              <EmptyState icon={<CircleCheck size={22} />} title="Nothing needs you right now">
                Permission requests, questions, waiting agents and errors appear here as soon as cmux reports them.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line" data-testid="attention-list">
                {attention.slice(0, 6).map((a) => (
                  <AttentionRow key={a.id} item={a} m={m} now={now} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Activity · 24 h" icon={<Activity size={14} className="text-accent" />}>
            <ActivityChart />
          </Panel>

          <Panel
            title="Recent activity"
            icon={<Activity size={14} className="text-accent" />}
            actions={
              <>
                {unseen !== null && unseen > 0 && <span className="font-mono text-[10.5px] text-accent">{unseen} new since {clock(lastSeen)}</span>}
                <button className="btn" onClick={() => markSeen()} title="Mark the timeline as seen (does not resolve attention items)">
                  Mark seen
                </button>
              </>
            }
          >
            {entries.length === 0 ? (
              <EmptyState icon={<Activity size={22} />} title="No activity recorded yet" />
            ) : (
              <ul className="divide-y divide-line/60 py-1">
                {entries.slice(0, 10).map((e) => (
                  <ActivityRow key={e.id} e={e} m={m} now={now} isNew={lastSeen !== null && e.at > lastSeen} />
                ))}
              </ul>
            )}
            <div className="border-t border-line px-4 py-2 text-right">
              <Link to="/activity" className="font-mono text-[11px] text-ink-2 hover:text-accent">
                Full timeline →
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
