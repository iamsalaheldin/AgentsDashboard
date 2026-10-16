import { Bell, CircleCheck, HandHelping } from 'lucide-react';
import type { MissionState } from '../../../shared/types.ts';
import { useStale } from '../components/layout.tsx';
import { AttentionRow } from '../components/mission.tsx';
import { EmptyState, Panel, cx } from '../components/ui.tsx';
import { useNow } from '../lib/format.ts';

export function Attention({ m }: { m: MissionState }) {
  const now = useNow();
  const stale = useStale();
  const actionable = m.attention.filter((a) => a.kind !== 'notification');
  const notifications = m.attention.filter((a) => a.kind === 'notification');
  return (
    <div className={cx('mx-auto flex max-w-[1100px] flex-col gap-5', stale && 'stale-dim')}>
      <Panel title={`Needs your attention (${actionable.length})`} icon={<HandHelping size={14} className="text-st-attention" />}>
        {actionable.length === 0 ? (
          <EmptyState icon={<CircleCheck size={22} />} title="Nothing is waiting on you">
            Items appear here when cmux reports a permission request, question, plan approval, an agent waiting for input, a failed turn, or a terminal program error.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line" data-testid="attention-page-list">
            {actionable.map((a) => (
              <AttentionRow key={a.id} item={a} m={m} now={now} />
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={`Unread cmux notifications (${notifications.length})`} icon={<Bell size={14} className="text-st-info" />}>
        {notifications.length === 0 ? (
          <EmptyState icon={<Bell size={22} />} title="No unread notifications" />
        ) : (
          <ul className="divide-y divide-line">
            {notifications.map((a) => (
              <AttentionRow key={a.id} item={a} m={m} now={now} />
            ))}
          </ul>
        )}
      </Panel>
      <p className="px-1 text-[11.5px] leading-relaxed text-ink-3">
        Items resolve only when cmux reports the underlying condition is gone (the Feed item is answered, the agent resumes, the program clears its status, or the notification is read in cmux). Viewing this page never resolves anything. Sorted by urgency, then most recent.
      </p>
    </div>
  );
}
