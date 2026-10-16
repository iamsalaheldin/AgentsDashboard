// Event-derived OSC 7501 program-status records. cmux has no snapshot query for these
// (docs/events.md), so the only source is `program_status.changed`, including its chunked
// snapshot protocol. After a replay gap the store is reset to "unknown".
import type { ProgramState, ProgramStatusRecord } from '../../../shared/types.ts';

const STATES = new Set<ProgramState>(['working', 'blocked', 'error', 'done', 'idle']);

interface RawRecord {
  id?: unknown;
  state?: unknown;
  kind?: unknown;
  progress?: unknown;
}

export interface ProgramStatusChange {
  workspaceId: string;
  surfaceId: string;
  event: string;
  records: ProgramStatusRecord[];
  /** The record this event addressed (for `report`), if any. */
  record: ProgramStatusRecord | null;
}

interface Assembly {
  count: number;
  chunks: Map<number, ProgramStatusRecord[]>;
}

function toRecord(r: RawRecord, at: number): ProgramStatusRecord | null {
  const state = typeof r.state === 'string' ? (r.state as ProgramState) : null;
  if (!state || !STATES.has(state)) return null;
  return {
    id: typeof r.id === 'string' ? r.id : '',
    state,
    kind: typeof r.kind === 'string' ? r.kind : 'none',
    progress: typeof r.progress === 'number' ? r.progress : null,
    updatedAt: at,
  };
}

export class ProgramStatusStore {
  private readonly records = new Map<string, ProgramStatusRecord[]>();
  private readonly assemblies = new Map<string, Assembly>();
  /** When true, surfaces without an observed snapshot are reported as unknown (null). */
  private unknownByDefault = false;

  private static key(workspaceId: string, surfaceId: string) {
    return `${workspaceId}/${surfaceId}`;
  }

  get(workspaceId: string, surfaceId: string): ProgramStatusRecord[] | null {
    const r = this.records.get(ProgramStatusStore.key(workspaceId, surfaceId));
    if (r) return r;
    return this.unknownByDefault ? null : [];
  }

  /** Drop everything: called on replay gaps and cmux restarts. */
  markUnknown(): void {
    this.records.clear();
    this.assemblies.clear();
    this.unknownByDefault = true;
  }

  /** A complete, gap-free replay from cmux's first event makes absence meaningful again. */
  markComplete(): void {
    this.unknownByDefault = false;
  }

  /** Drop surfaces that no longer exist in the topology. */
  retain(live: Set<string>): void {
    for (const key of this.records.keys()) if (!live.has(key)) this.records.delete(key);
  }

  apply(workspaceId: string | null, surfaceId: string | null, payload: Record<string, unknown>, at: number): ProgramStatusChange | null {
    if (!workspaceId || !surfaceId) return null;
    const key = ProgramStatusStore.key(workspaceId, surfaceId);
    const event = typeof payload.event === 'string' ? payload.event : 'report';
    const addressed = payload.record && typeof payload.record === 'object' ? toRecord(payload.record as RawRecord, at) : null;

    if (event === 'removed') {
      this.records.delete(key);
      return { workspaceId, surfaceId, event, records: [], record: null };
    }

    const snapshotId = typeof payload.snapshot_id === 'string' ? payload.snapshot_id : null;
    const count = typeof payload.snapshot_count === 'number' ? payload.snapshot_count : 1;
    const index = typeof payload.snapshot_index === 'number' ? payload.snapshot_index : 0;
    const chunk = (Array.isArray(payload.records) ? (payload.records as RawRecord[]) : [])
      .map((r) => toRecord(r, at))
      .filter((r): r is ProgramStatusRecord => r !== null);

    let complete: ProgramStatusRecord[] | null = null;
    if (!snapshotId || count <= 1) {
      complete = chunk;
    } else {
      const asmKey = `${key}#${snapshotId}`;
      const asm = this.assemblies.get(asmKey) ?? { count, chunks: new Map() };
      asm.chunks.set(index, chunk);
      if (asm.chunks.size >= asm.count) {
        complete = [...asm.chunks.entries()].sort(([a], [b]) => a - b).flatMap(([, recs]) => recs);
        this.assemblies.delete(asmKey);
      } else {
        this.assemblies.set(asmKey, asm);
      }
    }
    if (!complete) return null;
    this.records.set(key, complete);
    return { workspaceId, surfaceId, event, records: complete, record: addressed };
  }
}
