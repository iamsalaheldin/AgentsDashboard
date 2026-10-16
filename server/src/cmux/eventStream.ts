import { createConnection, type Socket } from 'node:net';
import { classifySocketError, classifyTextReply, CmuxConnectionError } from './errors.ts';
import type { RawAck, RawEvent, RawHeartbeat } from './schemas.ts';
import { parseFrame } from './schemas.ts';
import type { ConnectionProblem } from '../../../shared/types.ts';
import type { Logger } from '../logger.ts';

export interface StreamCursor {
  bootId: string | null;
  seq: number | null;
}

export interface AckInfo {
  ack: RawAck;
  /** True when replay could not cover everything since the cursor (gap or cmux restart). */
  gap: boolean;
  restarted: boolean;
  /** Events with seq ≤ this value are replays of retained history. */
  replayThroughSeq: number;
}

export interface EventStreamHandlers {
  onAck(info: AckInfo): void;
  onEvent(event: RawEvent, meta: { replay: boolean }): void;
  onHeartbeat?(hb: RawHeartbeat): void;
  onDisconnect(problem: ConnectionProblem, message: string): void;
}

export interface EventStreamOptions {
  socketPath: string;
  log: Logger;
  handlers: EventStreamHandlers;
  getCursor(): StreamCursor;
  /** Multiplier on the advertised heartbeat interval before the stream counts as stalled. */
  stallFactor?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  dedupeWindow?: number;
}

/**
 * Long-lived `events.stream` subscription with cmux's resume contract:
 * ack → (gap? resync) → replay → live, reconnecting with the last processed seq.
 */
export class EventStream {
  private readonly opts: Required<Omit<EventStreamOptions, 'handlers' | 'getCursor' | 'log' | 'socketPath'>> & EventStreamOptions;
  private socket: Socket | null = null;
  private buf = '';
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private heartbeatMs = 15_000;
  private acked = false;
  private bootId: string | null = null;
  private replayThroughSeq = 0;
  private lastDeliveredSeq = 0;
  /** lastDeliveredSeq at the previous interrupted replay, to detect lack of progress. */
  private interruptedAt: number | null = null;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(opts: EventStreamOptions) {
    this.opts = {
      ...opts,
      stallFactor: opts.stallFactor ?? 2.5,
      minBackoffMs: opts.minBackoffMs ?? 500,
      maxBackoffMs: opts.maxBackoffMs ?? 10_000,
      dedupeWindow: opts.dedupeWindow ?? 8192,
    };
  }

  get reconnectAttempt(): number {
    return this.attempt;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown();
  }

  /** Force a reconnect (e.g. the consumer detected an inconsistency). */
  restart(reason: string): void {
    this.opts.log.info('restarting event stream', { reason });
    this.teardown();
    this.scheduleReconnect(0);
  }

  private connect(): void {
    if (this.stopped) return;
    const cursor = this.opts.getCursor();
    const afterSeq = cursor.seq ?? 0;
    this.acked = false;
    this.buf = '';
    const socket = createConnection(this.opts.socketPath);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(
        JSON.stringify({ id: 'mc-events', method: 'events.stream', params: { after_seq: afterSeq, include_heartbeats: true } }) + '\n',
      );
      this.lastFrameAt = Date.now();
      this.armWatchdog(10_000); // ack must arrive promptly
    });
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err: NodeJS.ErrnoException) => this.fail(classifySocketError(err, this.opts.socketPath)));
    socket.on('end', () => this.opts.log.debug('event stream ended by cmux', { acked: this.acked, pending: this.buf.slice(0, 300) }));
    socket.on('close', (hadError) => {
      if (this.socket === socket) this.fail(new CmuxConnectionError('not_running', `cmux event stream closed${hadError ? ' with error' : ''}`));
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
      if (!this.socket) return; // torn down while handling
    }
    if (this.buf.length > 1024 * 1024) this.fail(new CmuxConnectionError('protocol_error', 'event frame exceeded 1 MiB'));
  }

  private onLine(line: string): void {
    this.lastFrameAt = Date.now();
    const frame = parseFrame(line);
    if (frame.kind === 'invalid') {
      if (!this.acked) {
        this.fail(classifyTextReply(line));
        return;
      }
      this.opts.log.warn('dropping malformed event frame', { reason: frame.reason });
      return;
    }
    if (frame.kind === 'error') {
      this.fail(new CmuxConnectionError(frame.code === 'access_denied' ? 'access_denied' : 'protocol_error', frame.message));
      return;
    }
    if (frame.kind === 'ack') {
      const ack = frame.ack;
      const cursor = this.opts.getCursor();
      const restarted = cursor.bootId !== null && cursor.bootId !== ack.boot_id;
      const gap = restarted || ack.resume.gap === true || ack.resume.restore_gap === true;
      this.acked = true;
      this.attempt = 0;
      this.bootId = ack.boot_id;
      this.heartbeatMs = (ack.heartbeat_interval_seconds ?? 15) * 1000;
      this.replayThroughSeq = ack.resume.latest_seq ?? 0;
      this.lastDeliveredSeq = Math.max(this.lastDeliveredSeq, ack.resume.after_seq ?? 0);
      if (restarted) this.resetDedupe();
      this.armWatchdog(this.heartbeatMs * this.opts.stallFactor);
      this.opts.handlers.onAck({ ack, gap, restarted, replayThroughSeq: this.replayThroughSeq });
      return;
    }
    if (!this.acked) {
      this.fail(new CmuxConnectionError('protocol_error', 'event frame before ack'));
      return;
    }
    this.armWatchdog(this.heartbeatMs * this.opts.stallFactor);
    if (frame.kind === 'heartbeat') {
      this.opts.handlers.onHeartbeat?.(frame.heartbeat);
      return;
    }
    const ev = frame.event;
    const replay = ev.seq <= this.replayThroughSeq;
    // cmux restores events from earlier app processes into its replay buffer (verified on
    // 0.65.2), so replayed history may carry an older boot_id. Only a *live* event from a
    // different boot means our view of the process is wrong.
    if (!replay && ev.boot_id !== this.bootId) {
      this.opts.log.warn('live event from unexpected boot; resyncing', { expected: this.bootId, got: ev.boot_id });
      this.restart('boot_id mismatch');
      return;
    }
    this.lastDeliveredSeq = ev.seq;
    if (this.isDuplicate(ev.id)) return;
    this.opts.handlers.onEvent(ev, { replay });
  }

  private isDuplicate(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > this.opts.dedupeWindow) this.seen.delete(this.seenOrder.shift()!);
    return false;
  }

  private resetDedupe(): void {
    this.seen.clear();
    this.seenOrder.length = 0;
  }

  private armWatchdog(ms: number): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      const silentFor = Date.now() - this.lastFrameAt;
      this.fail(new CmuxConnectionError(this.acked ? 'stream_stalled' : 'timeout', `No frames from cmux for ${Math.round(silentFor / 1000)} s`));
    }, ms);
  }

  private fail(err: CmuxConnectionError): void {
    if (!this.socket) return;
    const midReplay = this.acked && this.lastDeliveredSeq < this.replayThroughSeq;
    this.teardown();
    if (this.stopped) return;
    // Observed on cmux 0.65.2: a large replay burst can end the subscription part-way.
    // While each attempt makes progress, resume from the last delivered seq immediately
    // instead of reporting a disconnect.
    if (midReplay && err.problem === 'not_running' && this.interruptedAt !== this.lastDeliveredSeq) {
      this.interruptedAt = this.lastDeliveredSeq;
      this.opts.log.info('replay interrupted by cmux; resuming', { at: this.lastDeliveredSeq, through: this.replayThroughSeq });
      this.scheduleReconnect(0);
      return;
    }
    this.opts.log.warn('event stream disconnected', { problem: err.problem, reason: err.message, attempt: this.attempt });
    this.opts.handlers.onDisconnect(err.problem, err.message);
    // Access denial will not fix itself quickly; back off to the maximum straight away.
    this.scheduleReconnect(err.problem === 'access_denied' ? this.opts.maxBackoffMs : undefined);
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** this.attempt);
    const delay = delayMs ?? Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private teardown(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.removeAllListeners('close');
      s.destroy();
    }
  }
}
