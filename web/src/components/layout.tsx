import { useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { Activity, Bot, ChevronsLeft, FlaskConical, HandHelping, LayoutGrid, PanelsTopLeft, Search, Settings, Unplug } from 'lucide-react';
import { useBackend, useMission } from '../lib/store.ts';
import { clock, timeAgo, useNow } from '../lib/format.ts';
import { cx } from './ui.tsx';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/workspaces', label: 'Workspaces', icon: PanelsTopLeft },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/attention', label: 'Attention', icon: HandHelping, badge: true },
  { to: '/activity', label: 'Activity', icon: Activity },
];

const TITLES: Record<string, string> = {
  '': 'Overview',
  workspaces: 'Workspaces',
  agents: 'Agents',
  attention: 'Attention',
  activity: 'Activity',
  settings: 'Settings',
};

function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
      {[0, 1, 2].flatMap((r) =>
        [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={2 + c * 7.3} y={2 + r * 7.3} width="5.4" height="5.4" rx="1.2" fill="var(--color-accent)" opacity={(r + c) % 2 === 0 ? 1 : 0.4} />),
      )}
    </svg>
  );
}

function ConnectionCard({ collapsed }: { collapsed: boolean }) {
  const m = useMission();
  const backend = useBackend();
  const now = useNow(2000);
  const c = m?.connection;
  const live = backend === 'open' && c?.phase === 'live';
  const color = live ? 'var(--color-st-working)' : c?.phase === 'resyncing' || c?.phase === 'connecting' ? 'var(--color-st-attention)' : 'var(--color-st-error)';
  const label = backend === 'lost' ? 'Backend offline' : !c ? 'Connecting…' : live ? 'Live' : c.phase === 'resyncing' ? 'Resyncing' : c.phase === 'connecting' ? 'Connecting' : c.phase === 'reconnecting' ? 'Reconnecting' : 'Unavailable';
  if (collapsed) return <span className="mx-auto block size-2.5 rounded-full pulse" style={{ background: color }} title={label} />;
  return (
    <NavLink to="/settings" className="panel block px-3 py-2.5 transition-colors hover:border-line-strong" data-testid="connection-card">
      <div className="eyebrow mb-1.5">cmux connection</div>
      <div className="flex items-center gap-2 font-mono text-[12px]" style={{ color }}>
        <span className={cx('size-2 rounded-full', live && 'pulse')} style={{ background: color }} />
        {label}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10.5px] text-ink-3">
        <span>{c?.cmuxVersion ? `v${c.cmuxVersion}` : '—'}</span>
        <span title={c?.lastFrameAt ? clock(c.lastFrameAt) : undefined}>{c?.lastFrameAt ? timeAgo(c.lastFrameAt, now) : 'no frames'}</span>
      </div>
    </NavLink>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const m = useMission();
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900);
  const loc = useLocation();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const section = loc.pathname.split('/')[1] ?? '';
  const attention = m?.attention.filter((a) => a.kind !== 'notification').length ?? 0;

  return (
    <div className="flex h-full">
      <aside className={cx('flex shrink-0 flex-col border-r border-line bg-panel/60 transition-[width]', collapsed ? 'w-14' : 'w-[220px]')}>
        <div className="flex h-14 items-center justify-between border-b border-line px-3">
          <div className="flex items-center gap-2.5">
            <Logo />
            {!collapsed && (
              <div className="leading-tight">
                <div className="font-mono text-[12px] text-ink">Mission Control</div>
                <div className="font-mono text-[10px] text-ink-3">for cmux</div>
              </div>
            )}
          </div>
          <button className="text-ink-3 hover:text-ink" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <ChevronsLeft size={15} className={cx('transition-transform', collapsed && 'rotate-180')} />
          </button>
        </div>
        <nav className="flex flex-col gap-0.5 p-2" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[12.5px] text-ink-2 transition-colors hover:text-ink', isActive && 'nav-active')}>
              <Icon size={14} />
              {!collapsed && <span>{label}</span>}
              {badge && attention > 0 && (
                <span className={cx('rounded-full bg-st-attention/15 px-1.5 font-mono text-[10px] text-st-attention', collapsed ? 'absolute ml-5 -mt-4' : 'ml-auto')} data-testid="attention-badge">
                  {attention}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mx-3 my-1 border-t border-dashed border-line" />
        <nav className="p-2" aria-label="Configuration">
          <NavLink to="/settings" className={({ isActive }) => cx('flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[12.5px] text-ink-2 hover:text-ink', isActive && 'nav-active')}>
            <Settings size={14} />
            {!collapsed && 'Settings'}
          </NavLink>
        </nav>
        <div className="mt-auto p-3">
          <ConnectionCard collapsed={collapsed} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line px-4 md:px-6">
          <h1 className="font-mono text-[17px] tracking-tight text-ink">[{TITLES[section] ?? 'Workspace'}]</h1>
          <form
            className="relative"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              nav(`/workspaces?q=${encodeURIComponent(q)}`);
            }}
          >
            <Search size={13} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" />
            <input className="input w-40 pl-8 sm:w-64" placeholder="Search workspaces, tabs, agents…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search workspaces" />
          </form>
        </header>
        <ConnectionBanner />
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">{children}</main>
      </div>
    </div>
  );
}

/** Explains, in place, whenever displayed data may not reflect cmux right now. */
export function ConnectionBanner() {
  const m = useMission();
  const backend = useBackend();
  const now = useNow(2000);
  if (backend === 'lost') {
    return (
      <Banner tone="error" icon={<Unplug size={14} />} testId="banner-backend">
        Lost connection to the Mission Control backend. Data below is frozen{m ? ` as of ${clock(m.generatedAt)}` : ''} — retrying automatically.
      </Banner>
    );
  }
  if (!m) return null;
  const c = m.connection;
  const fixture = m.fixtureMode ? (
    <Banner tone="info" icon={<FlaskConical size={14} />} testId="banner-fixture">
      Test mode: connected to a fake cmux socket (MC_TEST_FAKE_CMUX=1). Nothing shown here is from your real cmux.
    </Banner>
  ) : null;
  if (c.phase === 'live') return fixture;
  const age = c.lastSnapshotAt ? ` Last good snapshot ${timeAgo(c.lastSnapshotAt, now)} (${clock(c.lastSnapshotAt)}).` : '';
  let text: ReactNode;
  switch (c.problem) {
    case 'access_denied':
      text = <>cmux refused the connection (socket mode “cmuxOnly”). Start Mission Control from a cmux terminal: <code className="font-mono">npm start</code>. Mission Control never changes cmux’s socket setting.</>;
      break;
    case 'not_installed':
      text = <>cmux was not found on this Mac. Install it from cmux.com, open it, then start Mission Control from a cmux terminal.</>;
      break;
    case 'not_running':
      text = <>cmux is not running (no socket at <code className="font-mono">{c.socketPath}</code>). Open cmux — Mission Control reconnects automatically.{age}</>;
      break;
    case 'stream_stalled':
      text = <>cmux stopped sending heartbeats; reconnecting.{age}</>;
      break;
    default:
      text =
        c.phase === 'resyncing' ? (
          <>Resynchronizing with cmux{c.gapDetectedAt ? ' after missed events' : ''}…</>
        ) : c.phase === 'connecting' ? (
          <>Connecting to cmux…</>
        ) : (
          <>Connection to cmux lost ({c.message ?? 'unknown reason'}); retrying.{age}</>
        );
  }
  const tone = c.phase === 'resyncing' || c.phase === 'connecting' ? 'warn' : 'error';
  return (
    <>
      {fixture}
      <Banner tone={tone} icon={<Unplug size={14} />} testId="banner-connection">
        {text} {c.phase !== 'connecting' && c.phase !== 'resyncing' && <strong className="font-medium">Data shown may be stale.</strong>}
      </Banner>
    </>
  );
}

function Banner({ tone, icon, children, testId }: { tone: 'error' | 'warn' | 'info'; icon: ReactNode; children: ReactNode; testId: string }) {
  const color = tone === 'error' ? 'var(--color-st-error)' : tone === 'warn' ? 'var(--color-st-attention)' : 'var(--color-st-info)';
  return (
    <div role="alert" data-testid={testId} className="flex items-start gap-2.5 border-b px-6 py-2 text-[12px]" style={{ color, borderColor: `color-mix(in oklab, ${color} 30%, transparent)`, background: `color-mix(in oklab, ${color} 8%, transparent)` }}>
      <span className="mt-px">{icon}</span>
      <span className="text-ink-2 [&_strong]:text-ink">{children}</span>
    </div>
  );
}

/** Wrap page content so stale data is visibly de-emphasized rather than presented as live. */
export function useStale(): boolean {
  const m = useMission();
  const backend = useBackend();
  return backend === 'lost' || !m || m.connection.stale;
}
