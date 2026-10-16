import { expect, test, type Page } from '@playwright/test';

const CONTROL = 'http://127.0.0.1:4498';
const control = async <T = any>(path: string): Promise<T> => (await fetch(CONTROL + path, { method: "POST" })).json() as Promise<T>;

test.describe.serial('Mission Control UI (fake cmux)', () => {
  let ids: Record<string, string>;

  test.beforeAll(async () => {
    ids = await control('/ids');
  });

  const open = async (page: Page, path = '/') => {
    await page.goto(path);
    await expect(page.getByTestId('loading')).toHaveCount(0);
  };

  test('overview shows real-shaped workspaces, KPIs and the test-mode banner', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('banner-fixture')).toBeVisible();
    await expect(page.getByTestId('workspace-card')).toHaveCount(3);
    await expect(page.getByTestId('kpi-Workspaces')).toContainText('3');
    await expect(page.getByTestId('kpi-Tabs')).toContainText('5');
    await expect(page.getByTestId('agent-row')).toHaveCount(2);
    await expect(page.getByTestId('connection-card')).toContainText('Live');
  });

  test('workspace detail shows panes, tabs and non-agent surfaces correctly', async ({ page }) => {
    await open(page, `/workspaces/${ids.wsApi}`);
    await expect(page.getByTestId('workspace-title')).toHaveText('billing-api');
    await expect(page.getByTestId('surface-row')).toHaveCount(3);
    await expect(page.getByText('No agent detected — regular terminal')).toBeVisible();
    await expect(page.getByText('No agent — browser tab')).toBeVisible();
    await expect(page.getByText('Pane 2')).toBeVisible();
  });

  test('focusing a tab calls only allowlisted cmux navigation methods', async ({ page }) => {
    await open(page, `/workspaces/${ids.wsApi}`);
    await page.getByTestId('surface-jump').first().click();
    await expect(page.getByText('Focused tab in cmux')).toBeVisible();
    const calls = (await control('/calls')) as { method: string; params: Record<string, string> }[];
    const nav = calls.filter((c) => ['window.focus', 'workspace.select', 'surface.focus'].includes(c.method));
    expect(nav.slice(-3).map((c) => c.method)).toEqual(['window.focus', 'workspace.select', 'surface.focus']);
    expect(nav.at(-1)!.params.surface_id).toBe(ids.sClaude);
  });

  test('a permission request appears in the Attention Center and clears when resolved', async ({ page }) => {
    await open(page, '/attention');
    await control('/permission');
    const item = page.getByTestId('attention-page-list').getByTestId('attention-item').filter({ hasText: 'Permission request: Bash' });
    await expect(item).toBeVisible();
    await expect(item).toContainText('billing-api');
    await expect(page.getByTestId('attention-badge')).toBeVisible();
    await control('/resolve');
    await expect(item).toHaveCount(0);
  });

  test('a workspace created in cmux appears live', async ({ page }) => {
    await open(page, '/workspaces');
    await expect(page.getByTestId('workspace-card')).toHaveCount(3);
    await control('/workspace');
    await expect(page.getByTestId('workspace-card')).toHaveCount(4);
    await expect(page.getByText('docs-site')).toBeVisible();
  });

  test('terminal errors are surfaced with their workspace', async ({ page }) => {
    await open(page);
    await control('/error');
    await expect(page.getByTestId('kpi-With errors')).toContainText('1');
    await expect(page.getByTestId('attention-list')).toContainText('Process reported an error');
  });

  test('activity timeline lists events and filters by type', async ({ page }) => {
    await open(page, '/activity');
    await expect(page.getByTestId('activity-row').first()).toBeVisible();
    await page.getByLabel('Event type').selectOption('workspace.*');
    await expect(page.getByTestId('activity-row').first()).toContainText('docs-site');
    for (const row of await page.getByTestId('activity-row').all()) await expect(row).toContainText(/Workspace/);
  });

  test('prompt previews are hidden until enabled in Settings', async ({ page }) => {
    await open(page, `/workspaces/${ids.wsApi}`);
    await expect(page.getByText('hidden — enable prompt previews')).toBeVisible();
    await open(page, '/settings');
    await page.getByTestId('toggle-previews').click();
    await expect(page.getByTestId('toggle-previews')).toHaveAttribute('aria-checked', 'true');
    await open(page, `/workspaces/${ids.wsApi}`);
    await expect(page.getByText('Add pagination to the invoices endpoint')).toBeVisible();
    await open(page, '/settings');
    await page.getByTestId('toggle-previews').click();
    await expect(page.getByTestId('toggle-previews')).toHaveAttribute('aria-checked', 'false');
  });

  test('losing cmux shows a stale-data banner and recovers automatically', async ({ page }) => {
    await open(page);
    await control('/stop');
    await expect(page.getByTestId('banner-connection')).toContainText('Data shown may be stale');
    await expect(page.getByTestId('connection-card')).toContainText('Reconnecting');
    await control('/start');
    await expect(page.getByTestId('banner-connection')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('connection-card')).toContainText('Live');
  });
});
