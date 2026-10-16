import type { ActivityEntry, ActivityQuery, NavigateRequest, NavigateResult, Settings } from '../../../shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && !(body && typeof body === 'object' && 'ok' in body)) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function fetchActivity(q: ActivityQuery = {}): Promise<{ entries: ActivityEntry[] }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
  return request(`/api/activity?${params}`);
}

export interface HistogramBucket {
  start: number;
  total: number;
  flagged: number;
}

export function fetchHistogram(hours = 24): Promise<{ bucketMs: number; buckets: HistogramBucket[] }> {
  return request(`/api/activity/histogram?hours=${hours}`);
}

export function navigate(req: NavigateRequest): Promise<NavigateResult> {
  return request('/api/navigate', { method: 'POST', body: JSON.stringify(req) });
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return request('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
}

export function clearActivity(): Promise<{ ok: boolean }> {
  return request('/api/activity', { method: 'DELETE' });
}
