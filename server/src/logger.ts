// Structured JSON logger with redaction. All server modules log through this.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Keys whose values may carry prompts, tool input, notification text or secrets.
const SENSITIVE_KEY = /(prompt|message|body|subtitle|tool_input|context|extra_fields|password|token|secret|capability|authorization|cookie|text)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: value.message };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && v != null ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(component: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
}

export function createLogger(component = 'mc', options: LoggerOptions = {}): Logger {
  const min = LEVELS[options.level ?? (process.env.MC_LOG_LEVEL as LogLevel | undefined) ?? 'info'] ?? LEVELS.info;
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const entry = { t: new Date().toISOString(), level, component, msg, ...(fields ? (redact(fields) as object) : {}) };
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (c) => createLogger(`${component}.${c}`, options),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
