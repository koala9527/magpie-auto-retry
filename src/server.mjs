import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { Storage } from './storage.mjs';
import { DEFAULT_SETTINGS, normalizeSettings, validateSettings } from './settings.mjs';
import { Statistics } from './statistics.mjs';
import { RetryEngine, readBounded } from './retry.mjs';
import { protocolError } from './sse.mjs';

const VERSION = '1.0.1';
const MAX_REQUEST = 16 * 1024 * 1024;
const ignoredHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'cookie', 'set-cookie', 'x-auto-retry-token']);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
const filterHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([k, v]) => !ignoredHeaders.has(k.toLowerCase()) && typeof v === 'string'));
const apiError = (code, status, message, fields) => Object.assign(new Error(message), { code, status, fields });

async function requestBody(req, limit) {
  const length = Number(req.headers['content-length']);
  if (length > limit) throw apiError('REQUEST_TOO_LARGE', 413, '请求超过内存限制。');
  const parts = [];
  let total = 0;
  for await (const part of req) {
    total += part.length;
    if (total > limit) throw apiError('REQUEST_TOO_LARGE', 413, '请求超过内存限制。');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function jsonBody(bytes) {
  try {
    const result = JSON.parse(bytes.toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw apiError('INVALID_JSON', 400, '请求必须是 JSON 对象。'); }
}

function equalToken(actual, expected) {
  return typeof actual === 'string' && actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export async function createRetryServer({ port = 3430, dataDir, settings: initial = {}, providerMetadata = false, fetchImpl, now = Date.now } = {}) {
  if (!dataDir) throw new Error('A dedicated dataDir is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listen port.');
  const storage = new Storage(dataDir);
  const persisted = await storage.read('settings.json');
  let settings = validateSettings(normalizeSettings({ ...initial, ...persisted }), DEFAULT_SETTINGS, port);
  const statistics = new Statistics({ now, saved: await storage.read('statistics.json'), historyDays: settings.historyDays });
  const engine = new RetryEngine({ statistics, getSettings: () => settings, providerMetadata, fetchImpl });
  const token = randomBytes(32).toString('hex');
  const runningSince = now();
  let address = '';
  let actualPort = port;
  let closing = false;
  const admissions = new Set();
  const sendJson = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const snapshot = period => ({ version: VERSION, ...statistics.snapshot(period), settings,
    server: { port: actualPort, proxyUrl: `${address}/v1`, upstreamUrl: settings.upstreamUrl, runningSince, uptimeMs: Math.max(0, now() - runningSince), storageStatus: storage.status, admittedRequests: admissions.size } });
  const flush = () => storage.write('statistics.json', statistics.serialize());

  function reserve(res) {
    if (closing || admissions.size >= settings.maxConcurrentRequests) {
      res.setHeader('Retry-After', '1');
      throw apiError('CONCURRENCY_LIMIT', 429, '重试服务并发已满。');
    }
    const controller = new AbortController();
    admissions.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    return { controller, release() { admissions.delete(controller); res.removeListener('close', abort); } };
  }

  async function listModels(req, res, path) {
    const reservation = reserve(res);
    const { controller } = reservation;
    const timeout = setTimeout(() => controller.abort(), settings.attemptTimeoutMs);
    try {
      const response = await fetch(`${settings.upstreamUrl}${path}`, { headers: filterHeaders(req.headers), signal: controller.signal, redirect: 'manual' });
      const bytes = await readBounded(response);
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(bytes);
    } finally { clearTimeout(timeout); reservation.release(); }
  }

  async function administer(req, res, path, url) {
    if (!equalToken(req.headers['x-auto-retry-token'], token)) throw apiError('UNAUTHORIZED', 401, '页面会话已失效，请刷新页面。');
    if (req.method === 'GET' && path === '/api/state') { sendJson(res, 200, snapshot(url.searchParams.get('period') || '24h')); return; }
    if (req.method === 'GET' && path === '/api/export') {
      res.setHeader('Content-Disposition', 'attachment; filename="magpie-auto-retry-statistics.json"');
      sendJson(res, 200, statistics.serialize()); return;
    }
    if (req.method === 'PATCH' && path === '/api/settings') {
      const patch = jsonBody(await requestBody(req, 16384));
      const next = validateSettings(patch, settings, actualPort);
      try { await storage.write('settings.json', next); }
      catch { throw apiError('STORAGE_UNAVAILABLE', 503, '设置尚未保存，请检查数据目录。'); }
      settings = next;
      statistics.historyDays = settings.historyDays;
      statistics.prune();
      sendJson(res, 200, { settings }); return;
    }
    if (req.method === 'POST' && path === '/api/statistics/reset') {
      if (jsonBody(await requestBody(req, 1024)).confirm !== true) throw apiError('CONFIRMATION_REQUIRED', 422, '请确认清空统计。');
      statistics.reset(); await flush(); sendJson(res, 200, { ok: true }); return;
    }
    const cancellation = /^\/api\/requests\/([a-f0-9-]{36})\/cancel$/.exec(path);
    if (req.method === 'POST' && cancellation) {
      if (!engine.cancel(cancellation[1])) throw apiError('REQUEST_NOT_FOUND', 404, '该请求已经结束。');
      sendJson(res, 200, { ok: true }); return;
    }
    throw apiError('NOT_FOUND', 404, '管理接口不存在。');
  }

  async function infer(req, res, path) {
    if (req.headers.origin !== undefined) throw apiError('ORIGIN_FORBIDDEN', 403, '推理接口仅供本机 Agent 访问。');
    if (req.headers['x-auto-retry-hop']) throw apiError('PROXY_LOOP', 508, '检测到重试代理回环。');
    const reservation = reserve(res);
    const { controller } = reservation;
    let bytes;
    let body;
    try { bytes = await requestBody(req, MAX_REQUEST); body = jsonBody(bytes); }
    catch (error) { reservation.release(); throw error; }
    const stream = body.stream === true || path.includes('streamGenerateContent');
    const protocol = path.includes('/messages') ? 'anthropic' : path.includes('/responses') ? 'responses' : path.includes('/models/') ? 'gemini' : 'chat';
    const routePath = path.split('?')[0];
    // Magpie's native Gemini handler reads provider/model (including tags)
    // from the URL. Keep that identity separate from the unmodified body.
    const model = protocol === 'gemini' ? routePath.slice('/v1beta/models/'.length, routePath.lastIndexOf(':')) : body.model;
    let heartbeat;
    const beat = () => {
      if (!res.writableEnded && !res.destroyed && res.writableLength < 65536) {
        if (res.headersSent && !String(res.getHeader('Content-Type')).includes('text/event-stream')) return;
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        res.write(': auto-retry waiting\n\n');
      }
    };
    // Slow first headers need keepalive too, not only a previously failed attempt.
    if (stream) heartbeat = setInterval(beat, settings.heartbeatMs);
    const waiting = () => {
      if (!stream) return;
      beat();
      if (!heartbeat) heartbeat = setInterval(beat, settings.heartbeatMs);
    };
    try {
      await engine.execute({ path, bytes, body, model, headers: filterHeaders(req.headers), signal: controller.signal,
        onWaiting: waiting,
        onHeaders: (status, headers) => {
          if (!headers.get('content-type')?.includes('text/event-stream') && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
          if (!res.headersSent) {
            for (const [key, value] of headers) if (!ignoredHeaders.has(key.toLowerCase()) && !['content-encoding', 'content-security-policy', 'access-control-allow-origin', 'location'].includes(key.toLowerCase())) res.setHeader(key, value);
            res.writeHead(status);
          }
        },
        onChunk: async (chunk, retrySignal) => {
          retrySignal.throwIfAborted();
          if (!res.write(chunk)) await once(res, 'drain', { signal: retrySignal });
        },
      });
      res.end();
    } catch (error) {
      if (res.destroyed) return;
      const message = error.code === 'cancelled' ? '用户取消了此请求。' : error.code === 'retry_disabled' ? '自动重试已停用。' : error.code === 'stream_interrupted' ? '提供商在部分输出后断流；已停止，避免重复文本或工具调用。' : '提供商返回了需要客户端处理的错误。';
      if (res.headersSent) res.end(protocolError(protocol, error.code || 'gateway_error', message));
      else if (error.body?.length) { res.writeHead(error.status || 502, { 'Content-Type': 'application/json' }); res.end(error.body); }
      else sendJson(res, error.status || 502, { error: { code: error.code || 'gateway_error', message } });
    } finally {
      clearInterval(heartbeat);
      reservation.release();
    }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const validHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
      if (!validHosts.has(req.headers.host)) throw apiError('HOST_FORBIDDEN', 403, '本机服务拒绝该 Host。');
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && ![`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`].includes(origin)) throw apiError('ORIGIN_FORBIDDEN', 403, '来源不匹配。');
      const url = new URL(req.url, address);
      const path = url.pathname;
      // Opaque origin is not an identity. Never CORS-expose token-bearing HTML.
      if (origin === 'null' && assets.get(path)?.[1].startsWith('text/html')) throw apiError('ORIGIN_FORBIDDEN', 403, '页面入口仅接受浏览器导航。');
      if (origin === 'null' && path.startsWith('/api/')) {
        res.setHeader('Access-Control-Allow-Origin', 'null');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS' && path.startsWith('/api/')) {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH', 'Access-Control-Allow-Headers': 'X-Auto-Retry-Token, Content-Type' }); res.end(); return;
      }
      if (path.startsWith('/api/')) { await administer(req, res, path, url); return; }
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(new URL(`../ui/${file}`, import.meta.url));
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' ${address}; style-src 'self' ${address}; img-src 'self' ${address} data:; connect-src 'self' ${address}; base-uri 'none'; form-action 'none'`);
        res.writeHead(200, { 'Content-Type': type });
        res.end(type.startsWith('text/html') ? content.toString('utf8').replace('__ADMIN_TOKEN__', token) : content); return;
      }
      if (req.method === 'GET' && path === '/health') { sendJson(res, 200, { ok: true, version: VERSION }); return; }
      if (req.method === 'GET' && path === '/v1/models' && !req.headers.origin) {
        await listModels(req, res, path); return;
      }
      if (req.method === 'POST' && (['/v1/chat/completions', '/v1/messages', '/v1/responses'].includes(path) || /^\/v1beta\/models\/[a-zA-Z0-9._:-]+(?:\/[a-zA-Z0-9._:-]+)*:(?:streamGenerateContent|generateContent)$/.test(path))) {
        await infer(req, res, path + url.search); return;
      }
      throw apiError('NOT_FOUND', 404, '此路径不属于重试服务。');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) sendJson(res, error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '服务请求失败。', ...(error.fields ? { fields: error.fields } : {}) } });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.timeout = 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  actualPort = server.address().port;
  address = `http://127.0.0.1:${actualPort}`;
  try { settings = validateSettings({}, settings, actualPort); }
  catch (error) { server.close(); throw error; }
  const persist = setInterval(() => { if (!closing) flush().catch(() => {}); }, 5000);
  persist.unref?.();
  return { server, address, port: actualPort, token, statistics, snapshot, flush, get settings() { return settings; },
    async close() {
      if (closing) return;
      closing = true; clearInterval(persist); engine.cancelAll();
      for (const controller of admissions) controller.abort();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
      await flush().catch(() => {});
    } };
}
