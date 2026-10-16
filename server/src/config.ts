import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  host: string;
  port: number;
  socketPath: string;
  socketCandidates: string[];
  cmuxAppPath: string;
  cmuxCliPath: string | null;
  dataDir: string;
  staticDir: string;
  insideCmux: boolean;
  selfSurfaceId: string | null;
  selfWorkspaceId: string | null;
  /** Test-only: allows the fake cmux server used by integration and Playwright tests. */
  fixtureMode: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.MC_HOST ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) {
    throw new Error(`MC_HOST must be a loopback address (127.0.0.1, ::1, localhost); got "${host}"`);
  }
  const port = Number(env.MC_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid MC_PORT "${env.MC_PORT}"`);

  const home = homedir();
  const uid = process.getuid?.() ?? 0;
  // Same discovery order the cmux CLI reports when no socket is live.
  const socketCandidates = [
    join(home, '.local/state/cmux/cmux.sock'),
    '/tmp/cmux.sock',
    join(home, `.local/state/cmux/cmux-${uid}.sock`),
    `/tmp/cmux-${uid}.sock`,
  ];
  const explicit = env.CMUX_SOCKET_PATH || env.CMUX_SOCKET || null;
  const socketPath = explicit ?? socketCandidates.find((p) => existsSync(p)) ?? socketCandidates[0]!;

  const cmuxAppPath = env.MC_CMUX_APP_PATH ?? '/Applications/cmux.app';
  const bundledCli = env.CMUX_BUNDLED_CLI_PATH ?? join(cmuxAppPath, 'Contents/Resources/bin/cmux');

  const fixtureMode = env.MC_TEST_FAKE_CMUX === '1';
  if (fixtureMode && env.NODE_ENV === 'production') {
    throw new Error('MC_TEST_FAKE_CMUX is a test-only switch and cannot be used with NODE_ENV=production');
  }

  return {
    host,
    port,
    socketPath,
    socketCandidates,
    cmuxAppPath,
    cmuxCliPath: existsSync(bundledCli) ? bundledCli : null,
    dataDir: resolve(env.MC_DATA_DIR ?? join(home, '.cmux-mission-control')),
    staticDir: resolve(env.MC_STATIC_DIR ?? join(import.meta.dirname, '../../dist/web')),
    insideCmux: Boolean(env.CMUX_SURFACE_ID && env.CMUX_WORKSPACE_ID),
    selfSurfaceId: env.CMUX_SURFACE_ID ?? null,
    selfWorkspaceId: env.CMUX_WORKSPACE_ID ?? null,
    fixtureMode,
  };
}
