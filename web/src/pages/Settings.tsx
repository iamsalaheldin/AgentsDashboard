import { useState } from 'react';
import { Database, Eye, EyeOff, Plug, ShieldCheck, Trash2 } from 'lucide-react';
import type { MissionState } from '../../../shared/types.ts';
import { toast } from '../components/toast.tsx';
import { Field, Panel, cx } from '../components/ui.tsx';
import { clearActivity, updateSettings } from '../lib/api.ts';
import { clock, dateTime, timeAgo, useNow } from '../lib/format.ts';

// Methods Mission Control relies on, checked against what cmux advertised.
const REQUIRED: { method: string; use: string }[] = [
  { method: 'system.tree', use: 'windows, workspaces, panes, tabs' },
  { method: 'extension.sidebar.snapshot', use: 'directories, git branches, ports, PRs' },
  { method: 'current.list', use: 'agent sessions and their states' },
  { method: 'feed.list', use: 'pending permission / question / plan items' },
  { method: 'notification.list', use: 'unread notifications' },
  { method: 'workspace.select', use: 'navigation: open workspace' },
  { method: 'surface.focus', use: 'navigation: focus tab' },
  { method: 'window.focus', use: 'navigation: bring window forward' },
];

export function SettingsPage({ m }: { m: MissionState }) {
  const now = useNow(2000);
  const c = m.connection;
  const [busy, setBusy] = useState(false);
  const methods = new Set(m.capabilities?.methods ?? []);

  const togglePreviews = async () => {
    setBusy(true);
    try {
      await updateSettings({ showPromptPreviews: !m.settings.showPromptPreviews });
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-5">
      <Panel title="cmux connection" icon={<Plug size={14} className="text-accent" />} bodyClass="p-5">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="connection-details">
          <Field label="State">
            <span className={c.phase === 'live' ? 'text-st-working' : 'text-st-attention'}>{c.phase}</span>
            {c.problem && <span className="text-st-error"> · {c.problem}</span>}
          </Field>
          <Field label="cmux version">{c.cmuxVersion ?? '—'}</Field>
          <Field label="Socket access mode">{c.accessMode ?? '—'}</Field>
          <Field label="Inside cmux">{c.insideCmux ? 'yes' : 'no'}</Field>
          <Field label="Socket">
            <span title={c.socketPath}>{c.socketPath}</span>
          </Field>
          <Field label="Boot id">
            <span title={c.bootId ?? undefined}>{c.bootId ?? '—'}</span>
          </Field>
          <Field label="Last event seq">{c.lastSeq ?? '—'}</Field>
          <Field label="Last frame">{c.lastFrameAt ? `${timeAgo(c.lastFrameAt, now)} (${clock(c.lastFrameAt)})` : '—'}</Field>
          <Field label="Last snapshot">{dateTime(c.lastSnapshotAt)}</Field>
          <Field label="Last replay gap">{dateTime(c.gapDetectedAt)}</Field>
          <Field label="Reconnect attempts">{c.reconnectAttempt}</Field>
        </div>
        {c.message && <p className="mt-4 font-mono text-[11.5px] text-ink-3">{c.message}</p>}
      </Panel>

      <Panel title="Verified cmux interfaces" icon={<ShieldCheck size={14} className="text-accent" />}>
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="border-b border-line font-mono text-[11px] text-ink-3">
              <th className="px-4 py-2 font-normal">Method</th>
              <th className="px-3 py-2 font-normal">Used for</th>
              <th className="px-4 py-2 font-normal">Advertised</th>
            </tr>
          </thead>
          <tbody>
            {REQUIRED.map((r) => (
              <tr key={r.method} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-2 font-mono text-ink">{r.method}</td>
                <td className="px-3 py-2 text-ink-2">{r.use}</td>
                <td className="px-4 py-2 font-mono">
                  {!m.capabilities ? <span className="text-ink-3">unknown</span> : methods.has(r.method) ? <span className="text-st-working">yes</span> : <span className="text-st-error">no</span>}
                </td>
              </tr>
            ))}
            <tr>
              <td className="px-4 py-2 font-mono text-ink">events.stream</td>
              <td className="px-3 py-2 text-ink-2">live events with replay (capability events.v1)</td>
              <td className="px-4 py-2 font-mono">{m.capabilities ? (m.capabilities.features.includes('events.v1') ? <span className="text-st-working">yes</span> : <span className="text-st-error">no</span>) : <span className="text-ink-3">unknown</span>}</td>
            </tr>
          </tbody>
        </table>
        <p className="border-t border-line px-4 py-3 text-[11.5px] leading-relaxed text-ink-3">
          Not available from cmux: what an agent is “working on” beyond its state and last tool name, task success, and program-status text (cmux strips it from the event stream). Terminal program status cannot be re-read after a replay gap.
        </p>
      </Panel>

      <Panel title="Privacy" icon={m.settings.showPromptPreviews ? <Eye size={14} className="text-st-attention" /> : <EyeOff size={14} className="text-accent" />} bodyClass="p-5">
        <div className="flex items-start justify-between gap-6">
          <div className="text-[12.5px] leading-relaxed text-ink-2">
            <div className="text-ink">Show prompt previews</div>
            cmux exposes the latest submitted prompt of each workspace through its sidebar snapshot. Mission Control hides that text by default and never stores or sends it anywhere. Turn this on to show it on workspace pages. Tool inputs and notification text from the event stream stay redacted either way.
          </div>
          <button role="switch" aria-checked={m.settings.showPromptPreviews} disabled={busy} onClick={() => void togglePreviews()} className={cx('relative h-6 w-11 shrink-0 rounded-full border transition-colors', m.settings.showPromptPreviews ? 'border-st-attention/60 bg-st-attention/25' : 'border-line-strong bg-raised')} data-testid="toggle-previews">
            <span className={cx('absolute top-0.5 size-4.5 rounded-full transition-all', m.settings.showPromptPreviews ? 'left-[22px] bg-st-attention' : 'left-0.5 bg-ink-3')} />
            <span className="sr-only">Show prompt previews</span>
          </button>
        </div>
      </Panel>

      <Panel title="Local history" icon={<Database size={14} className="text-accent" />} bodyClass="p-5">
        <div className="flex items-start justify-between gap-6 text-[12.5px] leading-relaxed text-ink-2">
          <div>
            Important events are stored in <code className="font-mono">~/.cmux-mission-control/activity.sqlite</code> for the timeline and “turns completed” metric: at most 7 days and 10,000 entries, pruned hourly. Only event metadata is stored — no prompts, tool inputs or terminal output.
          </div>
          <button
            className="btn shrink-0"
            onClick={async () => {
              if (!confirm('Delete all locally stored Mission Control activity history? cmux itself is not affected.')) return;
              await clearActivity();
              toast('success', 'Local activity history cleared');
            }}
          >
            <Trash2 size={12} /> Clear history
          </button>
        </div>
      </Panel>
    </div>
  );
}
