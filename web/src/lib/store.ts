// Client store fed by the backend's SSE stream. Components read it via hooks; no
// business logic lives here — the server already normalized everything.
import { useSyncExternalStore } from 'react';
import type { ActivityEntry, MissionState } from '../../../shared/types.ts';

export type BackendStatus = 'connecting' | 'open' | 'lost';

interface ClientState {
  mission: MissionState | null;
  backend: BackendStatus;
  backendLostAt: number | null;
  /** Live activity frames received since page load (newest first, bounded). */
  liveActivity: ActivityEntry[];
}

let state: ClientState = { mission: null, backend: 'connecting', backendLostAt: null, liveActivity: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<ClientState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

let source: EventSource | null = null;

export function connect(): () => void {
  if (source) return () => {};
  source = new EventSource('/api/stream');
  source.addEventListener('open', () => set({ backend: 'open', backendLostAt: null }));
  source.addEventListener('state', (e) => set({ mission: JSON.parse((e as MessageEvent).data) as MissionState, backend: 'open' }));
  source.addEventListener('activity', (e) => {
    const entry = JSON.parse((e as MessageEvent).data) as ActivityEntry;
    set({ liveActivity: [entry, ...state.liveActivity.filter((a) => a.id !== entry.id)].slice(0, 300) });
  });
  // EventSource reconnects by itself; we only surface that the backend is unreachable.
  source.addEventListener('error', () => {
    if (state.backend !== 'lost') set({ backend: 'lost', backendLostAt: Date.now() });
  });
  return () => {
    source?.close();
    source = null;
  };
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useClient<T>(select: (s: ClientState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export const useMission = () => useClient((s) => s.mission);
export const useBackend = () => useClient((s) => s.backend);
export const useLiveActivity = () => useClient((s) => s.liveActivity);
