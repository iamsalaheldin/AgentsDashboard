import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Info, LoaderCircle } from 'lucide-react';
import type { NavigateRequest } from '../../../shared/types.ts';
import { navigate } from '../lib/api.ts';
import type { StatusMeta } from '../lib/status.ts';
import { useMission } from '../lib/store.ts';
import { toast } from './toast.tsx';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

/** Status pill: icon + label + color, so state is never conveyed by color alone. */
export function Badge({ meta, compact, spin }: { meta: StatusMeta; compact?: boolean; spin?: boolean }) {
  const Icon = meta.icon;
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-mono', compact ? 'px-1.5 py-px text-[10px]' : 'px-2 py-0.5 text-[11px]')}
      style={{
        color: meta.color,
        borderColor: `color-mix(in oklab, ${meta.color} 45%, transparent)`,
        background: `color-mix(in oklab, ${meta.color} 10%, transparent)`,
      }}
    >
      <Icon size={compact ? 10 : 11} className={spin ? 'animate-spin [animation-duration:2.4s]' : undefined} aria-hidden />
      {meta.label}
    </span>
  );
}

export function Panel({ title, icon, actions, children, className, bodyClass }: { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('panel flex min-w-0 flex-col', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 font-mono text-[12.5px] text-ink">
            {icon}
            {title}
          </h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('min-h-0 flex-1', bodyClass)}>{children}</div>
    </section>
  );
}

/** Dot-matrix meter: one square per item, filled when counted. Only used for real counts. */
export function DotMeter({ filled, total, color = 'var(--color-accent)', max = 40, label }: { filled: number; total: number; color?: string; max?: number; label: string }) {
  const n = Math.min(total, max);
  const f = total > max ? Math.round((filled / total) * max) : filled;
  return (
    <div className="flex flex-wrap gap-[3px]" role="img" aria-label={label} title={label}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="size-[7px] rounded-[2px]" style={{ background: i < f ? color : 'var(--color-line-strong)', opacity: i < f ? 1 : 0.7 }} />
      ))}
      {total === 0 && <span className="text-[11px] text-ink-3">none</span>}
    </div>
  );
}

export function Kpi({ icon, label, value, detail, definition, tone, meter }: { icon: ReactNode; label: string; value: ReactNode; detail: ReactNode; definition: string; tone?: string; meter?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 px-5 py-4" data-testid={`kpi-${label}`}>
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-lg border border-accent/30 bg-accent-dim/60 text-accent">{icon}</span>
        <span className="truncate font-mono text-[12.5px] text-ink-2">{label}</span>
        <span className="ml-auto text-ink-3" title={definition} aria-label={`Definition: ${definition}`}>
          <Info size={12} />
        </span>
      </div>
      <div className="font-mono text-[30px] leading-none tracking-tight" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div className="flex min-h-[18px] items-center justify-between gap-3 text-[12px] text-ink-3">
        <span className="truncate">{detail}</span>
        {meter}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="text-ink-3">{icon}</div>
      <div className="font-mono text-[12.5px] text-ink-2">{title}</div>
      {children && <div className="max-w-md text-[12px] leading-relaxed text-ink-3">{children}</div>}
    </div>
  );
}

/** Focus a workspace or tab in cmux through the backend's allowlisted navigation endpoint. */
export function JumpButton({ target, label = 'Open in cmux', compact, testId }: { target: NavigateRequest; label?: string; compact?: boolean; testId?: string }) {
  const mission = useMission();
  const [busy, setBusy] = useState(false);
  const live = mission?.connection.phase === 'live' || mission?.connection.phase === 'resyncing';
  const go = async () => {
    setBusy(true);
    try {
      const r = await navigate(target);
      if (r.ok) toast('success', target.kind === 'surface' ? 'Focused tab in cmux' : 'Opened workspace in cmux');
      else toast('error', r.error ?? 'Navigation failed');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Navigation failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={cx('btn', compact && 'h-6 px-2 text-[11px]')}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void go();
      }}
      disabled={!live || busy}
      title={live ? `${label} (focuses the ${target.kind === 'surface' ? 'tab' : 'workspace'} in cmux)` : 'cmux is not connected'}
      data-testid={testId}
    >
      {busy ? <LoaderCircle size={12} className="animate-spin" /> : <ArrowUpRight size={12} />}
      {label}
    </button>
  );
}

export function Field({ label, children, mono = true }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-1">{label}</div>
      <div className={cx('truncate text-[12.5px] text-ink-2', mono && 'font-mono')}>{children}</div>
    </div>
  );
}

export function NotReported({ children = 'Not reported by cmux' }: { children?: ReactNode }) {
  return <span className="italic text-ink-3">{children}</span>;
}
