import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// UI smoke tests run the production server against the test-only fake cmux socket.
// They prove the UI wiring, not live cmux integration (see `npm run verify:live`).
const dir = process.env.MC_E2E_DIR ?? mkdtempSync(join(tmpdir(), 'mc-e2e-'));
process.env.MC_E2E_DIR = dir;
const socket = join(dir, 'cmux.sock');
export const CONTROL = 'http://127.0.0.1:4498';

export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4490', trace: 'retain-on-failure', viewport: { width: 1600, height: 1000 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
  webServer: [
    {
      command: `node test/support/fakeCmuxServer.ts ${socket} 4498`,
      url: `${CONTROL}/ids`,
      reuseExistingServer: false,
      stdout: 'ignore',
    },
    {
      command: 'node server/src/main.ts',
      url: 'http://127.0.0.1:4490/api/health',
      reuseExistingServer: false,
      env: { MC_PORT: '4490', MC_TEST_FAKE_CMUX: '1', CMUX_SOCKET_PATH: socket, MC_DATA_DIR: join(dir, 'data'), MC_LOG_LEVEL: 'warn' },
    },
  ],
});
