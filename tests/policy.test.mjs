import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, retryDelay, parseRetryAfter, abortableSleep } from '../src/policy.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';

test('transient provider statuses retry, permanent client/auth/quota errors do not', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 529]) {
    assert.equal(classifyFailure({ status }).retryable, true, String(status));
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(classifyFailure({ status }).retryable, false, String(status));
  }
  assert.equal(classifyFailure({ status: 429, body: { error: { code: 'insufficient_quota' } } }).retryable, false);
  assert.equal(classifyFailure({ status: 400, body: { error: { message: 'temporarily unavailable, please retry later' } } }).retryable, true);
  assert.equal(classifyFailure({ status: 404, body: { error: { message: 'none of this model\'s models is ready' } } }).retryable, true);
});

test('network and timeout errors retry without leaking their text', () => {
  const f = classifyFailure({ error: Object.assign(new Error('secret request'), { code: 'ECONNRESET' }) });
  assert.equal(f.retryable, true);
  assert.equal(f.code, 'connection_error');
  assert.ok(!JSON.stringify(f).includes('secret'));
  assert.equal(classifyFailure({ error: { name: 'AttemptTimeoutError' } }).code, 'attempt_timeout');
  assert.equal(classifyFailure({ error: { code: 'CERT_HAS_EXPIRED' } }).retryable, false);
  assert.equal(classifyFailure({ body: { type: 'error', error: { type: 'overloaded_error' } } }).retryable, true);
});

test('backoff grows and caps forever instead of exhausting a retry budget', () => {
  const s = { ...DEFAULT_SETTINGS, jitter: false };
  assert.deepEqual([1, 2, 3, 4, 5, 6, 100000].map(n => retryDelay(n, s)), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(retryDelay(2, { ...s, jitter: true }, 0, () => 0), 3000);
  assert.equal(retryDelay(999, { ...s, jitter: true }, 0, () => 1), 60000);
  assert.equal(retryDelay(1, s, 120000), 120000, 'Retry-After is a lower bound, not reduced by our cap');
});

test('Retry-After understands seconds and dates but ignores malformed input', () => {
  assert.equal(parseRetryAfter('12', 0), 12000);
  assert.equal(parseRetryAfter(new Date(50000).toUTCString(), 20000), 30000);
  assert.equal(parseRetryAfter('nonsense', 0), 0);
  assert.equal(parseRetryAfter('-1', 0), 0);
  assert.equal(parseRetryAfter('999999999999', 0), 86400000);
});

test('sleep respects both already-aborted and newly aborted client signals', async () => {
  const a = new AbortController();
  a.abort();
  await assert.rejects(abortableSleep(10000, a.signal), { name: 'AbortError' });
  const b = new AbortController();
  const pending = abortableSleep(10000, b.signal);
  b.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await abortableSleep(1);
});
