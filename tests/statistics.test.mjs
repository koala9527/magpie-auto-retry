import test from 'node:test';
import assert from 'node:assert/strict';
import { Statistics } from '../src/statistics.mjs';

test('no observations are unknown, not 100 percent availability', () => {
  const stats = new Statistics({ now: () => 0 });
  assert.equal(stats.snapshot().totals.availabilityPercent, null);
  assert.deepEqual(stats.snapshot().providers, []);
});

test('providers have separate outage counters and only a real success heals', () => {
  let now = 1000;
  const stats = new Statistics({ now: () => now });
  const a = stats.start({ providerId: 'a', model: 'a/model' });
  const b = stats.start({ providerId: 'b', model: 'b/model' });
  stats.failure(a, { code: 'http_503', status: 503 });
  stats.retry(a, 2000);
  now += 10000;
  stats.success(b);
  assert.equal(stats.snapshot().providers.find(p => p.id === 'a').status, 'outage');
  now += 5000;
  stats.success(a);
  const s = stats.snapshot();
  const pa = s.providers.find(p => p.id === 'a');
  assert.equal(pa.failures, 1);
  assert.equal(pa.unavailableMs, 15000);
  assert.equal(pa.status, 'healthy');
  assert.equal(pa.recoveredRequests, 1);
  assert.equal(s.totals.recoveredRequests, 1);
  assert.equal(s.totals.activeRequests, 0);
  assert.equal(s.incidents[0].endedAt, now);
});

test('idle time after five minutes is unknown, and restarting excludes offline time', () => {
  let now = 0;
  const stats = new Statistics({ now: () => now });
  stats.success(stats.start({ providerId: 'a' }));
  now = 900000;
  assert.equal(stats.snapshot().providers[0].availableMs, 300000);
  assert.equal(stats.snapshot().providers[0].status, 'unknown');
  const saved = stats.serialize();
  now += 10000000;
  const restarted = new Statistics({ now: () => now, saved });
  assert.equal(restarted.snapshot().providers[0].availableMs, 300000);
  assert.equal(restarted.snapshot().providers[0].status, 'unknown');
});

test('gateway metadata reattributes a request without counting it twice', () => {
  const stats = new Statistics({ now: () => 100 });
  const id = stats.start({ providerId: 'group', model: 'group/model' });
  stats.attribute(id, { id: 'actual', name: 'Actual Provider' });
  stats.failure(id, { code: 'http_503', status: 503 });
  assert.equal(stats.snapshot().totals.requests, 1);
  const p = stats.snapshot().providers.find(p => p.id === 'actual');
  assert.equal(p.name, 'Actual Provider');
  assert.equal(p.attribution, 'gateway');
  assert.equal(p.requests, 1);
  assert.equal(p.failures, 1);
});

test('cancel/reset preserve active request ownership and exports exclude request contents', () => {
  const stats = new Statistics({ now: () => 1000 });
  const id = stats.start({ providerId: 'a', model: 'a/model', body: 'SECRET_PROMPT', authorization: 'SECRET_KEY' });
  stats.reset();
  assert.equal(stats.snapshot().activeRequests.length, 1);
  stats.cancel(id);
  assert.equal(stats.snapshot().totals.cancelledRequests, 1);
  assert.equal(stats.snapshot().activeRequests.length, 0);
  assert.ok(!JSON.stringify(stats.serialize()).includes('SECRET'));
  assert.ok(!('activeRequests' in stats.serialize()));
});
