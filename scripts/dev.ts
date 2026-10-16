// `npm run dev`: backend with --watch plus the Vite dev server (proxying /api).
// Run it from a cmux terminal so the backend can reach the cmux socket.
import { spawn } from 'node:child_process';

const env = { ...process.env, MC_DEV_ORIGIN: 'http://127.0.0.1:5173,http://localhost:5173', MC_STATIC_DIR: '/nonexistent' };
const procs = [
  spawn('node', ['--watch', 'server/src/main.ts'], { stdio: 'inherit', env }),
  spawn('npx', ['vite', '--config', 'web/vite.config.ts'], { stdio: 'inherit', env }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => (code ? (stop(), process.exit(code)) : undefined));
