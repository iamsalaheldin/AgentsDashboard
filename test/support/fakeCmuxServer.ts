// Standalone fake cmux for Playwright and isolated UI previews ONLY.
//   node test/support/fakeCmuxServer.ts <socketPath> <controlPort>
// The control port (loopback) lets tests drive scenarios: POST /permission, /resolve,
// /error, /workspace, /stop, /start.
import { createServer } from 'node:http';
import { FakeCmux, seedDemo, uuid, type FakeFeedItem } from './fakeCmux.ts';

const socketPath = process.argv[2] ?? process.env.FAKE_CMUX_SOCKET;
const controlPort = Number(process.argv[3] ?? process.env.FAKE_CMUX_CONTROL_PORT ?? 4398);
if (!socketPath) throw new Error('usage: fakeCmuxServer.ts <socketPath> [controlPort]');

const fake = new FakeCmux({ socketPath, heartbeatSeconds: 2 });
const demo = seedDemo(fake);
await fake.start();
// A little real-looking history: a session start and a completed turn on the Codex agent.
fake.hook('claude', demo.claude.sessionId, 'SessionStart', demo.claude);
fake.hook('claude', demo.claude.sessionId, 'UserPromptSubmit', demo.claude);
fake.hook('codex', demo.codex.sessionId, 'Stop', demo.codex);
fake.notifications.push({ id: uuid(), title: 'Build finished', body: 'web-app: vite build completed', isRead: false, workspaceId: demo.ids.wsWeb, surfaceId: null });

let pending: FakeFeedItem | null = null;
const routes: Record<string, () => Promise<unknown> | unknown> = {
  '/permission': () => (pending = fake.requestPermission(demo.claude, 'Bash')),
  '/resolve': () => pending && fake.resolvePermission(pending, demo.claude, 'allow'),
  '/error': () => fake.programStatus(demo.ids.wsOps, demo.ids.sShell, 'error'),
  '/workspace': () => {
    const id = uuid();
    fake.addWorkspace(fake.windows[0]!.id, { id, title: 'docs-site', cwd: '/Users/dev/src/docs', branch: 'main', panes: [{ id: uuid(), surfaces: [{ id: uuid(), type: 'terminal', title: 'zsh' }] }] });
    return { id };
  },
  '/stop': () => fake.stop(),
  '/start': () => fake.start(),
  '/calls': () => fake.calls,
  '/ids': () => demo.ids,
};

createServer(async (req, res) => {
  const fn = routes[req.url ?? ''];
  if (!fn) {
    res.writeHead(404).end();
    return;
  }
  const out = await fn();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? { ok: true }));
}).listen(controlPort, '127.0.0.1', () => process.stdout.write(`fake cmux on ${socketPath}, control :${controlPort}\n`));
