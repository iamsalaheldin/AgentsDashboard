import { describe, expect, it } from 'vitest';
import { ActivityStore } from '../../server/src/store/activityStore.ts';
import { SettingsStore } from '../../server/src/store/settingsStore.ts';
import type { ActivityEntry } from '../../shared/types.ts';
import { tempDir } from '../support/helpers.ts';
import { join } from 'node:path';

const entry = (i: number, over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: `e${i}`,
  kind: 'agent.turn_completed',
  severity: 'success',
  at: 1_000 + i,
  workspaceId: 'w1',
  workspaceTitle: 'api',
  surfaceId: null,
  surfaceTitle: null,
  agentKey: 'claude:s',
  agentKind: 'claude',
  summary: `entry ${i}`,
  detail: null,
  bootId: 'b',
  seq: i,
  ...over,
});

describe('ActivityStore', () => {
  it('dedupes by event id and filters queries', () => {
    const s = new ActivityStore(':memory:');
    expect(s.insert(entry(1))).toBe(true);
    expect(s.insert(entry(1))).toBe(false);
    s.insert(entry(2, { workspaceId: 'w2', kind: 'workspace.created', severity: 'info' }));
    s.insert(entry(3, { severity: 'error', kind: 'agent.turn_failed' }));
    expect(s.query().map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
    expect(s.query({ workspaceId: 'w2' }).map((e) => e.id)).toEqual(['e2']);
    expect(s.query({ kind: 'agent.*' }).map((e) => e.id)).toEqual(['e3', 'e1']);
    expect(s.query({ severity: 'error' }).map((e) => e.id)).toEqual(['e3']);
    expect(s.query({ before: 1003, limit: 1 }).map((e) => e.id)).toEqual(['e2']);
    expect(s.countSince('agent.turn_completed', 0)).toBe(1);
    expect(s.histogram(1000, 2, 3)).toEqual([
      { start: 1000, total: 1, flagged: 0 },
      { start: 1002, total: 2, flagged: 1 },
      { start: 1004, total: 0, flagged: 0 },
    ]);
    expect(s.latestPerWorkspace().map((e) => e.id).sort()).toEqual(['e2', 'e3']);
  });

  it('enforces retention by age and row count', () => {
    const s = new ActivityStore(':memory:', { maxAgeMs: 100, maxRows: 3 });
    for (let i = 0; i < 6; i++) s.insert(entry(i, { at: 10_000 + i }));
    s.insert(entry(99, { at: 1 }));
    s.prune(10_050);
    expect(s.query().map((e) => e.id)).toEqual(['e5', 'e4', 'e3']);
  });

  it('persists the stream cursor and settings on disk', () => {
    const dir = tempDir();
    const a = new ActivityStore(join(dir, 'a.sqlite'));
    a.setCursor({ bootId: 'boot', seq: 42 });
    a.close();
    expect(new ActivityStore(join(dir, 'a.sqlite')).getCursor()).toEqual({ bootId: 'boot', seq: 42 });
    const settings = new SettingsStore(join(dir, 'settings.json'));
    expect(settings.get().showPromptPreviews).toBe(false);
    settings.update({ showPromptPreviews: true });
    expect(new SettingsStore(join(dir, 'settings.json')).get().showPromptPreviews).toBe(true);
  });
});
