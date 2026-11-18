import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetryServer } from '../src/server.mjs';
import { RetryEngine } from '../src/retry.mjs';
import { Statistics } from '../src/statistics.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';

async function fixture(t, handler, settings = {}) {
  const upstream = createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dataDir = await mkdtemp(join(tmpdir(), 'magpie-auto-retry-test-'));
  const gateway = await createRetryServer({ port: 0, dataDir, settings: {
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}`, initialDelayMs: 100, maxDelayMs: 100, jitter: false, ...settings,
  } });
  t.after(async () => { await gateway.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const admin = (path, init = {}) => fetch(`${gateway.address}/${path}`, {
    ...init, headers: { 'X-Auto-Retry-Token': gateway.token, 'Content-Type': 'application/json', ...init.headers },
  });
  const infer = (body = { model: 'provider/model', messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] }, init = {}) => fetch(`${gateway.address}/v1/chat/completions`, {
    ...init, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer PRIVATE_KEY', ...init.headers }, body: JSON.stringify(body),
  });
  return { gateway, admin, infer, dataDir };
}

test('a real request survives provider failures, then returns the unchanged answer', async t => {
  let attempts = 0;
  const received = [];
  const f = await fixture(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ raw, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (++attempts <= 3) { res.writeHead(503); res.end('{"error":{"message":"busy"}}'); }
    else res.end('{"choices":[{"message":{"content":"recovered"}}]}');
  });
  const r = await f.infer();
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, 'recovered');
  assert.equal(attempts, 4);
  assert.equal(new Set(received.map(v => v.raw)).size, 1);
  assert.ok(received.every(v => v.authorization === 'Bearer PRIVATE_KEY'));
  const snapshot = await f.admin('api/state').then(r => r.json());
  assert.equal(snapshot.totals.failures, 3);
  assert.equal(snapshot.totals.retries, 3);
  assert.equal(snapshot.totals.recoveredRequests, 1);
  await f.gateway.flush();
  const disk = await readFile(join(f.dataDir, 'statistics.json'), 'utf8');
  assert.ok(!disk.includes('PRIVATE_'));
});

test('the engine has no finite retry budget even after 1001 failures', async () => {
  let attempts = 0;
  const stats = new Statistics();
  const engine = new RetryEngine({ statistics: stats, getSettings: () => ({ ...DEFAULT_SETTINGS, jitter: false }), sleep: async () => {},
    fetchImpl: async () => ++attempts <= 1001 ? new Response('{"error":{}}', { status: 503 }) : new Response('{"ok":true}') });
  let answer = '';
  await engine.execute({ path: '/v1/chat/completions', bytes: Buffer.from('{"model":"a/b"}'), headers: {}, body: { model: 'a/b' },
    onHeaders() {}, onChunk: chunk => { answer += chunk; } });
  assert.equal(attempts, 1002);
  assert.equal(answer, '{"ok":true}');
  assert.equal(stats.snapshot().totals.retries, 1001);
});

test('401 returns immediately without masquerading as provider recovery', async t => {
  let attempts = 0;
  const f = await fixture(t, (_, res) => { attempts++; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"invalid_api_key"}}'); });
  const r = await f.infer();
  assert.equal(r.status, 401);
  assert.equal(attempts, 1);
  const s = await f.admin('api/state').then(r => r.json());
  assert.equal(s.totals.successes, 0);
  assert.equal(s.totals.failedRequests, 1);
});

test('pre-output SSE content-filter errors are counted once and not replayed', async t => {
  let attempts = 0;
  const f = await fixture(t, (_, res) => {
    attempts++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"refused this request (safety filter: content_filter)"}}}\n\n');
  });
  const response = await fetch(`${f.gateway.address}/v1/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"model":"fixture/model","stream":true}', signal: AbortSignal.timeout(1500),
  });
  const output = await response.text();
  assert.equal(attempts, 1);
  assert.match(output, /content_filter/);
  const state = f.gateway.snapshot();
  assert.equal(state.totals.failures, 1);
  assert.equal(state.totals.retries, 0);
  assert.equal(state.totals.failedRequests, 1);
  assert.equal(state.events.some(event => event.code === 'content_filter'), true);
});

test('SSE pre-output errors are retried with heartbeats and only the good preamble reaches the client', async t => {
  let attempts = 0;
  const f = await fixture(t, (_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"response.created","response":{"id":"try-' + (++attempts) + '"}}\n\n');
    if (attempts === 1) res.end('data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\n\n');
    else res.end('data: {"type":"response.output_text.delta","delta":"recovered"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  const response = await fetch(`${f.gateway.address}/v1/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'a/b', stream: true }),
  });
  const text = await response.text();
  assert.ok(text.includes(': auto-retry'));
  assert.ok(!text.includes('try-1'));
  assert.ok(text.includes('try-2'));
  assert.ok(text.includes('recovered'));
  assert.equal(attempts, 2);
});

for (const [path, output] of [
  ['/v1/messages', { type: 'content_block_delta', delta: { text: 'once' } }],
  ['/v1/responses', { type: 'response.output_text.delta', delta: 'once' }],
]) {
  test(`${path} cannot complete with a foreign chat DONE marker`, async () => {
    const statistics = new Statistics();
    let text = '';
    const engine = new RetryEngine({ statistics, getSettings: () => DEFAULT_SETTINGS,
      fetchImpl: async () => new Response(`data: ${JSON.stringify(output)}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    });
    await assert.rejects(engine.execute({ path, body: { stream: true }, bytes: Buffer.from('{"stream":true}'),
      onHeaders() {}, onChunk(chunk) { text += chunk; },
    }), { code: 'stream_interrupted' });
    assert.equal(text.includes('[DONE]'), false);
    assert.equal(statistics.snapshot().totals.successes, 0);
    assert.equal(statistics.snapshot().totals.interruptedStreams, 1);
  });
}

for (const [path, output, event] of [
  ['/v1/messages', { type: 'content_block_delta', delta: { text: 'once' } }, 'message_stop'],
  ['/v1/responses', { type: 'response.output_text.delta', delta: 'once' }, 'response.completed'],
]) {
  test(`${path} needs a terminal payload, not only an SSE event name`, async () => {
    for (const dataLine of ['', 'data:\n', 'data: {}\n']) {
      const statistics = new Statistics();
      const engine = new RetryEngine({ statistics, getSettings: () => DEFAULT_SETTINGS,
        fetchImpl: async () => new Response(`data: ${JSON.stringify(output)}\n\nevent: ${event}\n${dataLine}\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      });
      let text = '';
      await assert.rejects(engine.execute({ path, body: { stream: true }, bytes: Buffer.from('{"stream":true}'),
        signal: AbortSignal.timeout(1500), onHeaders() {}, onChunk(chunk) { text += chunk; },
      }), { code: 'stream_interrupted' });
      assert.equal(text.includes(`event: ${event}`), false);
      assert.equal(statistics.snapshot().totals.successes, 0);
      assert.equal(statistics.snapshot().totals.interruptedStreams, 1);
    }
  });
}

test('Gemini completes only when every requested valid candidate has finished', async () => {
  const statistics = new Statistics();
  const frame = data => `data: ${JSON.stringify(data)}\n\n`;
  const sse = frame({ candidates: [{ index: 1, content: { parts: [{ text: 'second' }] } }] })
    + frame({ candidates: [{ index: 0, content: { parts: [{ text: 'first' }] }, finishReason: 'STOP' }] })
    + frame({ candidates: [{ index: 1, finishReason: 'STOP' }] })
    + frame({ usageMetadata: { candidatesTokenCount: 2 } });
  const engine = new RetryEngine({ statistics, getSettings: () => DEFAULT_SETTINGS,
    fetchImpl: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  const body = { generationConfig: { candidateCount: 2 } };
  let text = '';
  await engine.execute({ path: '/v1beta/models/gemini-test:streamGenerateContent?alt=sse', body,
    bytes: Buffer.from(JSON.stringify(body)), onHeaders() {}, onChunk(chunk) { text += chunk; },
  });
  assert.equal(text, sse);
  assert.equal(statistics.snapshot().totals.successes, 1);
});

for (const [model, method] of [
  ['native-provider/gemini-fixture', 'streamGenerateContent'],
  ['native-provider/llama:latest', 'generateContent'],
]) {
  test(`native Gemini preserves URL model ${model} across a provider outage`, async t => {
    const path = `/v1beta/models/${model}:${method}?alt=sse`;
    const body = { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }] };
    let attempts = 0;
    const received = [];
    const f = await fixture(t, async (req, res) => {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      received.push({ url: req.url, body: JSON.parse(bytes) });
      if (++attempts === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{}}');
      } else {
        const response = { candidates: [{ index: 0, content: { parts: [{ text: 'recovered' }] }, finishReason: 'STOP' }] };
        const stream = method === 'streamGenerateContent';
        res.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
        res.end(stream ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response));
      }
    });
    const response = await fetch(f.gateway.address + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /recovered/);
    assert.equal(attempts, 2);
    assert.ok(received.every(request => request.url === path));
    assert.ok(received.every(request => JSON.stringify(request.body) === JSON.stringify(body)));
    const state = f.gateway.snapshot();
    assert.equal(state.providers[0].id, 'native-provider');
    assert.equal(state.providers[0].recoveredRequests, 1);
    assert.equal(state.totals.requests, 1);
  });
}

test('partial output and tools are never replayed after a stream dies', async t => {
  let attempts = 0;
  const f = await fixture(t, (_, res) => {
    attempts++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"tool_calls":[{"id":"write-once","function":{"name":"write"}}]}}]}\n\n');
  });
  const text = await f.infer({ model: 'a/b', stream: true }).then(r => r.text());
  assert.equal(attempts, 1);
  assert.equal(text.split('write-once').length - 1, 1);
  assert.ok(text.includes('stream_interrupted'));
  assert.equal((await f.admin('api/state').then(r => r.json())).totals.interruptedStreams, 1);
});

test('cancelling an active retry aborts it and ends ownership without background work', async t => {
  let attempts = 0;
  const f = await fixture(t, (_, res) => { attempts++; res.writeHead(503); res.end('{"error":{}}'); }, { initialDelayMs: 60000, maxDelayMs: 60000 });
  const pending = f.infer({ model: 'a/b', stream: true });
  const response = await pending;
  const state = await f.admin('api/state').then(r => r.json());
  const id = state.activeRequests[0].id;
  assert.equal((await f.admin(`api/requests/${id}/cancel`, { method: 'POST', body: '{}' })).status, 200);
  assert.ok((await response.text()).includes('cancelled'));
  assert.equal(attempts, 1);
  assert.equal((await f.admin('api/state').then(r => r.json())).totals.activeRequests, 0);
});

test('Host/Origin/admin guards block browser abuse and non-inference endpoints', async t => {
  const f = await fixture(t, (_, res) => res.end('{"ok":true}'));
  assert.equal((await fetch(`${f.gateway.address}/api/state`)).status, 401);
  assert.equal((await f.infer({}, { headers: { Origin: 'null' } })).status, 403);
  // Fetch rewrites Host in current Undici; exercise the real wire with node:http.
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(`${f.gateway.address}/health`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(`${f.gateway.address}/v1/files`, { method: 'POST' })).status, 404);
  assert.equal((await f.infer({}, { headers: { 'X-Auto-Retry-Hop': '1' } })).status, 508);
  assert.equal((await f.admin('api/settings', { method: 'PATCH', body: '{"upstreamUrl":"https://attacker.example"}' })).status, 422);
  assert.equal((await f.admin('api/settings', { method: 'PATCH', body: '{"unknown":1}' })).status, 422);
  assert.equal((await f.admin('api/statistics/reset', { method: 'POST', body: '{}' })).status, 422);
});

test('chat usage and DONE frames after finish_reason remain intact', async t => {
  const f = await fixture(t, (_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"once"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\n');
    setTimeout(() => res.end('data: {"choices":[],"usage":{"completion_tokens":42}}\n\ndata: [DONE]\n\n'), 20);
  });
  const text = await f.infer({ model: 'a/b', stream: true }).then(r => r.text());
  assert.ok(text.includes('completion_tokens'));
  assert.ok(text.includes('[DONE]'));
});

test('settings persist atomically and hot-disable releases a waiting request', async t => {
  const f = await fixture(t, (_, res) => { res.writeHead(503); res.end('{"error":{}}'); }, { initialDelayMs: 60000, maxDelayMs: 60000 });
  const r = await f.infer({ model: 'a/b', stream: true });
  assert.equal((await f.admin('api/settings', { method: 'PATCH', body: '{"enabled":false}' })).status, 200);
  assert.ok((await r.text()).includes('retry_disabled'));
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'settings.json'), 'utf8')).enabled, false);
});
