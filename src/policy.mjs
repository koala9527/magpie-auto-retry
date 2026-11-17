const permanentCodes = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'invalid_api_key', 'authentication_error', 'permission_error', 'invalid_request_error']);
const transientCodes = new Set(['overloaded_error', 'rate_limit_error', 'server_error', 'api_error', 'service_unavailable', 'timeout', 'connection_error']);
const tlsCodes = new Set(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']);

export function classifyFailure({ status = 0, body, error } = {}) {
  const detail = body?.error ?? body?.response?.error ?? {};
  const vendorCode = String(detail.code ?? detail.type ?? '').toLowerCase();
  const message = typeof detail.message === 'string' ? detail.message.slice(0, 2000) : '';
  if (permanentCodes.has(vendorCode) || /insufficient.*(quota|credit)|billing.hard.limit|余额不足|额度已用完/i.test(message)) {
    return { retryable: false, code: 'permanent_provider_error', status: status || 400 };
  }
  if (status === 401 || status === 403) return { retryable: false, code: `http_${status}`, status };
  if (error) {
    const code = error.code ?? error.cause?.code;
    if (tlsCodes.has(code)) return { retryable: false, code: 'tls_error', status: 502 };
    if (error.name === 'AttemptTimeoutError') return { retryable: true, code: 'attempt_timeout', status: 504 };
    if (error.name === 'StreamIdleTimeoutError') return { retryable: true, code: 'stream_timeout', status: 504 };
    return { retryable: true, code: 'connection_error', status: 502 };
  }
  if ([408, 425, 429].includes(status) || status >= 500 && status <= 599) {
    return { retryable: true, code: `http_${status}`, status };
  }
  if (transientCodes.has(vendorCode)
      || /temporarily unavailable|overloaded|too many (pending|concurrent) requests|retry later|none of .+models is ready/i.test(message)) {
    return { retryable: true, code: 'temporary_provider_error', status: status || 503 };
  }
  return { retryable: false, code: status ? `http_${status}` : 'provider_error', status: status || 502 };
}

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(86400000, Number(value) * 1000);
  // Date.parse accepts "-1" as a date on some runtimes; require an HTTP-date shape.
  if (!/[a-z]{3},/i.test(value)) return 0;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(86400000, Math.max(0, date - now)) : 0;
}

export function retryDelay(attempt, settings, retryAfterMs = 0, random = Math.random) {
  const exponent = Math.min(32, Math.max(0, attempt - 1));
  let delay = Math.min(settings.maxDelayMs, settings.initialDelayMs * 2 ** exponent);
  if (settings.jitter) delay = Math.min(settings.maxDelayMs, delay * (0.75 + Math.min(1, Math.max(0, random())) * 0.5));
  return Math.ceil(Math.max(delay, retryAfterMs));
}

export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    const aborted = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
