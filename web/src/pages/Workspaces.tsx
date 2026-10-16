import { useSearchParams } from 'react-router';
import { AppWindow, PanelsTopLeft } from 'lucide-react';
import type { MissionState, Workspace, WorkspaceSummary } from '../../../shared/types.ts';
import { useStale } from '../components/layout.tsx';
import { WorkspaceCard } from '../components/mission.tsx';
import { EmptyState, cx } from '../components/ui.tsx';
import { plural, useNow } from '../lib/format.ts';
import { HEALTH } from '../lib/status.ts';

const FILTERS: (WorkspaceSummary['health'] | 'all')[] = ['all', 'needs_attention', 'error', 'working', 'idle', 'quiet'];

function matchesQuery(ws: Workspace, m: MissionState, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const surfaces = ws.paneIds.flatMap((p) => m.panes[p]?.surfaceIds ?? []).map((id) => m.surfaces[id]);
  const agents = Object.values(m.agents).filter((a) => a.workspaceId === ws.id);
  return [ws.title, ws.id, ws.cwd, ws.projectRoot, ws.git?.branch, ...surfaces.map((s) => s?.title), ...agents.map((a) => a.displayName)]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

export function Workspaces({ m }: { m: MissionState }) {
  const now = useNow();
  const stale = useStale();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const health = (params.get('health') ?? 'all') as (typeof FILTERS)[number];
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v && v !== 'all') next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const total = Object.keys(m.workspaces).length;

  return (
    <div className={cx('mx-auto flex max-w-[1600px] flex-col gap-5', stale && 'stale-dim')}>
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-72" placeholder="Filter by name, branch, path, tab or agent" value={q} onChange={(e) => set('q', e.target.value)} aria-label="Filter workspaces" />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by health">
          {FILTERS.map((f) => (
            <button key={f} className={cx('btn h-7', health === f && 'btn-accent')} onClick={() => set('health', f)} aria-pressed={health === f}>
              {f === 'all' ? 'All' : HEALTH[f].label}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[11px] text-ink-3">{plural(total, 'workspace')} open</span>
      </div>

      {m.windowOrder.map((wid, i) => {
        const win = m.windows[wid]!;
        const list = win.workspaceIds
          .map((id) => m.workspaces[id]!)
          .filter(Boolean)
          .filter((ws) => matchesQuery(ws, m, q))
          .filter((ws) => health === 'all' || m.summaries[ws.id]?.health === health);
        return (
          <section key={wid} aria-label={`Window ${i + 1}`}>
            <h2 className="mb-2.5 flex items-center gap-2 font-mono text-[12px] text-ink-2">
              <AppWindow size={13} className="text-accent" /> Window {i + 1}
              <span className="text-ink-3">
                · {win.ref ?? win.id.slice(0, 8)} · {plural(win.workspaceIds.length, 'workspace')}
                {win.isKey && ' · focused'}
              </span>
            </h2>
            {list.length === 0 ? (
              <div className="panel px-4 py-5 text-[12px] text-ink-3">No workspaces in this window match the filter.</div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {list.map((ws) => (
                  <WorkspaceCard key={ws.id} ws={ws} m={m} now={now} />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {m.windowOrder.length === 0 && <EmptyState icon={<PanelsTopLeft size={22} />} title="No cmux windows are open" />}
    </div>
  );
}
