// Events recorded per hour (last 24 h) from the local activity store. Real data only:
// an empty store renders an empty state, not a placeholder curve.
import { useEffect, useState } from 'react';
import { fetchHistogram, type HistogramBucket } from '../lib/api.ts';
import { shortTime } from '../lib/format.ts';
import { useLiveActivity } from '../lib/store.ts';

const H = 96;

export function ActivityChart() {
  const [buckets, setBuckets] = useState<HistogramBucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const live = useLiveActivity();
  const latest = live[0]?.id;

  useEffect(() => {
    let alive = true;
    fetchHistogram(24)
      .then((r) => alive && (setBuckets(r.buckets), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [latest]);

  if (error) return <div className="px-4 py-6 text-[12px] text-st-error">Could not load activity history: {error}</div>;
  if (!buckets) return <div className="h-[150px] animate-pulse px-4 py-6" />;
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const total = buckets.reduce((s, b) => s + b.total, 0);
  const flagged = buckets.reduce((s, b) => s + b.flagged, 0);
  if (total === 0) return <div className="px-4 py-8 text-center text-[12px] text-ink-3">No events recorded in the last 24 hours.</div>;

  const w = 100 / buckets.length;
  const hb = hover !== null ? buckets[hover] : null;
  return (
    <div className="px-4 pt-3 pb-3">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-1 font-mono text-[11px] whitespace-nowrap text-ink-3">
        <span>
          <span className="text-[18px] text-ink">{total}</span> events · {flagged} flagged
        </span>
        <span className="flex items-center gap-3">
          <Legend color="var(--color-accent)" label="Other" />
          <Legend color="var(--color-st-attention)" label="Attention / error" />
        </span>
      </div>
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="h-[96px] w-full" role="img" aria-label={`Events per hour over the last 24 hours, ${total} total`}>
          <line x1="0" x2="100" y1={H - 0.5} y2={H - 0.5} stroke="var(--color-line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {buckets.map((b, i) => {
            const hTotal = (b.total / max) * (H - 4);
            const hFlag = (b.flagged / max) * (H - 4);
            const x = i * w + w * 0.15;
            const bw = w * 0.7;
            return (
              <g key={b.start} opacity={hover === null || hover === i ? 1 : 0.45}>
                {b.total - b.flagged > 0 && <rect x={x} y={H - hTotal} width={bw} height={Math.max(0, hTotal - hFlag - (hFlag > 0 ? 1 : 0))} rx="0.6" fill="var(--color-accent)" />}
                {b.flagged > 0 && <rect x={x} y={H - hFlag} width={bw} height={hFlag} rx="0.6" fill="var(--color-st-attention)" />}
                {/* Hit target taller and wider than the mark */}
                <rect x={i * w} y="0" width={w} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {hb && hover !== null && (
          <div className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line-strong bg-raised px-2 py-1 font-mono text-[10.5px] whitespace-nowrap text-ink shadow-lg" style={{ left: `${(hover + 0.5) * w}%` }}>
            {shortTime(hb.start)}–{shortTime(hb.start + 3_600_000)} · {hb.total} events{hb.flagged ? ` · ${hb.flagged} flagged` : ''}
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-3">
        <span>{shortTime(buckets[0]!.start)}</span>
        <span>{shortTime(buckets[Math.floor(buckets.length / 2)]!.start)}</span>
        <span>now</span>
      </div>
      <table className="sr-only">
        <caption>Events per hour</caption>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.start}>
              <td>{shortTime(b.start)}</td>
              <td>{b.total}</td>
              <td>{b.flagged}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2 rounded-[2px]" style={{ background: color }} />
      {label}
    </span>
  );
}
