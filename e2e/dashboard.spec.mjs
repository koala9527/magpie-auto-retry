// Run: node --test e2e/dashboard.spec.mjs (Playwright is a development-only dependency).
// NODE_PATH can point to a preinstalled Playwright package; no UI build is required.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = process.env.AUTO_RETRY_FIXTURE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const PREFIX = '/plugins/magpie-auto-retry/service/';
const TOKEN = 'browser-fixture-admin-token';
const HOUR = 3_600_000;
const DEFAULTS = {
  enabled: true,
  upstreamUrl: 'http://127.0.0.1:3425',
  initialDelayMs: 2000,
  maxDelayMs: 60000,
  jitter: true,
  attemptTimeoutMs: 120000,
  streamIdleTimeoutMs: 120000,
  heartbeatMs: 10000,
  maxConcurrentRequests: 32,
  historyDays: 30,
};

function snapshot(overrides = {}) {
  const now = Date.now();
  return {
    version: '1.0.1', generatedAt: now, period: '24h',
    server: {
      port: 3430, proxyUrl: 'http://127.0.0.1:3430/v1',
      upstreamUrl: DEFAULTS.upstreamUrl, runningSince: now - HOUR,
      uptimeMs: HOUR, storageStatus: 'ok',
    },
    settings: { ...DEFAULTS },
    totals: {
      requests: 0, successes: 0, failures: 0, retries: 0,
      recoveredRequests: 0, failedRequests: 0, cancelledRequests: 0,
      interruptedStreams: 0, activeRequests: 0, waitingRequests: 0,
      availableMs: 0, unavailableMs: 0, observedMs: 0, availabilityPercent: null,
    },
    providers: [], activeRequests: [], incidents: [], events: [],
    ...overrides,
  };
}

function populated() {
  const state = snapshot();
  const hour = Math.floor(state.generatedAt / HOUR) * HOUR;
  state.totals = {
    ...state.totals, requests: 12, successes: 9, failures: 3, retries: 4,
    recoveredRequests: 2, activeRequests: 1, waitingRequests: 1,
    availableMs: 6_300_000, unavailableMs: 900_000, observedMs: 7_200_000,
    availabilityPercent: 87.5,
  };
  state.providers = [{
    id: 'fixture-provider', name: '测试提供商 A', status: 'outage',
    attribution: 'requested-model', requests: 12, successes: 9, failures: 3,
    retries: 4, recoveredRequests: 2, availableMs: 6_300_000,
    unavailableMs: 900_000, observedMs: 7_200_000, availabilityPercent: 87.5,
    lastSuccessAt: hour - HOUR, lastFailureAt: hour, lastErrorCode: 'http_503',
    consecutiveFailures: 3,
    buckets: [
      { startAt: hour - 2 * HOUR, availableMs: HOUR, unavailableMs: 0,
        requests: 4, successes: 4, failures: 0, retries: 0, recoveredRequests: 0 },
      { startAt: hour - HOUR, availableMs: 2_700_000, unavailableMs: 900_000,
        requests: 7, successes: 5, failures: 2, retries: 2, recoveredRequests: 2 },
      { startAt: hour, availableMs: 0, unavailableMs: 1000,
        requests: 1, successes: 0, failures: 1, retries: 2, recoveredRequests: 0 },
    ],
  }];
  state.activeRequests = [{
    id: 'request/with ?symbols#', providerId: 'fixture-provider', model: 'test/model',
    startedAt: state.generatedAt - 40000, attempt: 3,
    nextRetryAt: state.generatedAt + 8000, status: 'waiting', hasOutput: false,
  }];
  state.incidents = [{
    id: 'incident-1', providerId: 'fixture-provider', providerName: '测试提供商 A',
    startedAt: state.generatedAt - 10000, endedAt: null,
    durationMs: 10000, failures: 3, reason: 'http_503',
  }];
  state.events = [{
    id: 'event-1', time: state.generatedAt - 1000, type: 'retry',
    providerId: 'fixture-provider', attempt: 3, status: 503, delayMs: 8000, code: 'http_503',
  }];
  return state;
}

let browser;
let server;
let origin;
let sandboxSettings = { ...DEFAULTS };

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    // A real HTTP fixture (not route interception) exercises opaque Magpie iframe origins.
    if ([`${PREFIX}api/state`, `${PREFIX}api/export`, `${PREFIX}api/settings`].includes(url.pathname) && request.headers.origin === 'null') {
      const headers = { 'Access-Control-Allow-Origin': 'null', 'Content-Type': 'application/json',
        'Access-Control-Allow-Headers': 'X-Auto-Retry-Token, Content-Type', 'Access-Control-Allow-Methods': 'GET, PATCH, POST' };
      if (request.method === 'OPTIONS') { response.writeHead(204, headers).end(); return; }
      const valid = request.headers['x-auto-retry-token'] === TOKEN;
      if (valid && request.method === 'PATCH') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        sandboxSettings = { ...sandboxSettings, ...JSON.parse(Buffer.concat(chunks).toString()) };
      }
      const data = url.pathname.endsWith('api/settings') ? { settings: sandboxSettings }
        : url.pathname.endsWith('api/export') ? { schemaVersion: 1, providers: [], events: [], incidents: [] }
          : snapshot({ period: url.searchParams.get('period'), settings: { ...sandboxSettings } });
      response.writeHead(valid ? 200 : 401, headers).end(JSON.stringify(valid
        ? data : { error: { code: 'unauthorized', message: '测试令牌缺失' } }));
      return;
    }
    const launcher = url.pathname.startsWith('/launcher/');
    const relative = launcher ? url.pathname.slice('/launcher/'.length)
      : url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
    if (relative === null || relative.includes('..') || relative.includes('.verification')) {
      response.writeHead(404).end('Not found');
      return;
    }
    const filename = relative || 'index.html';
    const folder = launcher ? 'page' : 'ui';
    if (filename === '_magpie/bridge.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end('// Test bridge is intercepted.');
      return;
    }
    try {
      let bytes = await readFile(path.join(ROOT, folder, filename));
      const extension = path.extname(filename);
      if (extension === '.html') {
        bytes = bytes.toString().replace('__ADMIN_TOKEN__', url.searchParams.has('missingToken') ? '' : TOKEN);
      }
      response.writeHead(200, {
        'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[extension] || 'text/plain',
        'Cache-Control': 'no-store',
      }).end(bytes);
    } catch {
      response.writeHead(404).end('File not implemented');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
});

async function dashboard(t, options = {}) {
  const state = options.state || snapshot();
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 1000 },
    colorScheme: options.colorScheme || 'light', reducedMotion: options.reducedMotion || 'reduce',
  });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('localStorage is forbidden'); } });
    window.__testVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.__testVisibility });
    Object.defineProperty(document, 'hidden', { get: () => window.__testVisibility === 'hidden' });
  });
  const page = await context.newPage();
  const calls = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const call = {
      path: url.pathname, period: url.searchParams.get('period'),
      method: request.method(), headers: request.headers(),
      body: request.postData() ? JSON.parse(request.postData()) : null,
    };
    calls.push(call);
    const custom = await options.respond?.(call, state, calls);
    if (custom?.abort) return route.abort('connectionrefused');
    if (custom?.raw !== undefined) return route.fulfill({ status: custom.status || 200,
      contentType: 'application/json', body: custom.raw });
    if (custom) return route.fulfill({ status: custom.status || 200, json: custom.json });
    if (call.path.endsWith('api/state')) {
      state.period = call.period;
      state.generatedAt = Date.now();
      return route.fulfill({ json: state });
    }
    if (call.path.endsWith('api/settings')) {
      state.settings = { ...state.settings, ...call.body };
      return route.fulfill({ json: { settings: state.settings } });
    }
    if (call.path.endsWith('/cancel')) {
      const id = decodeURIComponent(call.path.slice(`${PREFIX}api/requests/`.length, -'/cancel'.length));
      state.activeRequests = state.activeRequests.filter(request => request.id !== id);
      state.totals.activeRequests = state.activeRequests.length;
      state.totals.waitingRequests = state.activeRequests.filter(request => request.status === 'waiting').length;
      return route.fulfill({ json: { ok: true } });
    }
    if (call.path.endsWith('api/statistics/reset')) {
      state.providers = []; state.incidents = []; state.events = [];
      state.totals = { ...snapshot().totals, activeRequests: state.activeRequests.length,
        waitingRequests: state.activeRequests.filter(request => request.status === 'waiting').length };
      return route.fulfill({ json: { ok: true } });
    }
    if (call.path.endsWith('api/export')) return route.fulfill({ json: { generatedAt: state.generatedAt,
      totals: state.totals, providers: state.providers, incidents: state.incidents, events: state.events } });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '测试接口不存在' } } });
  });
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], 'There must be no uncaught browser exceptions.');
  });
  await page.goto(`${origin}${PREFIX}${options.query || ''}`);
  if (options.wait !== false) {
    await page.waitForFunction(() => document.querySelector('#connection-label')?.dataset.state === 'connected',
      null, { timeout: 4000 });
  }
  return { page, calls, state, context };
}

async function waitText(page, selector, text) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text),
    { selector, text }, { timeout: 4000 });
}

async function screenshot(page, name) {
  if (!process.env.AUTO_RETRY_SCREENSHOTS) return;
  await mkdir(process.env.AUTO_RETRY_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.AUTO_RETRY_SCREENSHOTS, `${name}.png`), fullPage: true });
}

test('真实空态：不生成示例提供商，可用率未知，所有 API 带令牌和 web 前缀', async t => {
  const { page, calls } = await dashboard(t);
  assert.equal(await page.getByRole('heading', { name: '运行总览', exact: true }).count(), 1);
  assert.equal(await page.locator('.provider-item').count(), 0);
  assert.match(await page.locator('#providers-empty').innerText(), /尚无提供商观测/);
  assert.equal(await page.locator('[data-metric="availabilityPercent"]').innerText(), '—');
  assert.equal(await page.locator('[data-metric="waitingRequests"]').innerText(), '0');
  assert.equal(await page.locator('[data-metric="policy"]').innerText(), '∞');
  assert.match(await page.title(), /Magpie Auto Retry/);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(call.path.startsWith(PREFIX));
    assert.equal(call.headers['x-auto-retry-token'], TOKEN);
  }
  await screenshot(page, 'dashboard-empty-light');
});

test('Magpie 不透明 sandbox iframe 以 Origin null 和页面令牌读取真实 HTTP API', async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/sandbox-fixture', route => route.fulfill({ contentType: 'text/html',
    body: `<iframe title="Magpie sandbox" sandbox="allow-scripts" src="${origin}${PREFIX}"></iframe>` }));
  await page.goto(`${origin}/sandbox-fixture`);
  const frame = page.frameLocator('iframe');
  await frame.locator('#connection-label[data-state="connected"]').waitFor({ timeout: 4000 });
  assert.equal(await frame.locator('[data-metric="waitingRequests"]').innerText(), '0');
  assert.equal(await frame.locator('#connection-banner').isVisible(), false);
  await frame.getByLabel('初始退避').fill('3');
  await frame.getByRole('button', { name: '保存设置', exact: true }).click();
  await frame.locator('#form-status').filter({ hasText: '已保存' }).waitFor({ timeout: 4000 });
  assert.equal(sandboxSettings.initialDelayMs, 3000);
  await frame.getByLabel('初始退避').fill('3.5');
  await frame.getByLabel('初始退避').press('Enter');
  await frame.locator('#form-status').filter({ hasText: '已保存' }).waitFor({ timeout: 4000 });
  assert.equal(sandboxSettings.initialDelayMs, 3500);
  await frame.getByRole('button', { name: '导出 JSON', exact: true }).click();
  await frame.getByRole('dialog', { name: '聚合统计 JSON', exact: true }).waitFor();
  const json = await frame.locator('#export-json').inputValue();
  assert.equal(JSON.parse(json).schemaVersion, 1);
  assert.equal(await frame.locator('#download-export').isVisible(), false);
  await frame.getByRole('button', { name: '全选 JSON', exact: true }).click();
  assert.deepEqual(await frame.locator('#export-json').evaluate(node => ({
    focused: document.activeElement === node, selected: node.selectionEnd - node.selectionStart,
  })), { focused: true, selected: json.length });
  assert.match(await frame.locator('#export-status').innerText(), /Ctrl\+C/);
  await page.keyboard.press('Escape');
  await frame.locator('#export-dialog').waitFor({ state: 'hidden', timeout: 4000 });
  await frame.locator('#export-button:focus').waitFor({ timeout: 4000 });
  assert.equal(await frame.locator('#export-button').evaluate(node => document.activeElement === node), true);
});

test('真实快照：数字、按模型归属、小时混合/故障/未知、请求和事件', async t => {
  const { page } = await dashboard(t, { state: populated() });
  assert.equal(await page.locator('[data-metric="failures"]').innerText(), '3');
  assert.equal(await page.locator('[data-metric="recoveredRequests"]').innerText(), '2');
  assert.equal(await page.locator('[data-metric="availabilityPercent"]').innerText(), '87.5%');
  assert.match(await page.locator('[data-metric="availableMs"]').innerText(), /1.*45/);
  assert.match(await page.locator('.provider-item').innerText(), /按请求模型归属/);
  assert.equal(await page.locator('.hour-cell').count(), 24);
  assert.equal(await page.locator('.hour-healthy').count(), 1);
  assert.equal(await page.locator('.hour-mixed').count(), 1);
  assert.equal(await page.locator('.hour-outage').count(), 1);
  assert.equal(await page.locator('.hour-unknown').count(), 21);
  assert.match(await page.locator('.request-item').innerText(), /test\/model/);
  assert.match(await page.locator('.incident-item').innerText(), /进行中/);
  assert.match(await page.locator('.event-item').innerText(), /503/);
  await screenshot(page, 'dashboard-observed-light');
});

test('24h / 7d / 30d 请求参数与逐小时状态带', async t => {
  const { page, calls } = await dashboard(t, { state: populated() });
  for (const [label, period, hours] of [['7 天', '7d', 168], ['30 天', '30d', 720], ['24 小时', '24h', 24]]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('.hour-cell').length === count, hours);
    assert.ok(calls.some(call => call.period === period));
    assert.equal(await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true');
  }
});

test('未保存输入不被刷新覆盖，PATCH 以秒转毫秒且不写宿主 options', async t => {
  const { page, calls, state } = await dashboard(t);
  await page.getByLabel('初始退避').fill('2.5');
  state.settings.initialDelayMs = 8000;
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#refresh-button')?.disabled === false);
  assert.equal(await page.getByLabel('初始退避').inputValue(), '2.5');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await waitText(page, '#form-status', '已保存');
  const patch = calls.find(call => call.method === 'PATCH');
  assert.equal(patch.path, `${PREFIX}api/settings`);
  assert.equal(patch.body.initialDelayMs, 2500);
  assert.equal(patch.headers['x-auto-retry-token'], TOKEN);
  assert.equal(await page.locator('#dirty-state').innerText(), '已与服务同步');
});

test('完整设置保存：两种超时、心跳、并发、历史与本机上游', async t => {
  const { page, calls } = await dashboard(t);
  await page.getByLabel('启用自动重试').uncheck();
  await page.getByLabel('退避抖动').uncheck();
  for (const [label, value] of [['初始退避', '0.1'], ['最大退避', '3600'],
    ['单次请求超时', '1'], ['流空闲超时', '600'], ['等待心跳', '30'],
    ['最大并发请求', '256'], ['历史保留天数', '90'], ['本机 Magpie 上游地址', 'http://localhost:3425/v1']]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await waitText(page, '#form-status', '已保存');
  const patch = calls.find(call => call.method === 'PATCH').body;
  assert.equal(patch.enabled, false); assert.equal(patch.jitter, false);
  assert.equal(patch.initialDelayMs, 100); assert.equal(patch.maxDelayMs, 3_600_000);
  assert.equal(patch.attemptTimeoutMs, 1000); assert.equal(patch.streamIdleTimeoutMs, 600000);
  assert.equal(patch.heartbeatMs, 30000); assert.equal(patch.maxConcurrentRequests, 256);
  assert.equal(patch.historyDays, 90); assert.equal(patch.upstreamUrl, 'http://localhost:3425');
  assert.match(await page.locator('#policy-detail').innerText(), /停用/);
});

test('恢复默认只回填，既不 PATCH 也不被轮询覆盖', async t => {
  const state = snapshot({ settings: { ...DEFAULTS, initialDelayMs: 9000, enabled: false } });
  const { page, calls } = await dashboard(t, { state });
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  assert.equal(await page.getByLabel('初始退避').inputValue(), '2');
  assert.equal(await page.getByLabel('启用自动重试').isChecked(), true);
  await waitText(page, '#form-status', '尚未保存');
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  assert.equal(await page.getByLabel('初始退避').inputValue(), '2');
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 0);
});

test('空输入、越界、退避关系、非本机/回环上游都不发送 PATCH，错误可聚焦', async t => {
  const { page, calls } = await dashboard(t);
  const cases = [
    ['初始退避', '', 'initialDelayMs'], ['初始退避', '61', 'initialDelayMs'],
    ['最大退避', '1', 'maxDelayMs'], ['单次请求超时', '0.5', 'attemptTimeoutMs'],
    ['最大并发请求', '2.5', 'maxConcurrentRequests'], ['历史保留天数', '91', 'historyDays'],
    ['本机 Magpie 上游地址', 'https://example.com', 'upstreamUrl'],
    ['本机 Magpie 上游地址', 'http://127.0.0.1:3430', 'upstreamUrl'],
  ];
  for (const [label, value, id] of cases) {
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal(await page.locator(`#${id}`).getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator(`#${id}`).evaluate(node => document.activeElement === node), true);
  }
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 0);
});

test('422 字段错误与存储写入失败保留输入，绝不宣称已保存', async t => {
  const { page } = await dashboard(t, { respond: call => call.method === 'PATCH' ? {
    status: 422, json: { error: { code: 'storage_write_failed', message: '设置未写入磁盘',
      fields: { initialDelayMs: '请检查退避参数' } } },
  } : undefined });
  await page.getByLabel('初始退避').fill('3');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await waitText(page, '#form-status', '设置未写入磁盘');
  assert.equal(await page.getByLabel('初始退避').inputValue(), '3');
  assert.equal(await page.locator('#initialDelayMs').getAttribute('aria-invalid'), 'true');
  assert.match(await page.locator('#dirty-state').innerText(), /未保存/);
});

test('保存响应不会覆盖保存期间的新编辑', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { page, calls } = await dashboard(t, { respond: async (call, state) => {
    if (call.method !== 'PATCH') return;
    await pending;
    state.settings = { ...state.settings, ...call.body };
    return { json: { settings: state.settings } };
  } });
  await page.getByLabel('初始退避').fill('2.5');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#save-button')?.disabled);
  assert.ok(calls.some(call => call.method === 'PATCH'));
  await page.getByLabel('初始退避').fill('3');
  release();
  await waitText(page, '#form-status', '尚未保存');
  assert.equal(await page.getByLabel('初始退避').inputValue(), '3');
  assert.match(await page.locator('#dirty-state').innerText(), /未保存/);
});

test('首次断连不是正常空态；重新连接后才显示真实数字', async t => {
  let offline = true;
  const { page } = await dashboard(t, { wait: false,
    respond: call => call.path.endsWith('api/state') && offline ? { abort: true } : undefined });
  await waitText(page, '#connection-banner', '连接失败');
  assert.equal(await page.locator('[data-metric="waitingRequests"]').innerText(), '—');
  assert.match(await page.locator('#providers-empty').innerText(), /尚未取得服务数据/);
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
  offline = false;
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await waitText(page, '#connection-label', '已连接');
  assert.equal(await page.locator('[data-metric="waitingRequests"]').innerText(), '0');
});

test('后续断连保留并标记旧快照，不把当前请求伪装成已结束', async t => {
  let offline = false;
  const { page } = await dashboard(t, { state: populated(),
    respond: call => call.path.endsWith('api/state') && offline ? { abort: true } : undefined });
  offline = true;
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await waitText(page, '#connection-banner', '最近一次成功快照');
  assert.equal(await page.locator('[data-metric="failures"]').innerText(), '3');
  assert.equal(await page.locator('.request-item').count(), 1);
  assert.equal(await page.getByRole('button', { name: /取消请求/ }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '导出 JSON', exact: true }).isDisabled(), true);
});

test('memory-only 存储降级醒目显示，不宣称统计已持久化', async t => {
  const state = snapshot(); state.server.storageStatus = 'memory-only';
  const { page } = await dashboard(t, { state });
  await waitText(page, '#storage-banner', '仅保存在内存');
  assert.equal(await page.locator('#storage-banner').isVisible(), true);
  await screenshot(page, 'dashboard-memory-only');
});

test('无效 JSON 和不完整快照都报告接口错误，不回填默认或正常数字', async t => {
  for (const response of [{ raw: '{ broken' }, { json: { settings: DEFAULTS } }, { json: snapshot({ generatedAt: Number.MAX_SAFE_INTEGER }) }]) {
    const { page } = await dashboard(t, { wait: false, respond: () => response });
    await waitText(page, '#connection-banner', '数据');
    assert.equal(await page.locator('[data-metric="failures"]').innerText(), '—');
    assert.equal(await page.getByLabel('初始退避').inputValue(), '');
  }
});

test('缺少页面令牌不调用 API；403 显示真实认证错误', async t => {
  const missing = await dashboard(t, { wait: false, query: '?missingToken=1' });
  await waitText(missing.page, '#connection-banner', '页面令牌');
  assert.equal(missing.calls.length, 0);
  const forbidden = await dashboard(t, { wait: false, respond: () => ({ status: 403,
    json: { error: { code: 'forbidden', message: '页面令牌已失效，请重新打开页面' } } }) });
  await waitText(forbidden.page, '#connection-banner', '令牌已失效');
  assert.equal(await forbidden.page.locator('[data-metric="availabilityPercent"]').innerText(), '—');
});

test('取消当前请求：编码 id、真实成功后刷新、防止重复，全部携带令牌', async t => {
  const { page, calls } = await dashboard(t, { state: populated() });
  await page.getByRole('button', { name: /取消请求/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.request-item').length === 0);
  const cancellations = calls.filter(call => call.path.endsWith('/cancel'));
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].path, `${PREFIX}api/requests/${encodeURIComponent('request/with ?symbols#')}/cancel`);
  assert.equal(cancellations[0].method, 'POST');
  assert.equal(cancellations[0].headers['x-auto-retry-token'], TOKEN);
  await waitText(page, '#action-status', '已取消');
});

test('取消失败仍保留请求，明确错误且允许再次操作', async t => {
  const { page } = await dashboard(t, { state: populated(), respond: call => call.path.endsWith('/cancel') ? {
    status: 500, json: { error: { code: 'cancel_failed', message: '取消操作失败' } },
  } : undefined });
  await page.getByRole('button', { name: /取消请求/ }).click();
  await waitText(page, '#action-status', '取消操作失败');
  assert.equal(await page.locator('.request-item').count(), 1);
  assert.equal(await page.getByRole('button', { name: /取消请求/ }).isEnabled(), true);
});

test('重置统计必须确认，Escape 无请求，确认后活跃请求保留并恢复焦点', async t => {
  const { page, calls } = await dashboard(t, { state: populated() });
  await page.getByRole('button', { name: '重置统计', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('button', { name: '保留统计', exact: true }).evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Escape');
  assert.equal(calls.filter(call => call.path.endsWith('api/statistics/reset')).length, 0);
  await page.getByRole('button', { name: '重置统计', exact: true }).click();
  await page.getByRole('button', { name: '确认重置', exact: true }).click();
  await waitText(page, '#action-status', '已重置');
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  assert.equal(await page.locator('.request-item').count(), 1);
  const reset = calls.find(call => call.path.endsWith('api/statistics/reset'));
  assert.deepEqual(reset.body, { confirm: true });
  assert.equal(reset.method, 'POST'); assert.equal(reset.headers['x-auto-retry-token'], TOKEN);
  assert.equal(await page.locator('#reset-statistics').evaluate(node => document.activeElement === node), true);
});

test('重置失败保留确认框和现有统计', async t => {
  const { page } = await dashboard(t, { state: populated(), respond: call => call.path.endsWith('api/statistics/reset') ? {
    status: 500, json: { error: { code: 'storage_failed', message: '历史存储重置失败' } },
  } : undefined });
  await page.getByRole('button', { name: '重置统计', exact: true }).click();
  await page.getByRole('button', { name: '确认重置', exact: true }).click();
  await waitText(page, '#reset-status', '历史存储重置失败');
  assert.equal(await page.getByRole('dialog').isVisible(), true);
  assert.equal(await page.locator('[data-metric="failures"]').innerText(), '3');
});

test('导出先展示可全选 JSON；独立浏览器显式发起下载，不混入令牌或预宣称保存成功', async t => {
  const { page, calls } = await dashboard(t, { state: populated() });
  let downloads = 0; page.on('download', () => { downloads += 1; });
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  await page.getByRole('dialog', { name: '聚合统计 JSON', exact: true }).waitFor();
  const json = await page.locator('#export-json').inputValue();
  assert.equal(JSON.parse(json).totals.failures, 3);
  assert.equal(json.includes(TOKEN), false);
  assert.equal(downloads, 0);
  await page.getByRole('button', { name: '全选 JSON', exact: true }).click();
  assert.equal(await page.locator('#export-json').evaluate(node => node.selectionEnd - node.selectionStart), json.length);
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: '下载 JSON', exact: true }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks).toString();
  assert.equal(JSON.parse(bytes).totals.failures, 3);
  assert.equal(bytes.includes(TOKEN), false);
  assert.match(download.suggestedFilename(), /^magpie-auto-retry-.*\.json$/);
  assert.equal(calls.find(call => call.path.endsWith('api/export')).headers['x-auto-retry-token'], TOKEN);
  assert.equal(calls.filter(call => call.path.endsWith('api/export')).length, 1);
  assert.match(await page.locator('#export-status').innerText(), /发起下载/);
  assert.doesNotMatch(await page.locator('#export-status').innerText(), /已导出|已保存|下载成功/);
  await page.getByRole('button', { name: '关闭导出', exact: true }).click();
  // The dialog's close event is queued by the browser. Await its focus handler,
  // rather than racing that task on a faster Linux headless browser.
  await page.waitForFunction(() => document.activeElement === document.getElementById('export-button'));
  assert.equal(await page.locator('#export-button').evaluate(node => document.activeElement === node), true);
});

test('实际滚动章节更新导航；从设置回到顶部恢复总览高亮', async t => {
  const { page } = await dashboard(t, { state: populated() });
  // The compact two-column layout exposes the first setting at page top.
  await page.locator('.main-nav a[href="#settings"]').click();
  await page.waitForFunction(() => document.querySelector('.main-nav [aria-current]')?.hash === '#settings');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => document.querySelector('.main-nav [aria-current]')?.hash === '#overview');
  assert.equal(await page.locator('.main-nav [aria-current]').count(), 1);
});

test('双栏导航按点击的章节高亮，不被另一栏的同高章节覆盖', async t => {
  const { page } = await dashboard(t, { state: populated() });
  for (const id of ['providers', 'settings', 'requests', 'how-it-works', 'overview']) {
    await page.locator(`.main-nav a[href="#${id}"]`).click();
    await page.waitForFunction(id => document.querySelector('.main-nav [aria-current]')?.hash === `#${id}`, id, { timeout: 4000 });
    assert.equal(await page.locator('.main-nav [aria-current]').count(), 1);
  }
});

test('不可信名称、模型与错误只作为文本；长内容也不横向撑开', async t => {
  const state = populated();
  const hostile = '<img src=x onerror="window.__xss=1">';
  state.providers[0].name = hostile; state.activeRequests[0].model = `${hostile}${'a'.repeat(1500)}`;
  state.incidents[0].reason = hostile; state.events[0].code = hostile;
  const { page } = await dashboard(t, { state, viewport: { width: 390, height: 844 } });
  assert.equal(await page.locator('.provider-item img').count(), 0);
  assert.match(await page.locator('.provider-name').innerText(), /<img/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test('390px 深/浅主题、减少动画、全部设置可达且无横滚', async t => {
  const { page } = await dashboard(t, { state: populated(), viewport: { width: 390, height: 844 }, query: '?theme=dark&lang=zh-TW' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-TW');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByLabel('显示主题').selectOption('light');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByLabel('历史保留天数').scrollIntoViewIfNeeded();
  assert.equal(await page.getByLabel('历史保留天数').isVisible(), true);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await screenshot(page, 'dashboard-mobile-light');
  await page.getByLabel('显示主题').selectOption('dark');
  await screenshot(page, 'dashboard-mobile-dark');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test('键盘小时带、可见焦点、刷新保留聚焦控件，aria-live 通知', async t => {
  const { page } = await dashboard(t, { state: populated() });
  const first = page.locator('.hour-cell').first();
  await first.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.hour-cell').nth(1).evaluate(node => document.activeElement === node), true);
  assert.match(await page.locator('.hour-detail').innerText(), /观测/);
  assert.notEqual(await page.locator('.hour-cell').nth(1).evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  await page.getByLabel('初始退避').focus();
  await page.evaluate(() => document.querySelector('#refresh-button').click());
  await page.waitForFunction(() => document.querySelector('#refresh-button')?.disabled === false);
  assert.equal(await page.getByLabel('初始退避').evaluate(node => document.activeElement === node), true);
  assert.equal(await page.locator('#action-status').getAttribute('aria-live'), 'polite');
  assert.equal(await page.locator('#form-status').getAttribute('aria-live'), 'polite');
});

test('每 3 秒轮询；隐藏页面暂停，恢复可见时立即刷新', async t => {
  const { page, calls } = await dashboard(t);
  const stateCalls = () => calls.filter(call => call.path.endsWith('api/state')).length;
  const first = stateCalls();
  await page.waitForTimeout(3200);
  assert.ok(stateCalls() > first);
  await page.evaluate(() => { window.__testVisibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
  const hidden = stateCalls(); await page.waitForTimeout(3300);
  assert.equal(stateCalls(), hidden);
  await page.evaluate(() => { window.__testVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#refresh-button')?.disabled === false);
  await page.waitForTimeout(100);
  assert.ok(stateCalls() > hidden);
});

async function launcher(t, bridgeSource) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/_magpie/bridge.js', route => route.fulfill({ contentType: 'text/javascript', body: bridgeSource }));
  await page.route('**/launched/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Dashboard target</title><p>Redirect observed</p>' }));
  await page.goto(`${origin}/launcher/`);
  return page;
}

test('参考风格：灰白页面、小字号、横向导航和双栏内容；深色也不引入彩色', async t => {
  const { page } = await dashboard(t, { state: populated() });
  const inspect = () => page.evaluate(() => {
    const style = selector => getComputedStyle(document.querySelector(selector));
    const root = getComputedStyle(document.documentElement);
    return {
      background: style('body').backgroundColor,
      panel: style('#settings').backgroundColor,
      bodySize: parseFloat(style('body').fontSize),
      headingSize: parseFloat(style('h1').fontSize),
      nav: style('.main-nav').flexDirection,
      colors: ['--ink', '--accent', '--healthy', '--outage', '--danger', '--warning'].map(key => root.getPropertyValue(key).trim()),
    };
  });
  const light = await inspect();
  assert.equal(light.background, 'rgb(245, 245, 247)');
  assert.equal(light.panel, 'rgb(255, 255, 255)');
  assert.ok(light.bodySize <= 12 && light.headingSize <= 20);
  assert.equal(light.nav, 'row');
  for (const color of light.colors) assert.match(color, /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i);
  const positions = await page.evaluate(() => ({ providers: document.querySelector('#providers').getBoundingClientRect().toJSON(), settings: document.querySelector('#settings').getBoundingClientRect().toJSON() }));
  assert.ok(positions.settings.left >= positions.providers.right);
  await page.locator('#theme-select').selectOption('dark');
  for (const color of (await inspect()).colors) assert.match(color, /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i);
  await page.locator('#theme-select').selectOption('light');
  await page.locator('#overview-title').click();
  await page.keyboard.press('Control+Home');
  await screenshot(page, 'compact-desktop');
});

test('封号与费用风险常驻显示；断开服务也不隐藏；开关关联风险说明', async t => {
  const { page } = await dashboard(t, { wait: false, respond: () => ({ abort: true }) });
  await waitText(page, '#connection-banner', '连接失败');
  await page.locator('#retry-risk').waitFor({ state: 'visible' });
  assert.match(await page.locator('#retry-risk').innerText(), /封号/);
  assert.match(await page.locator('#retry-risk').innerText(), /费用/);
  assert.match(await page.locator('#enabled').getAttribute('aria-describedby'), /settings-risk/);
  assert.match(await page.locator('#settings-risk').innerText(), /封号/);
});

test('每项参数都有通俗解释；心跳不是探活、退避不是总等待时限', async t => {
  const { page } = await dashboard(t);
  const hints = {
    initialDelayMs: /第一次重试.*2 秒/,
    maxDelayMs: /不是.*总.*时.*Retry-After/s,
    attemptTimeoutMs: /响应头.*非流式/,
    streamIdleTimeoutMs: /收到.*数据.*重新计时/,
    heartbeatMs: /不会.*调用.*模型/,
    maxConcurrentRequests: /32.*满.*429/s,
    historyDays: /统计.*不是.*聊天/,
    upstreamUrl: /3425.*3430/,
  };
  for (const [key, pattern] of Object.entries(hints)) assert.match(await page.locator(`#${key}-hint`).innerText(), pattern);
  assert.match(await page.locator('#jitter-hint').innerText(), /25%/);
  assert.match(await page.locator('#enabled-hint').innerText(), /只尝试一次/);
  await page.getByLabel('初始退避', { exact: true }).fill('3');
  assert.match(await page.locator('#policy-preview').innerText(), /先等 3 秒.*逐次加倍.*每次最多 60 秒.*尚未保存/);
});

test('页面流程说明包括成功继续、永久错误、部分输出不重放和退出终止', async t => {
  const { page } = await dashboard(t, { viewport: { width: 390, height: 844 } });
  const text = await page.locator('#how-it-works').innerText();
  for (const pattern of [/3430.*3425/s, /2 → 4 → 8 → 16 → 32 → 60/, /401.*403/, /文本.*思考.*工具/, /退出.*重启/]) assert.match(text, pattern);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot(page, 'compact-mobile');
});

test('官方启动页先等 ready，再读取端口；优先 service 并传递 theme/lang，replace 不留启动历史', async t => {
  const page = await launcher(t, `
    window.__order = [];
    window.magpie = {
      ready: new Promise(resolve => { window.__ready = () => { window.__order.push('ready'); resolve(); }; }),
      theme: { dark: true, lang: 'zh-TW' }, service: '${origin}/launched/service/?keep=1',
      options: { get: async () => { window.__order.push('options'); return { port: 4001, theme: 'light', lang: 'xx', upstreamUrl: 'https://ignored.invalid' }; } }
    };
  `);
  assert.deepEqual(await page.evaluate(() => window.__order), []);
  assert.ok(page.url().endsWith('/launcher/'));
  await page.evaluate(() => window.__ready());
  await page.waitForURL('**/launched/service/**');
  const url = new URL(page.url());
  assert.equal(url.searchParams.get('theme'), 'dark');
  assert.equal(url.searchParams.get('lang'), 'zh-TW');
  assert.equal(url.searchParams.get('keep'), '1');
  assert.equal(url.port, new URL(origin).port);
  assert.equal(await page.evaluate(() => history.length), 2);
});

test('启动页没有 service 时使用端口，缺省为 3430，浅色与语言来自 bridge', async t => {
  for (const [options, port] of [['{}', 3430], ['{port: "4001"}', 4001]]) {
    const context = await browser.newContext(); t.after(() => context.close());
    const page = await context.newPage();
    await page.route('**/_magpie/bridge.js', route => route.fulfill({ contentType: 'text/javascript', body:
      `window.magpie = {ready: Promise.resolve(), theme: {dark: false, lang: 'en'}, options: {get: async () => (${options})}};` }));
    await page.route(`http://127.0.0.1:${port}/**`, route => route.fulfill({ contentType: 'text/html', body: '<title>Port target</title>' }));
    await page.goto(`${origin}/launcher/`);
    await page.waitForURL(`http://127.0.0.1:${port}/**`);
    assert.equal(new URL(page.url()).searchParams.get('theme'), 'light');
    assert.equal(new URL(page.url()).searchParams.get('lang'), 'en');
  }
});

test('启动页端口、service 和 bridge 异常不静默跳转到伪正常服务', async t => {
  const sources = [
    `window.magpie = {ready: Promise.resolve(), theme: {dark: false, lang: 'zh'}, options: {get: async () => ({port: 'bad'})}};`,
    `window.magpie = {ready: Promise.resolve(), theme: {dark: false, lang: 'zh'}, service: 'javascript:alert(1)', options: {get: async () => ({})}};`,
    `window.magpie = {ready: Promise.resolve(), theme: {dark: false, lang: 'zh'}, options: {get: async () => {throw new Error('宿主选项读取失败');}}};`,
    `window.magpie = {ready: Promise.reject(new Error('bridge 未就绪')), options: {get: async () => ({})}};`,
    '// No bridge available',
  ];
  for (const source of sources) {
    const page = await launcher(t, source);
    await page.locator('#launch-error').waitFor({ state: 'visible' });
    assert.ok(page.url().endsWith('/launcher/'));
    assert.equal(await page.getByRole('button', { name: '重新连接', exact: true }).isVisible(), true);
    assert.match(await page.locator('#launch-status').innerText(), /未能打开/);
  }
});
