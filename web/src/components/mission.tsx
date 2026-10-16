import { Link } from 'react-router';
import { Bot, FileText, GitBranch, Globe, SquareTerminal, TerminalSquare } from 'lucide-react';
import type { ActivityEntry, AgentSession, AttentionItem, MissionState, Surface, Workspace } from '../../../shared/types.ts';
import { AGENT_STATE, ATTENTION, HEALTH, SEVERITY } from '../lib/status.ts';
import { clock, homePath, shortId, timeAgo } from '../lib/format.ts';
import { Badge, DotMeter, JumpButton, NotReported, cx } from './ui.tsx';

export function SurfaceIcon({ type, size = 13 }: { type: Surface['type']; size?: number }) {
  const Icon = type === 'browser' ? Globe : type === 'markdown' ? FileText : type === 'agent-session' ? Bot : type === 'terminal' ? SquareTerminal : TerminalSquare;
  return <Icon size={size} className="shrink-0 text-ink-3" aria-label={type} />;
}

export function AgentBadge({ agent }: { agent: AgentSession }) {
  return <Badge meta={AGENT_STATE[agent.state]} spin={agent.state === 'working'} compact />;
}

// ── Workspace card ───────────────────────────────────────────────────────────

export function WorkspaceCard({ ws, m, now }: { ws: Workspace; m: MissionState; now: number }) {
  const summary = m.summaries[ws.id];
  const surfaces = ws.paneIds.flatMap((p) => m.panes[p]?.surfaceIds ?? []).map((id) => m.surfaces[id]).filter((s): s is Surface => Boolean(s));
  const agents = Object.values(m.agents).filter((a) => a.workspaceId === ws.id && a.state !== 'ended');
  const health = summary ? HEALTH[summary.health] : HEALTH.quiet;
  const attention = m.attention.filter((a) => a.workspaceId === ws.id && a.kind !== 'notification').length;
  const isSelf = surfaces.some((s) => s.isMissionControl);
  return (
    <Link
      to={`/workspaces/${ws.id}`}
      className="panel group flex min-w-0 flex-col gap-3 p-4 transition-colors hover:border-line-strong"
      style={attention ? { borderColor: 'color-mix(in oklab, var(--color-st-attention) 40%, var(--color-line))' } : undefined}
      data-testid="workspace-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[13.5px] text-ink">{ws.title}</span>
            {isSelf && <span className="rounded border border-line-strong px-1 font-mono text-[9.5px] text-ink-3" title="Mission Control itself runs in this workspace">this app</span>}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-3" title={ws.id}>
            {ws.ref ?? 'workspace'} · {shortId(ws.id)}
          </div>
        </div>
        <Badge meta={health} compact spin={summary?.health === 'working'} />
      </div>

      <div className="flex min-w-0 items-center gap-3 text-[11.5px] text-ink-2">
        <span className="flex min-w-0 items-center gap-1 font-mono" title={ws.projectRoot ?? ws.cwd ?? undefined}>
          <GitBranch size={11} className="shrink-0 text-ink-3" />
          <span className="truncate">{ws.git?.branch ?? <span className="text-ink-3">no git branch</span>}</span>
        </span>
        <span className="truncate font-mono text-ink-3">{homePath(ws.projectRoot ?? ws.cwd) ?? ''}</span>
      </div>

      <div className="grid grid-cols-3 gap-2 border-y border-line py-2.5 font-mono text-[11px]">
        <Stat label="panes" value={ws.paneIds.length} />
        <Stat label="tabs" value={surfaces.length} />
        <Stat label="agents" value={agents.length} />
      </div>

      <div className="min-h-[34px] text-[12px] leading-snug">
        <div className={cx('line-clamp-2', summary?.headlineSource === 'none' ? 'text-ink-3' : 'text-ink')} data-testid="workspace-headline">
          {summary?.headline ?? 'No reported activity'}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <DotMeter
          filled={agents.filter((a) => a.state === 'working').length}
          total={surfaces.length}
          label={`${agents.filter((a) => a.state === 'working').length} working agents across ${surfaces.length} tabs`}
        />
        <span className="font-mono text-[10.5px] text-ink-3" title={summary?.lastActivityAt ? clock(summary.lastActivityAt) : 'No activity observed since Mission Control started watching'}>
          {summary?.lastActivityAt ? timeAgo(summary.lastActivityAt, now) : 'no activity seen'}
        </span>
      </div>
      {attention > 0 && <div className="-mt-1 font-mono text-[11px] text-st-attention">{attention === 1 ? '1 item needs' : `${attention} items need`} attention</div>}
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[15px] text-ink">{value}</div>
      <div className="text-[10px] text-ink-3">{label}</div>
    </div>
  );
}

// ── Attention ────────────────────────────────────────────────────────────────

export function AttentionRow({ item, m, now }: { item: AttentionItem; m: MissionState; now: number }) {
  const meta = ATTENTION[item.kind];
  const Icon = meta.icon;
  const ws = item.workspaceId ? m.workspaces[item.workspaceId] : undefined;
  const surface = item.surfaceId ? m.surfaces[item.surfaceId] : undefined;
  const agent = item.agentKey ? m.agents[item.agentKey] : undefined;
  return (
    <li className="row-hover flex gap-3 px-4 py-3" data-testid="attention-item">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg" style={{ color: meta.color, background: `color-mix(in oklab, ${meta.color} 12%, transparent)` }}>
        <Icon size={14} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] text-ink">{item.title}</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-3" title={clock(item.since)}>
            {timeAgo(item.since, now)}
          </span>
        </div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-ink-2">{item.reason}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-ink-3">
          <span className="text-ink-2">{ws?.title ?? 'Unknown workspace'}</span>
          {surface && <span>› {surface.title}</span>}
          {agent && <span>· {agent.displayName}</span>}
          <span title="Where this fact comes from">· {item.source}</span>
          <span className="ml-auto">
            {ws && (
              <JumpButton
                compact
                label="Jump"
                testId="attention-jump"
                target={surface ? { kind: 'surface', workspaceId: ws.id, surfaceId: surface.id } : { kind: 'workspace', workspaceId: ws.id }}
              />
            )}
          </span>
        </div>
      </div>
    </li>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────

export function ActivityRow({ e, m, now, isNew }: { e: ActivityEntry; m: MissionState | null; now: number; isNew?: boolean }) {
  const meta = SEVERITY[e.severity];
  const wsLive = e.workspaceId ? m?.workspaces[e.workspaceId] : undefined;
  return (
    <li className="row-hover grid grid-cols-[64px_14px_1fr] items-start gap-2.5 px-4 py-2" data-testid="activity-row">
      <span className="pt-px font-mono text-[10.5px] text-ink-3" title={new Date(e.at).toLocaleString()}>
        {clock(e.at)}
      </span>
      <span className="mt-[5px] size-2 rounded-full" style={{ background: meta.color }} aria-label={meta.label} title={meta.label} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[12px] text-ink">
          <span className="truncate">{e.summary}</span>
          {isNew && <span className="shrink-0 rounded bg-accent/15 px-1 font-mono text-[9.5px] text-accent">new</span>}
        </div>
        <div className="truncate font-mono text-[10.5px] text-ink-3">
          {e.workspaceTitle || wsLive?.title ? (
            wsLive ? (
              <Link className="text-ink-2 hover:text-accent" to={`/workspaces/${wsLive.id}`}>
                {wsLive.title}
              </Link>
            ) : (
              <span title="This workspace is no longer open">{e.workspaceTitle} (closed)</span>
            )
          ) : e.kind.startsWith('connection.') ? (
            'Mission Control'
          ) : (
            '—'
          )}
          {e.surfaceTitle && ` › ${e.surfaceTitle}`}
          {e.detail && ` · ${e.detail}`}
          {' · '}
          {timeAgo(e.at, now)}
        </div>
      </div>
    </li>
  );
}

// ── Agents table ─────────────────────────────────────────────────────────────

export function AgentTable({ agents, m, now, showWorkspace = true }: { agents: AgentSession[]; m: MissionState; now: number; showWorkspace?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-[12px]" data-testid="agent-table">
        <thead>
          <tr className="border-b border-line font-mono text-[11px] text-ink-3">
            <th className="px-4 py-2 font-normal">Agent</th>
            {showWorkspace && <th className="px-3 py-2 font-normal">Workspace › Tab</th>}
            <th className="px-3 py-2 font-normal">Status</th>
            <th className="px-3 py-2 font-normal">Latest known activity</th>
            <th className="px-3 py-2 font-normal">Last activity</th>
            <th className="px-3 py-2 font-normal">Turns</th>
            <th className="px-4 py-2 text-right font-normal">Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const ws = a.workspaceId ? m.workspaces[a.workspaceId] : undefined;
            const s = a.surfaceId ? m.surfaces[a.surfaceId] : undefined;
            return (
              <tr key={a.key} className="row-hover border-b border-line/60 last:border-0" data-testid="agent-row">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="grid size-7 place-items-center rounded-full border border-line-strong bg-raised font-mono text-[10px] text-ink-2">{a.displayName.slice(0, 2).toUpperCase()}</span>
                    <div className="min-w-0">
                      <div className="font-mono text-ink">{a.displayName}</div>
                      <div className="font-mono text-[10px] text-ink-3" title={a.sessionId}>
                        session {a.sessionId.slice(0, 12)}
                      </div>
                    </div>
                  </div>
                </td>
                {showWorkspace && (
                  <td className="max-w-[220px] px-3 py-2.5">
                    {ws ? (
                      <Link to={`/workspaces/${ws.id}`} className="block truncate font-mono text-ink-2 hover:text-accent">
                        {ws.title}
                        {s && <span className="text-ink-3"> › {s.title}</span>}
                      </Link>
                    ) : (
                      <NotReported>Not in an open workspace</NotReported>
                    )}
                  </td>
                )}
                <td className="px-3 py-2.5">
                  <div className="flex flex-col items-start gap-1">
                    <AgentBadge agent={a} />
                    <span className="font-mono text-[10px] text-ink-3" title={a.stateSource === 'cmux-registry' ? 'From cmux’s agent registry (current.list)' : 'From a live hook event, pending registry confirmation'}>
                      {a.sourceState}
                    </span>
                  </div>
                </td>
                <td className="max-w-[280px] px-3 py-2.5 text-ink-2">
                  {a.lastHook ? (
                    <span>
                      <span className="font-mono text-ink">{a.lastHook.name}</span>
                      {a.lastHook.toolName && <span> · {a.lastHook.toolName}</span>}
                      <span className="text-ink-3"> · {timeAgo(a.lastHook.at, now)}</span>
                    </span>
                  ) : (
                    <NotReported>No hook events seen yet</NotReported>
                  )}
                </td>
                <td className="px-3 py-2.5 font-mono text-ink-2">{timeAgo(a.lastActivityAt, now)}</td>
                <td className="px-3 py-2.5 font-mono text-ink-2" title="Turns that ended (Stop hook) while Mission Control was watching — not tasks">
                  {a.turnsCompleted}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {ws && s ? <JumpButton compact label="Focus" target={{ kind: 'surface', workspaceId: ws.id, surfaceId: s.id }} testId="agent-jump" /> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
