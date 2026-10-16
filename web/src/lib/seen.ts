// "What changed since I last checked?" — a per-browser marker of the last time the user
// acknowledged the timeline. This is a viewer convenience only; it never resolves anything.
import { useSyncExternalStore } from 'react';

const KEY = 'mc.lastSeenAt';
const listeners = new Set<() => void>();

function read(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

let value = read();

export function markSeen(at = Date.now()) {
  value = at;
  try {
    localStorage.setItem(KEY, String(at));
  } catch {
    /* storage unavailable: keep in memory */
  }
  listeners.forEach((l) => l());
}

export function useLastSeen(): number | null {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => value,
  );
}
