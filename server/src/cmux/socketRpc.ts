import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { CmuxConnectionError, CmuxRpcError, classifySocketError, classifyTextReply } from './errors.ts';
import type { Logger } from '../logger.ts';

export interface RpcOptions {
  timeoutMs?: number;
  /** Retries for cmux `overloaded` replies flagged retryable (the command never ran). */
  retries?: number;
}

const MAX_REPLY_BYTES = 32 * 1024 * 1024;

/**
 * One request per connection, matching the cmux CLI. The connection closes after the
 * first reply line, so a stuck request can never block later ones.
 */
export class SocketRpc {
  readonly socketPath: string;
  private readonly log: Logger;

  constructor(socketPath: string, log: Logger) {
    this.socketPath = socketPath;
    this.log = log;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: RpcOptions = {}): Promise<T> {
    const retries = opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, params, opts.timeoutMs ?? 8000);
      } catch (err) {
        if (err instanceof CmuxRpcError && err.retryable && attempt < retries) {
          const wait = Math.min(err.retryAfterMs ?? 200, 2000);
          this.log.warn('cmux overloaded, retrying', { method, wait, attempt });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
  }

  private once<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `mc-${randomUUID()}`;
      const socket = createConnection(this.socketPath);
      let buf = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new CmuxConnectionError('timeout', `${method} timed out after ${timeoutMs} ms`))),
        timeoutMs,
      );
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
      socket.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_REPLY_BYTES) {
          finish(() => reject(new CmuxConnectionError('protocol_error', `${method} reply exceeded ${MAX_REPLY_BYTES} bytes`)));
          return;
        }
        const nl = buf.indexOf('\n');
        if (nl >= 0) finish(() => settle(buf.slice(0, nl)));
      });
      socket.on('end', () => finish(() => (buf.trim() ? settle(buf) : reject(new CmuxConnectionError('protocol_error', `${method}: connection closed without reply`)))));
      socket.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(classifySocketError(err, this.socketPath))));

      const settle = (line: string) => {
        let msg: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string; data?: Record<string, unknown> } };
        try {
          msg = JSON.parse(line);
        } catch {
          reject(classifyTextReply(line.trim()));
          return;
        }
        if (msg.ok) {
          resolve(msg.result as T);
          return;
        }
        const e = msg.error ?? {};
        const data = e.data ?? {};
        const code = e.code ?? 'error';
        if (/access denied/i.test(e.message ?? '')) {
          reject(classifyTextReply(e.message ?? ''));
          return;
        }
        reject(
          new CmuxRpcError(
            method,
            code,
            e.message ?? 'unknown error',
            data.retryable === true && code === 'overloaded',
            typeof data.retry_after_ms === 'number' ? data.retry_after_ms : null,
          ),
        );
      };
    });
  }
}
