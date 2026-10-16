// Local HTTP API + SSE + static UI. Bound to loopback only; see docs/ARCHITECTURE.md.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import type { MissionControl } from '../app.ts';
import type { Logger } from '../logger.ts';

const UUID = z.string().regex(/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/, 'expected a cmux UUID');

export const NavigateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workspace'), workspaceId: UUID }),
  z.strictObject({ kind: z.literal('surface'), workspaceId: UUID, surfaceId: UUID }),
]);

export const SettingsPatchSchema = z.strictObject({ showPromptPreviews: z.boolean().optional() });

export const ActivityQuerySchema = z.strictObject({
  workspaceId: UUID.optional(),
  agentKey: z.string().max(300).optional(),
  kind: z.string().regex(/^[a-z_.*]+$/).max(60).optional(),
  severity: z.enum(['info', 'success', 'attention', 'error']).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export interface HttpOptions {
  mc: MissionControl;
  log: Logger;
  host: string;
  port: number;
  staticDir: string;
  /** Extra origins allowed for state-changing requests (the Vite dev server in `npm run dev`). */
  devOrigins?: string[];
  sseThrottleMs?: number;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createHttpServer(opts: HttpOptions): Server {
  const { mc, log } = opts;
  const allowedHosts = (port: number) => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = (port: number) =>
    new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...(opts.devOrigins ?? [])]);

  const server = createServer((req, res) => {
    const port = (server.address() as { port: number } | null)?.port ?? opts.port;
    handle(req, res, port).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log.error('request failed', { url: req.url, err });
      if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : 'error' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    // DNS-rebinding guard: only answer requests addressed to loopback names.
    if (!allowedHosts(port).has(req.headers.host ?? '')) throw new HttpError(421, 'Misdirected request');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins(port).has(origin)) throw new HttpError(403, 'Cross-origin request rejected');
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '') && method !== 'DELETE') {
        throw new HttpError(415, 'Content-Type must be application/json');
      }
    }

    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      switch (`${method} ${url.pathname}`) {
        case 'GET /api/health': {
          const c = mc.state.getConnection();
          return json(res, 200, { ok: true, connection: c.phase, problem: c.problem });
        }
        case 'GET /api/state':
          return json(res, 200, mc.state.build());
        case 'GET /api/activity': {
          const q = ActivityQuerySchema.safeParse(Object.fromEntries(url.searchParams));
          if (!q.success) throw new HttpError(400, q.error.issues[0]?.message ?? 'invalid query');
          return json(res, 200, { entries: mc.activity.query(q.data) });
        }
        case 'GET /api/activity/histogram': {
          const hours = z.coerce.number().int().min(1).max(168).safeParse(url.searchParams.get('hours') ?? 24);
          if (!hours.success) throw new HttpError(400, 'hours must be 1–168');
          const bucketMs = 60 * 60 * 1000;
          const end = Math.ceil(Date.now() / bucketMs) * bucketMs;
          return json(res, 200, { bucketMs, buckets: mc.activity.histogram(end - hours.data * bucketMs, bucketMs, hours.data) });
        }
        case 'DELETE /api/activity': {
          mc.clearHistory();
          return json(res, 200, { ok: true });
        }
        case 'POST /api/navigate': {
          const body = NavigateSchema.safeParse(await readJson(req));
          if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? 'invalid body');
          const result = await mc.navigate(body.data);
          return json(res, result.ok ? 200 : 409, result);
        }
        case 'PUT /api/settings': {
          const body = SettingsPatchSchema.safeParse(await readJson(req));
          if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? 'invalid body');
          return json(res, 200, mc.updateSettings(body.data));
        }
        case 'GET /api/stream':
          return stream(req, res);
        default:
          throw new HttpError(404, 'Not found');
      }
    }

    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return serveStatic(url.pathname, res);
  }

  function stream(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('state', mc.state.build());
    const throttle = opts.sseThrottleMs ?? 250;
    let timer: NodeJS.Timeout | null = null;
    let lastSent = Date.now();
    const offState = mc.state.subscribe(() => {
      if (timer) return;
      const wait = Math.max(0, throttle - (Date.now() - lastSent));
      timer = setTimeout(() => {
        timer = null;
        lastSent = Date.now();
        send('state', mc.state.build());
      }, wait);
    });
    const offActivity = mc.onActivity((e) => send('activity', e));
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      offState();
      offActivity();
      clearInterval(keepAlive);
      if (timer) clearTimeout(timer);
    });
  }

  function serveStatic(pathname: string, res: ServerResponse) {
    const root = opts.staticDir;
    const index = join(root, 'index.html');
    if (!existsSync(index)) {
      res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The Mission Control UI has not been built yet. Run `npm run build`, or use `npm run dev` for development.\n');
      return;
    }
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root + sep) && file !== root) throw new HttpError(400, 'Bad path');
    if (!existsSync(file) || statSync(file).isDirectory()) file = index; // SPA fallback
    const ext = extname(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  }

  return server;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
