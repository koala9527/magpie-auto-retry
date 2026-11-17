import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, validateSettings } from '../src/settings.mjs';

test('defaults enable unbounded retry and point at the official local gateway', () => {
  assert.equal(DEFAULT_SETTINGS.enabled, true);
  assert.equal(DEFAULT_SETTINGS.upstreamUrl, 'http://127.0.0.1:3425');
  assert.equal(DEFAULT_SETTINGS.maxConcurrentRequests, 32);
  assert.ok(!('maxRetries' in DEFAULT_SETTINGS));
});

test('normalization is bounded, strict about booleans, and keeps delay ordering', () => {
  const s = normalizeSettings({ enabled: 'false', initialDelayMs: 90000, maxDelayMs: 20, historyDays: -1 });
  assert.equal(s.enabled, true);
  assert.equal(s.initialDelayMs, 60000);
  assert.equal(s.maxDelayMs, 60000);
  assert.equal(s.historyDays, 1);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
});

test('patch validation rejects unknown keys, non-integers and delay inversion', () => {
  for (const patch of [{ maxRetries: 5 }, { enabled: 'false' }, { heartbeatMs: 1000.5 }, { maxDelayMs: 100 }]) {
    assert.throws(() => validateSettings(patch, DEFAULT_SETTINGS, 3430), { code: 'INVALID_SETTINGS' });
  }
  assert.equal(validateSettings({ enabled: false }, DEFAULT_SETTINGS, 3430).enabled, false);
  assert.throws(() => validateSettings(JSON.parse('{"__proto__":{"enabled":false}}'), DEFAULT_SETTINGS, 3430), { code: 'INVALID_SETTINGS' });
});

test('upstream validation prevents credentials, remote hosts, redirects and self loops', () => {
  for (const url of ['https://example.com', 'http://user:secret@127.0.0.1:3425', 'http://127.0.0.1:3430', 'http://localhost:3430/v1', 'file:///etc/passwd', 'http://127.0.0.1:3425/?key=secret']) {
    assert.throws(() => validateSettings({ upstreamUrl: url }, DEFAULT_SETTINGS, 3430), { code: 'INVALID_SETTINGS' });
  }
  assert.equal(validateSettings({ upstreamUrl: 'http://localhost:3425/v1/' }, DEFAULT_SETTINGS, 3430).upstreamUrl, 'http://localhost:3425');
  assert.equal(validateSettings({ upstreamUrl: 'http://[::1]:3425' }, DEFAULT_SETTINGS, 3430).upstreamUrl, 'http://[::1]:3425');
});
