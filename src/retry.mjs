import { classifyFailure, retryDelay, parseRetryAfter, abortableSleep } from './policy.mjs';
import { SSEDecoder, inspectEvent, stripMetadata } from './sse.mjs';

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_PREAMBLE_BYTES = 256 * 1024;
const errorOf = (code, status = 502, extra = {}) => Object.assign(new Error(code), { code, status, ...extra });

export async function readBounded(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw errorOf('response_too_large');
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  } finally { try { await reader.cancel(); } catch { /* Transport already closed. */ } }
}

export class RetryEngine {
  constructor({ statistics, getSettings, fetchImpl = globalThis.fetch, sleep, providerMetadata = false }) {
    this.statistics = statistics;
    this.getSettings = getSettings;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.providerMetadata = providerMetadata;
    this.controllers = new Map();
  }

  cancel(id) { const controller = this.controllers.get(id); if (!controller) return false; controller.abort(); return true; }
  cancelAll() { for (const controller of this.controllers.values()) controller.abort(); }

  async wait(ms, signal) {
    if (this.sleep) { await this.sleep(ms, signal); return; }
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!this.getSettings().enabled) throw errorOf('retry_disabled', 503);
      await abortableSleep(Math.min(250, end - Date.now()), signal);
    }
  }

  async execute(input) {
    const { path, bytes, body = {}, headers = {}, signal, onHeaders, onChunk, onWaiting = () => {} } = input;
    const model = input.model ?? body.model;
    const providerId = typeof model === 'string' ? model.split('/')[0] : 'unknown';
    const id = this.statistics.start({ providerId, model });
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let attempt = 0;
    let hasOutput = false;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const settings = this.getSettings();
        this.statistics.activity(id, { attempt: ++attempt, status: 'requesting', nextRetryAt: null });
        const one = new AbortController();
        const stop = () => one.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', stop, { once: true });
        const timeout = setTimeout(() => one.abort(Object.assign(new Error('Timeout'), { name: 'AttemptTimeoutError' })), settings.attemptTimeoutMs);
        let failure;
        let retryAfter = 0;
        let failureBody;
        let receivedStatus = 0;
        try {
          const sendBytes = this.providerMetadata ? Buffer.from(JSON.stringify({ ...body, _magpieAutoRetry: 1 })) : bytes;
          const response = await this.fetchImpl(`${settings.upstreamUrl}${path}`, {
            method: 'POST', headers: { ...headers, 'x-auto-retry-hop': '1' }, body: sendBytes, signal: one.signal, redirect: 'manual',
          });
          receivedStatus = response.status;
          retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          if (response.status >= 300) {
            const raw = await readBounded(response);
            let parsed;
            try { parsed = JSON.parse(raw.toString('utf8')); } catch { /* Preserve native non-JSON errors to the caller. */ }
            const clean = stripMetadata(parsed);
            this.statistics.attribute(id, clean.provider);
            failureBody = clean.changed ? Buffer.from(JSON.stringify(clean.body)) : raw;
            failure = classifyFailure({ status: response.status, body: clean.body });
          } else if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
            clearTimeout(timeout);
            const output = await this.stream(response, one, controller.signal, id, settings, onHeaders, onChunk, body, path);
            hasOutput = output.hasOutput;
            if (output.failure) failure = output.failure;
            else { this.statistics.success(id); return; }
          } else {
            const raw = await readBounded(response);
            let parsed;
            try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw errorOf('invalid_upstream_response'); }
            const clean = stripMetadata(parsed);
            this.statistics.attribute(id, clean.provider);
            if (clean.body?.error) { failure = classifyFailure({ status: response.status, body: clean.body }); failureBody = Buffer.from(JSON.stringify(clean.body)); }
            else if ((path.includes('/responses') || clean.body?.object === 'response') && clean.body?.status !== 'completed') {
              failure = { retryable: false, code: 'non_terminal_response', status: 502 };
              failureBody = Buffer.from(JSON.stringify({ error: { code: failure.code, message: 'Upstream did not return a completed response.' } }));
            }
            else {
              if (body.stream && attempt > 1) throw errorOf('unexpected_response_type', 502, { retryable: false });
              await onHeaders(response.status, response.headers);
              await onChunk(clean.changed ? Buffer.from(JSON.stringify(clean.body)) : raw, controller.signal);
              this.statistics.success(id);
              return;
            }
          }
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          hasOutput ||= Boolean(error.hasOutput);
          if (receivedStatus >= 300 && !classifyFailure({ status: receivedStatus }).retryable) {
            // Received authentication/client status remains authoritative if its body is cut.
            failure = classifyFailure({ status: receivedStatus });
          } else if (error.code === 'SSE_FRAME_TOO_LARGE' || error.code === 'response_too_large' || error.retryable === false) {
            failure = { retryable: false, status: error.status || 502, code: error.code };
          } else failure = classifyFailure({ error: one.signal.aborted ? one.signal.reason : error });
        } finally {
          clearTimeout(timeout);
          one.abort();
          controller.signal.removeEventListener('abort', stop);
        }
        this.statistics.failure(id, failure);
        if (hasOutput) throw errorOf('stream_interrupted', 502, { hasOutput: true });
        if (!failure.retryable || !this.getSettings().enabled) {
          throw errorOf(!this.getSettings().enabled && failure.retryable ? 'retry_disabled' : failure.code, failure.status, { body: failureBody });
        }
        const delay = retryDelay(attempt, this.getSettings(), retryAfter);
        this.statistics.retry(id, delay, failure);
        await onWaiting(delay);
        await this.wait(delay, controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted) { this.statistics.cancel(id); throw errorOf('cancelled', 499); }
      this.statistics.finish(id, error.hasOutput ? 'interrupted' : 'failed', { code: error.code, status: error.status });
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.controllers.delete(id);
    }
  }

  async stream(response, one, signal, id, settings, onHeaders, onChunk, requestBody, path) {
    if (!response.body) return { hasOutput: false, failure: { retryable: true, code: 'empty_stream', status: 502 } };
    const reader = response.body.getReader();
    const decoder = new SSEDecoder();
    const preamble = [];
    let preambleSize = 0;
    let hasOutput = false;
    let complete = false;
    let terminal = false;
    const protocol = path.includes('/messages') ? 'anthropic' : path.includes('/responses') ? 'responses' : path.includes('/models/') ? 'gemini' : 'chat';
    const finishedCandidates = new Map();
    const expectedCandidates = requestBody.generationConfig?.candidateCount ?? 1;
    let opened = false;
    const write = async chunk => {
      if (!opened) { await onHeaders(response.status, response.headers); opened = true; }
      await onChunk(chunk, signal);
    };
    const handle = async frame => {
      const clean = stripMetadata(frame.data);
      this.statistics.attribute(id, clean.provider);
      const info = inspectEvent({ data: clean.body, event: frame.event });
      if (info.failure) return info.failure;
      const type = clean.body?.type;
      if (clean.body === '[DONE]' && protocol !== 'chat') return { retryable: true, code: 'invalid_sse_terminal', status: 502 };
      if (((protocol === 'anthropic' && frame.event === 'message_stop')
        || (protocol === 'responses' && frame.event === 'response.completed')) && type !== frame.event) {
        return { retryable: true, code: 'invalid_sse_terminal', status: 502 };
      }
      terminal ||= protocol === 'chat' ? clean.body === '[DONE]'
        : protocol === 'anthropic' ? type === 'message_stop'
        : protocol === 'responses' ? type === 'response.completed' : false;
      if (protocol === 'gemini' && Array.isArray(clean.body?.candidates)) {
        if (!Number.isInteger(expectedCandidates) || expectedCandidates < 1 || expectedCandidates > 8) {
          return { retryable: false, code: 'invalid_candidate_count', status: 400 };
        }
        if (clean.body.candidates.length > expectedCandidates) return { retryable: true, code: 'invalid_candidate_index', status: 502 };
        for (let i = 0; i < clean.body.candidates.length; i++) {
          const candidate = clean.body.candidates[i];
          const index = candidate?.index ?? i;
          if (!Number.isInteger(index) || index < 0 || index >= expectedCandidates) return { retryable: true, code: 'invalid_candidate_index', status: 502 };
          finishedCandidates.set(index, finishedCandidates.get(index) || Boolean(candidate.finishReason));
        }
        complete = finishedCandidates.size === expectedCandidates && [...finishedCandidates.values()].every(Boolean);
      } else if (protocol !== 'gemini') complete ||= terminal;
      const raw = clean.changed ? `${frame.event ? `event: ${frame.event}\n` : ''}data: ${JSON.stringify(clean.body)}\n\n` : frame.raw;
      if (info.hasOutput || complete) {
        if (info.hasOutput) { hasOutput = true; this.statistics.activity(id, { status: 'streaming', hasOutput: true }); }
        for (const prior of preamble.splice(0)) await write(prior);
        preambleSize = 0;
      }
      if (hasOutput || complete) await write(raw);
      else {
        preambleSize += Buffer.byteLength(raw);
        if (preambleSize > MAX_PREAMBLE_BYTES) throw errorOf('response_too_large');
        preamble.push(raw);
      }
      return null;
    };
    try {
      for (;;) {
        signal.throwIfAborted();
        const idle = setTimeout(() => one.abort(Object.assign(new Error('Idle stream'), { name: 'StreamIdleTimeoutError' })), this.getSettings().streamIdleTimeoutMs ?? settings.streamIdleTimeoutMs);
        let part;
        try { part = await reader.read(); } finally { clearTimeout(idle); }
        const frames = part.done ? decoder.finish() : decoder.feed(part.value);
        for (const frame of frames) {
          const failure = await handle(frame);
          if (failure) return { hasOutput, failure };
        }
        // Chat finish_reason may be followed by a separate usage frame and [DONE].
        if (part.done || terminal) break;
      }
      return { hasOutput, failure: complete ? null : { retryable: true, code: 'stream_interrupted', status: 502 } };
    } catch (error) {
      error.hasOutput = hasOutput;
      throw error;
    } finally { try { await reader.cancel(); } catch { /* Already aborted. */ } }
  }
}
