import { useState } from 'react';
import { Activity } from 'lucide-react';
import type { ActivityQuery, ActivitySeverity, MissionState } from '../../../shared/types.ts';
import { ActivityRow } from '../components/mission.tsx';
import { EmptyState, Panel } from '../components/ui.tsx';
import { useNow } from '../lib/format.ts';
import { markSeen, useLastSeen } from '../lib/seen.ts';
import { useActivity } from '../lib/useActivity.ts';

const KINDS: { value: string; label: string }[] = [
  { value: '', label: 'All event types' },
  { value: 'agent.*', label: 'Agent events' },
  { value: 'agent.permission_requested', label: 'Permission requests' },
  { value: 'agent.turn_completed', label: 'Turns completed' },
  { value: 'agent.turn_failed', label: 'Turns failed' },
  { value: 'workspace.*', label: 'Workspace lifecycle' },
  { value: 'surface.*', label: 'Tab lifecycle' },
  { value: 'program.*', label: 'Terminal program status' },
  { value: 'notification.created', label: 'Notifications' },
  { value: 'connection.*', label: 'Connection (gaps, restarts)' },
];

export function ActivityPage({ m }: { m: MissionState }) {
  const now = useNow();
  const [q, setQ] = useState<ActivityQuery>({ limit: 100 });
  const { entries, loading, error, exhausted, loadMore } = useActivity(q);
  const lastSeen = useLastSeen();
  const agents = Object.values(m.agents);
  const workspaces = Object.values(m.workspaces);
  const set = (patch: Partial<ActivityQuery>) => setQ((cur) => ({ ...cur, ...patch }));

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Activity filters">
        <select className="input" value={q.workspaceId ?? ''} onChange={(e) => set({ workspaceId: e.target.value || undefined })} aria-label="Workspace">
          <option value="">All workspaces</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.title}
            </option>
          ))}
        </select>
        <select className="input" value={q.agentKey ?? ''} onChange={(e) => set({ agentKey: e.target.value || undefined })} aria-label="Agent">
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.key} value={a.key}>
              {a.displayName} · {a.sessionId.slice(0, 10)}
            </option>
          ))}
        </select>
        <select className="input" value={q.kind ?? ''} onChange={(e) => set({ kind: e.target.value || undefined })} aria-label="Event type">
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <select className="input" value={q.severity ?? ''} onChange={(e) => set({ severity: (e.target.value || undefined) as ActivitySeverity | undefined })} aria-label="Status">
          <option value="">Any status</option>
          <option value="attention">Needs attention</option>
          <option value="error">Error</option>
          <option value="success">Success</option>
          <option value="info">Info</option>
        </select>
        <button className="btn ml-auto" onClick={() => markSeen()}>
          Mark all seen
        </button>
      </div>

      <Panel title="Timeline" icon={<Activity size={14} className="text-accent" />} actions={<span className="font-mono text-[10.5px] text-ink-3">latest first · live</span>}>
        {error ? (
          <div className="px-4 py-6 text-[12px] text-st-error">Could not load activity: {error}</div>
        ) : loading && entries.length === 0 ? (
          <div className="h-60 animate-pulse" />
        ) : entries.length === 0 ? (
          <EmptyState icon={<Activity size={22} />} title="No events match these filters">
            Mission Control records important cmux events (workspace and tab lifecycle, agent turns and permission requests, terminal errors) for 7 days, up to 10,000 entries.
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-line/60 py-1" data-testid="activity-list">
              {entries.map((e) => (
                <ActivityRow key={e.id} e={e} m={m} now={now} isNew={lastSeen !== null && e.at > lastSeen} />
              ))}
            </ul>
            <div className="border-t border-line px-4 py-2.5 text-center">
              {exhausted ? <span className="font-mono text-[11px] text-ink-3">End of retained history</span> : <button className="btn" onClick={() => void loadMore()}>Load older</button>}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
