import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../server/src/config.ts';
import type { RawEvent } from '../../server/src/cmux/schemas.ts';
import { parseFrame } from '../../server/src/cmux/schemas.ts';

export const FIXTURES = join(import.meta.dirname, '../fixtures');
export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

export function fixtureEvents(name: string): RawEvent[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => parseFrame(l))
    .flatMap((f) => (f.kind === 'event' ? [f.event] : []));
}

export function tempDir(prefix = 'mc-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testConfig(dir: string, overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    socketPath: join(dir, 'cmux.sock'),
    socketCandidates: [],
    cmuxAppPath: dir, // exists, so cmux counts as installed unless a test overrides it
    cmuxCliPath: null,
    dataDir: join(dir, 'data'),
    staticDir: join(dir, 'static'),
    insideCmux: true,
    selfSurfaceId: null,
    selfWorkspaceId: null,
    fixtureMode: true,
    ...overrides,
  };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
