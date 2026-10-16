// Bounded local history of important events plus the event-stream cursor.
// Uses Node's built-in SQLite (no native dependency).
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActivityEntry, ActivityQuery } from '../../../shared/types.ts';
import type { StreamCursor } from '../cmux/eventStream.ts';

export interface RetentionPolicy {
  maxAgeMs: number;
  maxRows: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxRows: 10_000 };

interface Row {
  id: string;
  kind: string;
  severity: string;
  at: number;
  workspace_id: string | null;
  workspace_title: string | null;
  surface_id: string | null;
  surface_title: string | null;
  agent_key: string | null;
  agent_kind: string | null;
  summary: string;
  detail: string | null;
  boot_id: string | null;
  seq: number | null;
}

const fromRow = (r: Row): ActivityEntry => ({
  id: r.id,
  kind: r.kind as ActivityEntry['kind'],
  severity: r.severity as ActivityEntry['severity'],
  at: r.at,
  workspaceId: r.workspace_id,
  workspaceTitle: r.workspace_title,
  surfaceId: r.surface_id,
  surfaceTitle: r.surface_title,
  agentKey: r.agent_key,
  agentKind: r.agent_kind,
  summary: r.summary,
  detail: r.detail,
  bootId: r.boot_id,
  seq: r.seq,
});

export class ActivityStore {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  readonly retention: RetentionPolicy;

  constructor(path: string, retention: RetentionPolicy = DEFAULT_RETENTION) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.retention = retention;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        at INTEGER NOT NULL,
        workspace_id TEXT,
        workspace_title TEXT,
        surface_id TEXT,
        surface_title TEXT,
        agent_key TEXT,
        agent_kind TEXT,
        summary TEXT NOT NULL,
        detail TEXT,
        boot_id TEXT,
        seq INTEGER
      );
      CREATE INDEX IF NOT EXISTS activity_at ON activity(at DESC);
      CREATE INDEX IF NOT EXISTS activity_ws ON activity(workspace_id, at DESC);
      CREATE INDEX IF NOT EXISTS activity_agent ON activity(agent_key, at DESC);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO activity
        (id, kind, severity, at, workspace_id, workspace_title, surface_id, surface_title, agent_key, agent_kind, summary, detail, boot_id, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }

  /** Returns false when the entry was already stored (duplicate event id). */
  insert(e: ActivityEntry): boolean {
    const r = this.insertStmt.run(
      e.id,
      e.kind,
      e.severity,
      e.at,
      e.workspaceId,
      e.workspaceTitle,
      e.surfaceId,
      e.surfaceTitle,
      e.agentKey,
      e.agentKind,
      e.summary.slice(0, 500),
      e.detail?.slice(0, 500) ?? null,
      e.bootId,
      e.seq,
    );
    return Number(r.changes) > 0;
  }

  query(q: ActivityQuery = {}): ActivityEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.workspaceId) (where.push('workspace_id = ?'), args.push(q.workspaceId));
    if (q.agentKey) (where.push('agent_key = ?'), args.push(q.agentKey));
    if (q.kind) {
      if (q.kind.endsWith('.*')) (where.push('kind LIKE ?'), args.push(q.kind.slice(0, -1) + '%'));
      else (where.push('kind = ?'), args.push(q.kind));
    }
    if (q.severity) (where.push('severity = ?'), args.push(q.severity));
    if (q.before) (where.push('at < ?'), args.push(q.before));
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const sql = `SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, seq DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as unknown as Row[]).map(fromRow);
  }

  latestPerWorkspace(): ActivityEntry[] {
    const rows = this.db
      .prepare(`SELECT a.* FROM activity a JOIN (SELECT workspace_id, MAX(at) m FROM activity WHERE workspace_id IS NOT NULL GROUP BY workspace_id) l
                ON a.workspace_id = l.workspace_id AND a.at = l.m`)
      .all() as unknown as Row[];
    return rows.map(fromRow);
  }

  /** Counts per fixed-width bucket, oldest first, split into attention/error vs. the rest. */
  histogram(since: number, bucketMs: number, buckets: number): { start: number; total: number; flagged: number }[] {
    const rows = this.db
      .prepare(
        `SELECT CAST((at - ?) / ? AS INTEGER) AS b, COUNT(*) AS total,
                SUM(CASE WHEN severity IN ('attention','error') THEN 1 ELSE 0 END) AS flagged
         FROM activity WHERE at >= ? GROUP BY b`,
      )
      .all(since, bucketMs, since) as { b: number; total: number; flagged: number }[];
    const out = Array.from({ length: buckets }, (_, i) => ({ start: since + i * bucketMs, total: 0, flagged: 0 }));
    for (const r of rows) {
      const slot = out[Number(r.b)];
      if (slot) {
        slot.total = Number(r.total);
        slot.flagged = Number(r.flagged);
      }
    }
    return out;
  }

  countSince(kind: string, since: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM activity WHERE kind = ? AND at >= ?').get(kind, since) as { c: number };
    return Number(r.c);
  }

  prune(now = Date.now()): number {
    const byAge = this.db.prepare('DELETE FROM activity WHERE at < ?').run(now - this.retention.maxAgeMs);
    const byCount = this.db
      .prepare('DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY at DESC LIMIT -1 OFFSET ?)')
      .run(this.retention.maxRows);
    return Number(byAge.changes) + Number(byCount.changes);
  }

  clear(): void {
    this.db.exec('DELETE FROM activity');
  }

  getCursor(): StreamCursor {
    const r = this.db.prepare("SELECT v FROM kv WHERE k = 'cursor'").get() as { v: string } | undefined;
    if (!r) return { bootId: null, seq: null };
    try {
      const c = JSON.parse(r.v) as StreamCursor;
      return { bootId: typeof c.bootId === 'string' ? c.bootId : null, seq: typeof c.seq === 'number' ? c.seq : null };
    } catch {
      return { bootId: null, seq: null };
    }
  }

  setCursor(c: StreamCursor): void {
    this.db.prepare("INSERT INTO kv (k, v) VALUES ('cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(c));
  }

  close(): void {
    this.db.close();
  }
}
