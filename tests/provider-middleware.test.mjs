import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest, onProvider, onResponse, onEvent } from '../provider.middleware.js';

test('ordinary clients are completely untouched', () => {
  const ctx = { state: {} };
  assert.equal(onRequest({ model: 'a/b' }, ctx), undefined);
  onProvider({}, { ...ctx, provider: { id: 'a', name: 'A', account: 'PRIVATE_ACCOUNT' } });
  assert.equal(onResponse({ ok: true }, ctx), undefined);
  assert.equal(onEvent({ type: 'message_start' }, ctx), undefined);
});

test('proxy marker is removed before routing and only public provider identity is returned', () => {
  const ctx = { state: {} };
  const body = { model: 'a/b', messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], _magpieAutoRetry: 1 };
  const routed = onRequest(body, ctx);
  assert.ok(!('_magpieAutoRetry' in routed));
  assert.equal(routed.messages[0].content, 'PRIVATE_PROMPT');
  onProvider(routed, { ...ctx, provider: { id: 'actual', name: 'Actual', account: 'PRIVATE_ACCOUNT' } });
  const answer = onResponse({ ok: true }, ctx);
  assert.deepEqual(answer._magpieAutoRetry, { version: 1, provider: { id: 'actual', name: 'Actual' } });
  assert.ok(!JSON.stringify(ctx.state).includes('PRIVATE_'));
});

test('attribution is per-request and the first event uses the native event object', () => {
  const a = { state: {} };
  const b = { state: {} };
  onRequest({ _magpieAutoRetry: 1 }, a);
  onRequest({ _magpieAutoRetry: 1 }, b);
  onProvider({}, { ...a, provider: { id: 'a', name: 'A' } });
  onProvider({}, { ...b, provider: { id: 'b', name: 'B' } });
  assert.equal(onEvent({ type: 'message_start', message: {} }, a)._magpieAutoRetry.provider.id, 'a');
  assert.equal(onEvent({ type: 'message_start', message: {} }, b)._magpieAutoRetry.provider.id, 'b');
  assert.equal(onEvent({ type: 'content_block_delta', delta: { text: 'x' } }, a), undefined);
  assert.equal(onEvent({ type: 'error', error: { type: 'overloaded_error' } }, a)._magpieAutoRetry.provider.id, 'a');
});
