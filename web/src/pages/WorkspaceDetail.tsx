import { Link, useParams } from 'react-router';
import { Activity, ArrowLeft, Bot, Columns2, ExternalLink, GitBranch, Radio } from 'lucide-react';
import type { AgentSession, MissionState, ProgramStatusRecord, Surface } from '../../../shared/types.ts';
import { useStale } from '../components/layout.tsx';
import { ActivityRow, AgentBadge, AttentionRow, SurfaceIcon } from '../components/mission.tsx';
import { Badge, EmptyState, Field, JumpButton, NotReported, Panel, cx } from '../components/ui.tsx';
import { describeAgent } from '../../../shared/describe.ts';
import { clock, homePath, plural, timeAgo, useNow } from '../lib/format.ts';
import { ATTENTION, HEALTH } from '../lib/status.ts';
import { useActivity } from '../lib/useActivity.ts';

const PROGRAM_LABEL: Record<ProgramStatusRecord['state'], string> = { working: 'working', blocked: 'blocked', error: 'error', done: 'done', idle: 'idle' };

function ProgramStatus({ records }: { records: ProgramStatusRecord[] | null }) {
  if (records === null) return <NotReported>Unknown since reconnect</NotReported>;
  const visible = records.filter((r) => r.state !== 'idle');
  if (!visible.length) return <span className="text-ink-3">none reported</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {visible.map((r, i) => (
        <span key={i} className={cx('rounded border px-1.5 font-mono text-[10.5px]', r.state === 'error' ? 'border-st-error/40 text-st-error' : r.state === 'blocked' ? 'border-st-attention/40 text-st-attention' : 'border-line-strong text-ink-2')}>
          {PROGRAM_LABEL[r.state]}
          {r.progress !== null && ` ${Math.round(r.progress * 100)}%`}
        </span>
      ))}
    </span>
  );
}

function SurfaceRow({ s, m, agents, now }: { s: Surface; m: MissionState; agents: AgentSession[]; now: number }) {
  const att = m.attention.filter((a) => a.surfaceId === s.id);
  return (
    <div className="grid grid-cols-1 gap-3 border-t border-line px-4 py-3 first:border-t-0 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1fr)_auto]" data-testid="surface-row">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <SurfaceIcon type={s.type} />
          <span className="truncate font-mono text-[12.5px] text-ink" title={s.title}>
            {s.title}
          </span>
          {s.selectedInPane && <span className="rounded bg-raised px-1 font-mono text-[9.5px] text-ink-3" title="Selected tab in this pane">selected</span>}
          {s.isMissionControl && <span className="rounded bg-accent/10 px-1 font-mono text-[9.5px] text-accent">this app</span>}
        </div>
        <div className="mt-0.5 truncate pl-5 font-mono text-[10.5px] text-ink-3">
          {s.rawType}
          {s.tty && ` · ${s.tty}`}
          {s.url && ` · ${s.url}`} · {s.ref ?? s.id.slice(0, 8)}
        </div>
      </div>

      <div className="min-w-0 text-[12px]">
        {agents.length === 0 ? (
          <div className="text-ink-3">{s.type === 'terminal' ? 'No agent detected — regular terminal' : `No agent — ${s.type} tab`}</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {agents.map((a) => (
              <div key={a.key} className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono text-ink">{a.displayName}</span>
                <AgentBadge agent={a} />
                <span className="truncate text-ink-2">{describeAgent(a, now)}</span>
              </div>
            ))}
          </div>
        )}
        {att.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {att.map((a) => (
              <Badge key={a.id} meta={{ ...ATTENTION[a.kind], label: a.title }} compact />
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11.5px]">
        <Field label="Program status" mono={false}>
          <ProgramStatus records={s.programStatus} />
        </Field>
        <Field label="Last activity">
          <span title={s.lastActivityAt ? clock(s.lastActivityAt) : 'No events seen for this tab since Mission Control started'}>{s.lastActivityAt ? timeAgo(s.lastActivityAt, now) : '—'}</span>
        </Field>
      </div>

      <div className="flex items-start justify-end">
        <JumpButton compact label="Focus tab" target={{ kind: 'surface', workspaceId: s.workspaceId, surfaceId: s.id }} testId="surface-jump" />
      </div>
    </div>
  );
}

export function WorkspaceDetail({ m }: { m: MissionState }) {
  const { id = '' } = useParams();
  const now = useNow();
  const stale = useStale();
  const ws = m.workspaces[id];
  const { entries, loading } = useActivity({ workspaceId: id, limit: 30 });

  if (!ws) {
    return (
      <div className="mx-auto max-w-3xl">
        <Link to="/workspaces" className="btn mb-4">
          <ArrowLeft size={12} /> All workspaces
        </Link>
        <Panel>
          <EmptyState icon={<Columns2 size={22} />} title="Workspace not open">
            cmux does not report a workspace with id <code className="font-mono">{id}</code>. It may have been closed.
          </EmptyState>
          {entries.length > 0 && (
            <ul className="divide-y divide-line/60 border-t border-line py-1">
              {entries.map((e) => (
                <ActivityRow key={e.id} e={e} m={m} now={now} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    );
  }

  const summary = m.summaries[ws.id];
  const win = m.windows[ws.windowId];
  const windowIndex = m.windowOrder.indexOf(ws.windowId);
  const agentsBySurface = new Map<string, AgentSession[]>();
  for (const a of Object.values(m.agents)) {
    if (a.workspaceId !== ws.id || !a.surfaceId) continue;
    agentsBySurface.set(a.surfaceId, [...(agentsBySurface.get(a.surfaceId) ?? []), a]);
  }
  const attention = m.attention.filter((a) => a.workspaceId === ws.id);
  const surfaceCount = ws.paneIds.reduce((n, p) => n + (m.panes[p]?.surfaceIds.length ?? 0), 0);

  return (
    <div className={cx('mx-auto flex max-w-[1500px] flex-col gap-5', stale && 'stale-dim')}>
      <div className="flex items-center gap-2 font-mono text-[11.5px] text-ink-3">
        <Link to="/workspaces" className="hover:text-ink">
          Workspaces
        </Link>
        <span>›</span>
        <span>Window {windowIndex + 1}</span>
        <span>›</span>
        <span className="text-ink-2">{ws.title}</span>
      </div>

      <section className="panel flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h2 className="truncate font-mono text-[20px] text-ink" data-testid="workspace-title">
                {ws.title}
              </h2>
              {summary && <Badge meta={HEALTH[summary.health]} spin={summary.health === 'working'} />}
              {ws.selected && <span className="font-mono text-[10.5px] text-ink-3">selected in window</span>}
            </div>
            <div className="mt-1 text-[12.5px] text-ink-2">{summary?.headline ?? 'No reported activity'}</div>
          </div>
          <JumpButton target={{ kind: 'workspace', workspaceId: ws.id }} testId="workspace-jump" />
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
          <Field label="Workspace ID">
            <span title={ws.id}>{ws.id}</span>
          </Field>
          <Field label="Window">{win ? `${win.ref ?? 'window'} · ${win.id.slice(0, 8)}` : '—'}</Field>
          <Field label="Directory">{homePath(ws.projectRoot ?? ws.cwd) ?? <NotReported />}</Field>
          <Field label="Git branch">
            {ws.git?.branch ? (
              <span className="inline-flex items-center gap-1">
                <GitBranch size={11} />
                {ws.git.branch}
                {ws.git.dirty && ' *'}
              </span>
            ) : (
              <NotReported>Not a git repo / not reported</NotReported>
            )}
          </Field>
          <Field label="Structure">
            {plural(ws.paneIds.length, 'pane')} · {plural(surfaceCount, 'tab')}
          </Field>
          <Field label="Ports">{ws.listeningPorts.length ? ws.listeningPorts.join(', ') : <span className="text-ink-3">none</span>}</Field>
          <Field label="Last activity">{summary?.lastActivityAt ? timeAgo(summary.lastActivityAt, now) : '—'}</Field>
        </div>
        {(ws.pullRequestUrls.length > 0 || ws.statusPills.length > 0 || ws.latestPrompt || ws.hasSubmittedPrompt) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[11.5px]">
            {ws.statusPills.map((p) => (
              <span key={p.key} className="rounded-full border border-line-strong px-2 py-0.5 font-mono text-[10.5px] text-ink-2" title={`Sidebar status “${p.key}”, updated ${timeAgo(p.updatedAt, now)}`}>
                <span className="mr-1 inline-block size-1.5 rounded-full" style={{ background: p.color ?? 'var(--color-ink-3)' }} />
                {p.key}: {p.value}
              </span>
            ))}
            {ws.pullRequestUrls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline">
                <ExternalLink size={11} /> {u.replace(/^https?:\/\//, '')}
              </a>
            ))}
            {ws.latestPrompt ? (
              <span className="min-w-0 truncate text-ink-2" title="Latest submitted prompt (prompt previews are enabled in Settings)">
                <span className="eyebrow mr-1.5">Latest prompt</span>“{ws.latestPrompt.text}”
              </span>
            ) : ws.hasSubmittedPrompt ? (
              <span className="text-ink-3">
                <span className="eyebrow mr-1.5">Latest prompt</span>hidden — enable prompt previews in <Link to="/settings" className="underline">Settings</Link>
              </span>
            ) : null}
          </div>
        )}
      </section>

      {attention.length > 0 && (
        <Panel title={`Needs attention (${attention.length})`} icon={<Radio size={14} className="text-st-attention" />}>
          <ul className="divide-y divide-line">
            {attention.map((a) => (
              <AttentionRow key={a.id} item={a} m={m} now={now} />
            ))}
          </ul>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-4" aria-label="Panes and tabs">
          {ws.paneIds.map((pid, i) => {
            const pane = m.panes[pid];
            if (!pane) return null;
            return (
              <Panel
                key={pid}
                title={
                  <span>
                    Pane {i + 1} <span className="text-ink-3">· {pane.ref ?? pid.slice(0, 8)} · {plural(pane.surfaceIds.length, 'tab')}</span>
                  </span>
                }
                icon={<Columns2 size={14} className="text-accent" />}
                actions={pane.focused ? <span className="font-mono text-[10.5px] text-ink-3">focused pane</span> : null}
              >
                {pane.surfaceIds.map((sid) => {
                  const s = m.surfaces[sid];
                  return s ? <SurfaceRow key={sid} s={s} m={m} agents={agentsBySurface.get(sid) ?? []} now={now} /> : null;
                })}
              </Panel>
            );
          })}
        </div>
        <Panel title="Workspace activity" icon={<Activity size={14} className="text-accent" />}>
          {loading && entries.length === 0 ? (
            <div className="h-40 animate-pulse" />
          ) : entries.length === 0 ? (
            <EmptyState icon={<Bot size={22} />} title="No activity recorded for this workspace" />
          ) : (
            <ul className="divide-y divide-line/60 py-1">
              {entries.map((e) => (
                <ActivityRow key={e.id} e={e} m={m} now={now} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
