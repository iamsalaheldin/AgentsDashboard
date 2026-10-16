import { useEffect, useMemo, useState } from 'react';
import type { ActivityEntry, ActivityQuery } from '../../../shared/types.ts';
import { fetchActivity } from './api.ts';
import { useLiveActivity } from './store.ts';

function matches(e: ActivityEntry, q: ActivityQuery): boolean {
  if (q.workspaceId && e.workspaceId !== q.workspaceId) return false;
  if (q.agentKey && e.agentKey !== q.agentKey) return false;
  if (q.severity && e.severity !== q.severity) return false;
  if (q.kind) {
    if (q.kind.endsWith('.*') ? !e.kind.startsWith(q.kind.slice(0, -1)) : e.kind !== q.kind) return false;
  }
  return true;
}

/** History from the backend store, merged with live SSE entries that match the same filter. */
export function useActivity(q: ActivityQuery) {
  const key = JSON.stringify(q);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const live = useLiveActivity();
  const loadedAt = useMemo(() => Date.now(), [key]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchActivity(q)
      .then((r) => {
        if (!alive) return;
        setHistory(r.entries);
        setExhausted(r.entries.length < (q.limit ?? 100));
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const entries = useMemo(() => {
    const seen = new Set(history.map((h) => h.id));
    const fresh = live.filter((e) => !seen.has(e.id) && e.at >= loadedAt - 60_000 && matches(e, q));
    return [...fresh, ...history].sort((a, b) => b.at - a.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, live, key, loadedAt]);

  const loadMore = async () => {
    const last = history[history.length - 1];
    if (!last) return;
    const r = await fetchActivity({ ...q, before: last.at });
    setHistory((h) => [...h, ...r.entries.filter((e) => !h.some((x) => x.id === e.id))]);
    if (r.entries.length < (q.limit ?? 100)) setExhausted(true);
  };

  return { entries, loading, error, exhausted, loadMore };
}
