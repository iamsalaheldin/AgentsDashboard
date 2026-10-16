// Parsing real cmux 0.65.2 captures (test/fixtures) through the production schemas.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CapabilitiesSchema,
  CurrentListSchema,
  FeedListSchema,
  NotificationListSchema,
  SidebarSnapshotSchema,
  SystemTreeSchema,
  parseFrame,
} from '../../server/src/cmux/schemas.ts';
import { FIXTURES, fixture } from '../support/helpers.ts';

describe('cmux schemas against real captures', () => {
  it('parses system.tree', () => {
    const tree = SystemTreeSchema.parse(fixture('system-tree.json'));
    expect(tree.windows).toHaveLength(1);
    expect(tree.windows[0]!.workspaces).toHaveLength(2);
    expect(tree.windows[0]!.workspaces[0]!.panes[0]!.surfaces[0]!.type).toBe('terminal');
  });

  it('parses extension.sidebar.snapshot', () => {
    const s = SidebarSnapshotSchema.parse(fixture('sidebar-snapshot.json'));
    expect(s.workspaces.length).toBeGreaterThan(0);
    expect(s.workspaces.some((w) => w.latest_submitted_message)).toBe(true);
  });

  it('parses current.list with agent + attention', () => {
    const c = CurrentListSchema.parse(fixture('current-list-permission.json'));
    const withAgent = c.items.find((i) => i.agents.length);
    expect(withAgent?.agents[0]).toMatchObject({ kind: 'claude', state: 'needs_input' });
    expect(withAgent?.attention[0]?.kind).toBe('needs_input');
    expect(withAgent?.projections[0]?.panel_id).toMatch(/^[0-9A-F-]{36}$/);
  });

  it('parses feed.list pending permission', () => {
    const f = FeedListSchema.parse(fixture('feed-list-pending.json'));
    const perm = f.items.find((i) => i.kind === 'permissionRequest');
    expect(perm?.status).toBe('pending');
    expect(perm?.request_id).toBeTruthy();
  });

  it('parses notification.list and system.capabilities', () => {
    expect(NotificationListSchema.parse(fixture('notification-list.json')).notifications[0]?.title).toBe('MC probe');
    const caps = CapabilitiesSchema.parse(fixture('capabilities.json'));
    expect(caps.access_mode).toBe('cmuxOnly');
    expect(caps.methods).toContain('current.list');
    expect(caps.capabilities).toContain('events.v1');
  });

  it('parses every frame of the captured event streams', () => {
    for (const name of ['events-claude-session.jsonl', 'events-lifecycle.jsonl']) {
      const lines = readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean);
      const kinds = lines.map((l) => parseFrame(l).kind);
      expect(kinds).not.toContain('invalid');
    }
  });

  it('classifies error frames and garbage', () => {
    expect(parseFrame('not json').kind).toBe('invalid');
    expect(parseFrame('{"type":"error","code":"slow_consumer","message":"too slow"}')).toEqual({ kind: 'error', code: 'slow_consumer', message: 'too slow' });
    expect(parseFrame('{"ok":false,"error":{"code":"x","message":"Access denied - only processes"}}')).toMatchObject({ code: 'access_denied' });
  });
});
