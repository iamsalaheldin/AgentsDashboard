import { Plug, ShieldCheck } from 'lucide-react';
import type { MissionState } from '../../../shared/types.ts';
import { Panel } from '../components/ui.tsx';

/** Shown instead of dashboards when Mission Control has never reached cmux. No mock data. */
export function SetupGuide({ m }: { m: MissionState }) {
  const c = m.connection;
  const step = (n: number, title: string, body: React.ReactNode, done = false) => (
    <li className="flex gap-3">
      <span className={`grid size-6 shrink-0 place-items-center rounded-full border font-mono text-[11px] ${done ? 'border-accent/50 text-accent' : 'border-line-strong text-ink-2'}`}>{done ? '✓' : n}</span>
      <div>
        <div className="text-[13px] text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{body}</div>
      </div>
    </li>
  );
  return (
    <div className="mx-auto max-w-2xl py-6" data-testid="setup-guide">
      <Panel title="Connect Mission Control to cmux" icon={<Plug size={14} className="text-accent" />} bodyClass="p-5">
        <p className="mb-4 text-[12.5px] leading-relaxed text-ink-2">
          Mission Control has not been able to read cmux yet, so there is nothing to show. It never falls back to sample data.
          <br />
          <span className="font-mono text-[11.5px] text-ink-3">
            Status: {c.problem ?? c.phase} — {c.message ?? 'waiting for cmux'}
          </span>
        </p>
        <ol className="flex flex-col gap-4">
          {step(1, 'Install cmux', <>Download cmux for macOS from cmux.com and move it to /Applications.</>, c.problem !== 'not_installed')}
          {step(2, 'Open cmux', <>Mission Control connects to <code className="font-mono">{c.socketPath}</code> and reconnects automatically once cmux is running.</>, c.problem !== 'not_running' && c.problem !== 'not_installed')}
          {step(
            3,
            'Start Mission Control from a cmux terminal',
            <>
              cmux’s default socket mode only accepts processes started inside cmux. In a cmux terminal, run{' '}
              <code className="rounded bg-raised px-1 font-mono">npm start</code> in this project (or <code className="rounded bg-raised px-1 font-mono">npm run cmux:launch</code> to give it its own workspace).
            </>,
            c.insideCmux && c.problem !== 'access_denied',
          )}
        </ol>
        <div className="mt-5 flex items-start gap-2 rounded-lg border border-line bg-bg/50 p-3 text-[11.5px] text-ink-3">
          <ShieldCheck size={14} className="mt-px shrink-0 text-accent" />
          Mission Control never changes cmux’s socket access mode, installs hooks, or edits agent configuration. Claude Code and Codex hooks are injected by cmux’s own wrappers.
        </div>
      </Panel>
    </div>
  );
}
