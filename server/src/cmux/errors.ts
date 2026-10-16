import type { ConnectionProblem } from '../../../shared/types.ts';

/** Transport-level failure talking to the cmux socket. */
export class CmuxConnectionError extends Error {
  readonly problem: ConnectionProblem;
  constructor(problem: ConnectionProblem, message: string) {
    super(message);
    this.name = 'CmuxConnectionError';
    this.problem = problem;
  }
}

/** cmux answered, but with `ok: false`. */
export class CmuxRpcError extends Error {
  readonly code: string;
  readonly method: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(method: string, code: string, message: string, retryable = false, retryAfterMs: number | null = null) {
    super(`${method}: ${code}: ${message}`);
    this.name = 'CmuxRpcError';
    this.method = method;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const ACCESS_DENIED = /access denied/i;

export function classifySocketError(err: NodeJS.ErrnoException, socketPath: string): CmuxConnectionError {
  switch (err.code) {
    case 'ENOENT':
    case 'ECONNREFUSED':
      return new CmuxConnectionError('not_running', `No live cmux socket at ${socketPath}`);
    case 'EACCES':
    case 'EPERM':
      return new CmuxConnectionError('access_denied', `Permission denied opening ${socketPath}`);
    default:
      return new CmuxConnectionError('unknown', `${err.code ?? 'socket error'}: ${err.message}`);
  }
}

/** cmux answers unauthorized peers with a plain-text line rather than JSON. */
export function classifyTextReply(line: string): CmuxConnectionError {
  if (ACCESS_DENIED.test(line)) {
    return new CmuxConnectionError(
      'access_denied',
      'cmux refused the connection: only processes started inside cmux can connect (socket mode "cmuxOnly").',
    );
  }
  return new CmuxConnectionError('protocol_error', `Unexpected reply from cmux: ${line.slice(0, 160)}`);
}
