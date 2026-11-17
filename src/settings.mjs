export const DEFAULT_SETTINGS = Object.freeze({
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
});

export const LIMITS = Object.freeze({
  initialDelayMs: [100, 60000],
  maxDelayMs: [100, 3600000],
  attemptTimeoutMs: [1000, 600000],
  streamIdleTimeoutMs: [1000, 600000],
  heartbeatMs: [1000, 30000],
  maxConcurrentRequests: [1, 256],
  historyDays: [1, 90],
});

export function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return s;
  for (const key of ['enabled', 'jitter']) {
    if (typeof input[key] === 'boolean') s[key] = input[key];
  }
  for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
    if (Number.isFinite(input[key])) s[key] = Math.min(hi, Math.max(lo, Math.round(input[key])));
  }
  s.maxDelayMs = Math.max(s.maxDelayMs, s.initialDelayMs);
  if (typeof input.upstreamUrl === 'string') {
    try { s.upstreamUrl = localGateway(input.upstreamUrl); } catch { /* Invalid persisted settings use the default. */ }
  }
  return s;
}

function localGateway(value, port) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      || u.username || u.password || u.search || u.hash || !['/', '/v1', '/v1/'].includes(u.pathname)
      || Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === port) {
    throw new Error('invalid local gateway');
  }
  return u.origin;
}

export function validateSettings(patch, current = DEFAULT_SETTINGS, port = 3430) {
  const fields = Object.create(null);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    fields.settings = '设置必须是 JSON 对象。';
  } else {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || !Object.hasOwn(DEFAULT_SETTINGS, key)) fields[key] = '未知设置项。';
      else if (key === 'enabled' || key === 'jitter') {
        if (typeof value !== 'boolean') fields[key] = '必须是布尔值。';
      } else if (key === 'upstreamUrl') {
        try { localGateway(value, port); } catch { fields[key] = '请使用本机 Magpie 地址，且端口不得与重试服务相同。'; }
      } else {
        const [lo, hi] = LIMITS[key];
        if (!Number.isInteger(value) || value < lo || value > hi) fields[key] = `请填写 ${lo}–${hi} 之间的整数。`;
      }
    }
  }
  const result = { ...current, ...patch };
  if (result.maxDelayMs < result.initialDelayMs) fields.maxDelayMs = '最大等待必须不小于初始等待。';
  if (Object.keys(fields).length) {
    throw Object.assign(new Error('请检查设置字段。'), { code: 'INVALID_SETTINGS', status: 422, fields });
  }
  result.upstreamUrl = localGateway(result.upstreamUrl, port);
  return result;
}
