import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRetryServer } from '../src/server.mjs';
import { RetryEngine } from '../src/retry.mjs';
import { Statistics } from '../src/statistics.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';

const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const chatPath = '/v1/chat/completions';

async function until(predicate, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await sleep(10);
  assert.ok(predicate(), 'bounded reproduction did not reach its setup condition');
}

async function fixture(t, handler, settings = {}) {
  const upstream = createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dataDir = await mkdtemp(join(tmpdir(), 'magpie-review-regression-'));
  const gateway = await createRetryServer({ port: 0, dataDir, settings: {
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}`,
    initialDelayMs: 100, maxDelayMs: 100, jitter: false, attemptTimeoutMs: 3000,
    ...settings,
  } });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    // Remove only the two known fixture files, never a recursive workspace path.
    for (const name of ['statistics.json', 'settings.json']) {
      await unlink(join(dataDir, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(dataDir);
  });
  return {
    gateway,
    post: (path, body, init = {}) => fetch(gateway.address + path, {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(4000), ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    }),
    admin: (path, init = {}) => fetch(gateway.address + path, {
      signal: AbortSignal.timeout(4000), ...init,
      headers: { 'X-Auto-Retry-Token': gateway.token, ...init.headers },
    }),
    client: (path, options = {}) => {
      const client = request(gateway.address + path, options);
      client.on('error', () => {});
      clients.push(client);
      return client;
    },
  };
}

test('review: an opaque browser origin cannot steal the page token and reset statistics', { timeout: 6000 }, async t => {
  const f = await fixture(t, (_, res) => res.end('{}'));
  const landing = await fetch(f.gateway.address + '/', { headers: { Origin: 'null' } });
  const html = await landing.text();
  const stolen = /name="auto-retry-token" content="([^"]+)"/.exec(html)?.[1] || '';
  const preflight = await fetch(f.gateway.address + '/api/statistics/reset', {
    method: 'OPTIONS', headers: {
      Origin: 'null', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'x-auto-retry-token,content-type',
    },
  });
  const reset = await fetch(f.gateway.address + '/api/statistics/reset', {
    method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json', 'X-Auto-Retry-Token': stolen },
    body: '{"confirm":true}',
  });
  t.diagnostic(JSON.stringify({ landing: landing.status, allowOrigin: landing.headers.get('access-control-allow-origin'),
    tokenDisclosed: stolen === f.gateway.token, preflight: preflight.status, reset: reset.status, resetBody: await reset.text() }));
  assert.ok(reset.status >= 400, 'an untrusted opaque origin authorized an admin mutation with the disclosed token');
});

test('review: admin cancellation releases an inference blocked on downstream drain', { timeout: 6000 }, async t => {
  const chunk = frame({ choices: [{ delta: { content: 'x'.repeat(64 * 1024) } }] });
  let sentBytes = 0;
  const f = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const pump = new AbortController();
    res.on('close', () => pump.abort());
    (async () => {
      try {
        // Linux TCP autotuning may absorb the original 4 MiB fixture entirely.
        // A bounded 64 MiB producer reaches real backpressure on both platforms;
        // only one reusable frame is allocated, and cancellation stops the pump.
        for (let i = 0; i < 1024 && !res.destroyed; i++) {
          sentBytes += Buffer.byteLength(chunk);
          if (!res.write(chunk)) await once(res, 'drain', { signal: pump.signal });
        }
        if (!res.destroyed) res.end('data: [DONE]\n\n');
      } catch (error) { if (!pump.signal.aborted) res.destroy(error); }
    })();
  }, { maxConcurrentRequests: 1 });
  let downstream;
  f.gateway.server.on('request', (req, res) => { if (req.url === chatPath) downstream = res; });
  const client = f.client(chatPath, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const paused = new Promise(resolve => client.on('response', response => { response.pause(); resolve(response); }));
  client.end('{"model":"review/chat","stream":true}');
  await paused;
  await until(() => downstream?.writableNeedDrain, 2500);
  await sleep(50);
  assert.ok(downstream.writableNeedDrain, 'paused TCP reader did not create downstream backpressure');
  const blockedDownstream = downstream;
  const id = f.gateway.snapshot().activeRequests[0]?.id;
  assert.ok(id);
  const cancelled = await f.admin(`/api/requests/${id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 200);
  await sleep(150);
  const state = f.gateway.snapshot();
  const next = await f.post(chatPath, { model: 'review/next' });
  const nextStatus = next.status;
  await next.body?.cancel();
  t.diagnostic(JSON.stringify({ cancel: cancelled.status, activeAfterCancel: state.totals.activeRequests,
    cancelledCount: state.totals.cancelledRequests, nextStatus, needDrain: blockedDownstream.writableNeedDrain,
    queuedBytes: blockedDownstream.writableLength, sentBytes }));
  assert.equal(state.totals.activeRequests, 0, 'admin cancellation left the inference and concurrency slot owned by a drain wait');
});

test('review: partial request uploads reserve the concurrency and memory budget', { timeout: 6000 }, async t => {
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}');
  }, { maxConcurrentRequests: 1 });
  let consumedBytes = 0;
  f.gateway.server.on('request', req => {
    if (req.url === chatPath) req.on('data', bytes => { consumedBytes += bytes.length; });
  });
  const prefix = '{"model":"review/upload","padding":"' + 'x'.repeat(256 * 1024);
  for (let i = 0; i < 3; i++) {
    const upload = f.client(chatPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    });
    upload.on('response', response => response.resume());
    upload.write(prefix); // Deliberately leave JSON and the HTTP body unfinished.
    if (i === 0) await until(() => consumedBytes >= Buffer.byteLength(prefix));
  }
  await sleep(100);
  const response = await f.post(chatPath, { model: 'review/complete' });
  await response.text();
  t.diagnostic(JSON.stringify({ partialUploads: 3, consumedBytes, reportedActive: f.gateway.snapshot().totals.activeRequests,
    completeRequestStatus: response.status, configuredLimit: 1 }));
  assert.equal(response.status, 429, 'three buffered partial uploads remained outside the single-request admission budget');
});

test('review: chat finish_reason without DONE is an interrupted stream, not a success', { timeout: 6000 }, async t => {
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame({ choices: [{ index: 0, delta: { content: 'partial' } }] })
      + frame({ choices: [{ index: 0, finish_reason: 'stop' }] }));
  });
  const text = await f.post(chatPath, { model: 'review/chat', stream: true }).then(r => r.text());
  const state = f.gateway.snapshot();
  t.diagnostic(JSON.stringify({ hasDone: text.includes('[DONE]'), hasInterruption: text.includes('stream_interrupted'),
    successes: state.totals.successes, interruptedStreams: state.totals.interruptedStreams }));
  assert.equal(state.totals.successes, 0, 'a per-choice finish marker healed the provider without terminal chat completion');
  assert.equal(state.totals.interruptedStreams, 1);
});

test('review: Gemini EOF with only one of two candidates finished is not completion', { timeout: 6000 }, async t => {
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame({ candidates: [
      { index: 0, finishReason: 'STOP' },
      { index: 1, content: { parts: [{ text: 'unfinished second candidate' }] } },
    ] }));
  });
  const text = await f.post('/v1beta/models/gemini-review:streamGenerateContent?alt=sse', {
    contents: [{ parts: [{ text: 'test' }] }], generationConfig: { candidateCount: 2 },
  }).then(r => r.text());
  const state = f.gateway.snapshot();
  t.diagnostic(JSON.stringify({ successes: state.totals.successes, interruptedStreams: state.totals.interruptedStreams,
    hasInterruption: text.includes('stream_interrupted') }));
  assert.equal(state.totals.successes, 0, 'one candidate completed a still-partial multi-candidate inference');
  assert.equal(state.totals.interruptedStreams, 1);
});

test('review: native chat refusal text already forwarded to the client must not replay', { timeout: 6000 }, async t => {
  let attempts = 0;
  const refusal = frame({ choices: [{ index: 0, delta: { refusal: 'refusal-once' } }] });
  const finish = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(refusal + finish);
    if (++attempts === 1) {
      const cut = setTimeout(() => res.destroy(), 30);
      res.on('close', () => clearTimeout(cut));
    } else res.end('data: [DONE]\n\n');
  });
  const text = await f.post(chatPath, { model: 'review/chat', stream: true }).then(r => r.text());
  const copies = text.split('refusal-once').length - 1;
  t.diagnostic(JSON.stringify({ attempts, refusalCopies: copies, retries: f.gateway.snapshot().totals.retries,
    hasInterruption: text.includes('stream_interrupted') }));
  assert.equal(copies, 1, 'native refusal deltas crossed the client boundary twice in one request');
});

for (const status of [401, 403]) {
  test(`review: a truncated HTTP ${status} body must not turn authentication failure into retry`, { timeout: 6000 }, async t => {
    let attempts = 0;
    const f = await fixture(t, (req, res) => {
      req.resume(); res.writeHead(status, { 'Content-Type': 'application/json' });
      if (++attempts === 1) {
        res.write('{"error":');
        const cut = setTimeout(() => res.destroy(), 20);
        res.on('close', () => clearTimeout(cut));
      } else res.end('{"error":{"code":"invalid_api_key"}}');
    });
    const response = await f.post(chatPath, { model: 'review/chat' });
    await response.text();
    t.diagnostic(JSON.stringify({ status: response.status, attempts, retries: f.gateway.snapshot().totals.retries,
      codes: f.gateway.snapshot().events.map(event => event.code) }));
    assert.equal(attempts, 1, `the known HTTP ${status} was discarded when its body transport failed`);
  });
}

test('review: a non-terminal native Responses JSON result must not heal the provider', { timeout: 6000 }, async t => {
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"object":"response","id":"review-pending","status":"in_progress","output":[]}');
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = f.post('/v1/responses', { model: 'review/responses', input: 'test' }, { signal: controller.signal })
    .then(async response => ({ status: response.status, body: await response.text() }))
    .catch(error => ({ error: error.name }));
  const result = await Promise.race([pending, sleep(250).then(() => ({ pending: true }))]);
  const successes = f.gateway.snapshot().totals.successes;
  controller.abort();
  await pending;
  t.diagnostic(JSON.stringify({ result, successes }));
  assert.equal(successes, 0, 'HTTP 200 and JSON syntax alone completed an in-progress Responses inference');
});

test('review: malformed native SSE JSON after output is an interruption, not a success', { timeout: 6000 }, async t => {
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame({ choices: [{ delta: { content: 'once' } }] }) + 'data: {"choices":[}\n\ndata: [DONE]\n\n');
  });
  const text = await f.post(chatPath, { model: 'review/chat', stream: true }).then(r => r.text());
  const state = f.gateway.snapshot();
  t.diagnostic(JSON.stringify({ malformedForwarded: text.includes('{"choices":[}'), hasDone: text.includes('[DONE]'),
    successes: state.totals.successes, interruptedStreams: state.totals.interruptedStreams }));
  assert.equal(state.totals.successes, 0, 'invalid protocol JSON was forwarded and then healed by DONE');
  assert.equal(state.totals.interruptedStreams, 1);
});

test('review: model-list fetches share a bounded upstream concurrency budget', { timeout: 6000 }, async t => {
  const live = new Set();
  const f = await fixture(t, (req, res) => {
    req.resume(); live.add(res); res.on('close', () => live.delete(res));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"data":[');
  }, { maxConcurrentRequests: 1 });
  for (let i = 0; i < 3; i++) {
    const client = f.client('/v1/models');
    client.on('response', response => response.resume());
    client.end();
  }
  await until(() => live.size >= 1);
  await sleep(100);
  t.diagnostic(JSON.stringify({ configuredLimit: 1, liveUpstreamFetches: live.size, reportedActive: f.gateway.snapshot().totals.activeRequests }));
  assert.ok(live.size <= 1, 'model listing opened untracked concurrent upstream fetches outside the admission budget');
});

test('review: disconnecting a model-list client aborts its live upstream body read', { timeout: 6000 }, async t => {
  const live = new Set();
  const f = await fixture(t, (req, res) => {
    req.resume(); live.add(res); res.on('close', () => live.delete(res));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"data":[');
  });
  const client = f.client('/v1/models');
  client.end();
  await until(() => live.size === 1);
  client.destroy();
  await sleep(150);
  t.diagnostic(JSON.stringify({ liveUpstreamAfterClientDisconnect: live.size, configuredAttemptTimeoutMs: 3000 }));
  assert.equal(live.size, 0, 'the abandoned model-list fetch remained live until its attempt timeout');
});

test('review-fix: Gemini DONE cannot replace unfinished candidate completion', { timeout: 6000 }, async t => {
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame({ candidates: [
      { index: 0, finishReason: 'STOP' },
      { index: 1, content: { parts: [{ text: 'still unfinished' }] } },
    ] }) + 'data: [DONE]\n\n');
  });
  const text = await f.post('/v1beta/models/gemini-review:streamGenerateContent?alt=sse', {
    contents: [{ parts: [{ text: 'test' }] }], generationConfig: { candidateCount: 2 },
  }).then(response => response.text());
  const state = f.gateway.snapshot();
  t.diagnostic(JSON.stringify({ candidateOneFinished: false, doneForwarded: text.includes('[DONE]'),
    successes: state.totals.successes, interruptedStreams: state.totals.interruptedStreams }));
  assert.equal(state.totals.successes, 0, 'a foreign terminal marker overrode unfinished Gemini candidates');
  assert.ok(text.includes('stream_interrupted'));
  assert.ok(!text.includes('[DONE]'));
});

test('review-fix: out-of-range Gemini indexes cannot satisfy requested candidateCount', { timeout: 6000 }, async t => {
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame({ candidates: [
      { index: 0, content: { parts: [{ text: 'valid candidate zero' }] }, finishReason: 'STOP' },
    ] }) + frame({ candidates: [
      { index: 100, finishReason: 'STOP' }, { index: 200, finishReason: 'STOP' },
    ] }));
  });
  const text = await f.post('/v1beta/models/gemini-review:streamGenerateContent?alt=sse', {
    contents: [{ parts: [{ text: 'test' }] }], generationConfig: { candidateCount: 2 },
  }).then(response => response.text());
  const state = f.gateway.snapshot();
  t.diagnostic(JSON.stringify({ requestedCandidates: 2, receivedIndexes: [0, 100, 200],
    successes: state.totals.successes, interruptedStreams: state.totals.interruptedStreams }));
  assert.equal(state.totals.successes, 0, 'arbitrary indexes replaced the missing requested candidate one');
  assert.ok(text.includes('stream_interrupted'));
});

test('review-fix: Gemini candidate bookkeeping stays bounded after semantic output', { timeout: 6000, concurrency: false }, async t => {
  let sse = frame({ candidates: [{ index: 0, content: { parts: [{ text: 'once' }] } }] });
  for (let index = 1; index <= 2048; index++) sse += frame({ candidates: [{ index }] });
  const body = { generationConfig: { candidateCount: 2 } };
  const statistics = new Statistics();
  const engine = new RetryEngine({ statistics, getSettings: () => DEFAULT_SETTINGS,
    fetchImpl: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }) });
  const originalSet = Map.prototype.set;
  let candidateMap;
  let peakRetainedCandidates = 0;
  // Observe retained numeric/boolean candidate state, without editing service code.
  // The override is isolated to this serial test and restored even on assertion failure.
  Map.prototype.set = function (key, value) {
    const answer = originalSet.call(this, key, value);
    if (Number.isInteger(key) && typeof value === 'boolean') {
      candidateMap ??= this;
      if (this === candidateMap) peakRetainedCandidates = Math.max(peakRetainedCandidates, this.size);
    }
    return answer;
  };
  try {
    await assert.rejects(engine.execute({
      path: '/v1beta/models/gemini-review:streamGenerateContent?alt=sse',
      body, bytes: Buffer.from(JSON.stringify(body)), signal: AbortSignal.timeout(1500),
      onHeaders() {}, onChunk() {},
    }), { code: 'stream_interrupted' });
  } finally { Map.prototype.set = originalSet; }
  t.diagnostic(JSON.stringify({ inputBytes: Buffer.byteLength(sse), requestedCandidates: 2, peakRetainedCandidates }));
  assert.ok(peakRetainedCandidates <= 2, 'an output stream retained unbounded arbitrary candidate indexes');
});

test('review-fix: EOF does not dispatch an unterminated DONE event', { timeout: 6000 }, async t => {
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame({ choices: [{ delta: { content: 'partial' } }] }) + 'data: [DONE]');
  });
  const text = await f.post(chatPath, { model: 'review/chat', stream: true }).then(response => response.text());
  const state = f.gateway.snapshot();
  t.diagnostic(JSON.stringify({ endedWithUndelimitedDone: text.endsWith('data: [DONE]'),
    successes: state.totals.successes, interruptedStreams: state.totals.interruptedStreams }));
  assert.equal(state.totals.successes, 0, 'EOF manufactured a protocol-complete SSE terminal from undelimited data');
  assert.ok(text.includes('stream_interrupted'));
});
