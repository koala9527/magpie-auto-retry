import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';

test('settings save and reload use the actual management API', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#settings-fields')).toBeEnabled();
  await page.getByLabel('初始退避', { exact: true }).fill('3');
  const saved = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PATCH');
  await page.locator('#save-button').click();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(page.getByLabel('初始退避', { exact: true })).toHaveValue('3');
  expect(errors).toEqual([]);
});

test('a real provider failure and recovery are displayed and exported', async ({ page, request, baseURL }) => {
  let attempts = 0;
  const upstream = createServer((_, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (++attempts <= 2) { res.writeHead(503); res.end('{"error":{"code":"server_error"}}'); }
    else res.end('{"choices":[{"message":{"content":"recovered"}}]}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto('/');
    await expect(page.locator('#settings-fields')).toBeEnabled();
    const token = await page.locator('meta[name="auto-retry-token"]').getAttribute('content');
    const headers = { 'X-Auto-Retry-Token': token };
    await request.post(`${baseURL}/api/statistics/reset`, { headers, data: { confirm: true } });
    const patch = await request.patch(`${baseURL}/api/settings`, { headers, data: {
      upstreamUrl: `http://127.0.0.1:${upstream.address().port}`, enabled: true, initialDelayMs: 100, maxDelayMs: 100, jitter: false,
    } });
    expect(patch.status()).toBe(200);
    const reply = await request.post(`${baseURL}/v1/chat/completions`, { data: { model: 'fixture/model', messages: [{ role: 'user', content: 'fixture' }] } });
    expect(reply.status()).toBe(200);
    expect(attempts).toBe(3);
    await page.locator('#refresh-button').click();
    await expect(page.locator('[data-metric="failures"]')).toHaveText('2');
    await expect(page.locator('[data-metric="recoveredRequests"]')).toHaveText('1');
    await expect(page.locator('#provider-list')).toContainText('fixture');
    await expect(page.locator('#incident-list')).toContainText('503');
    const exported = await request.get(`${baseURL}/api/export`, { headers });
    expect(exported.status()).toBe(200);
    expect((await exported.json()).providers[0].id).toBe('fixture');
    await mkdir('.local', { recursive: true });
    await page.locator('#overview-title').click();
    await page.keyboard.press('Control+Home');
    await page.screenshot({ path: '.local/dashboard-desktop.png' });
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('390px layout, theme and focus work against the live service', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?theme=dark');
  await expect(page.locator('#settings-fields')).toBeEnabled();
  const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(width.page).toBeLessThanOrEqual(width.viewport);
  await page.locator('#theme-select').selectOption('dark');
  await page.keyboard.press('Tab');
  await page.locator('#overview-title').click();
  await page.keyboard.press('Control+Home');
  await mkdir('.local', { recursive: true });
  await page.screenshot({ path: '.local/dashboard-mobile.png' });
});
