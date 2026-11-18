import { classifyFailure } from './policy.mjs';

export class SSEDecoder {
  constructor(maxBytes = 1024 * 1024) {
    this.decoder = new TextDecoder();
    this.pending = '';
    this.maxBytes = maxBytes;
  }

  feed(bytes) {
    this.pending += this.decoder.decode(bytes, { stream: true });
    const frames = [];
    let match;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(this.pending))) {
      const end = match.index + match[0].length;
      const raw = this.pending.slice(0, end);
      if (Buffer.byteLength(raw) > this.maxBytes) this.tooLarge();
      const frame = this.parse(raw);
      if (frame) frames.push(frame);
      this.pending = this.pending.slice(end);
    }
    if (Buffer.byteLength(this.pending) > this.maxBytes) this.tooLarge();
    return frames;
  }

  finish() {
    this.decoder.decode();
    // SSE dispatch requires a blank line. EOF must not manufacture a terminal
    // event from an incomplete tail that the client could not receive as one.
    this.pending = '';
    return [];
  }

  tooLarge() { throw Object.assign(new Error('SSE event exceeds the memory limit.'), { code: 'SSE_FRAME_TOO_LARGE' }); }

  parse(raw) {
    let event = '';
    const lines = [];
    for (const line of raw.replace(/\r\n|\r/g, '\n').split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trimStart();
      if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!lines.length) return null;
    const text = lines.join('\n');
    let data = text;
    try { data = JSON.parse(text); } catch { /* Comments and [DONE] are valid SSE. */ }
    return { event, data, raw };
  }
}

export function stripMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { body: input, provider: null, changed: false };
  const marker = input._magpieAutoRetry;
  if (marker?.version !== 1) return { body: input, provider: null, changed: false };
  const { _magpieAutoRetry, ...body } = input;
  const p = marker.provider;
  const provider = p && typeof p.id === 'string' ? { id: p.id.slice(0, 100), name: typeof p.name === 'string' ? p.name.slice(0, 100) : p.id.slice(0, 100) } : null;
  return { body, provider, changed: true };
}

export function inspectEvent({ data, event = '' }) {
  if (!data || typeof data !== 'object') return { hasOutput: false, complete: data === '[DONE]',
    failure: data === '[DONE]' ? null : { retryable: true, code: 'invalid_sse_data', status: 502 } };
  const choiceFilter = data.choices?.some(c => c.finish_reason === 'content_filter');
  const candidateFilter = data.candidates?.some(c => ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(c.finishReason));
  const incompleteReason = data.response?.incomplete_details?.reason ?? data.incomplete_details?.reason;
  const blockReason = data.promptFeedback?.blockReason;
  if (choiceFilter || candidateFilter || blockReason || ['content_filter', 'content_policy_violation', 'safety', 'prohibited_content', 'recitation'].includes(incompleteReason)) {
    return { hasOutput: false, complete: false, failure: { retryable: false, code: 'content_filter', status: 400 } };
  }
  const type = data.type || event;
  if (data.error || ['error', 'response.failed', 'response.incomplete'].includes(type)) {
    const detail = data.error ?? data.response?.error ?? {};
    const status = Number(detail.status ?? detail.status_code ?? detail.code) || 0;
    return { hasOutput: false, complete: false, failure: classifyFailure({ status, body: data }) };
  }
  let hasOutput = false;
  if (type === 'content_block_start') {
    const b = data.content_block;
    hasOutput = b?.type === 'tool_use' || Boolean(b?.text || b?.thinking);
  } else if (type === 'content_block_delta') {
    const d = data.delta;
    hasOutput = Boolean(d?.text || d?.thinking || d?.partial_json || d?.signature);
  } else if (type.startsWith('response.')) {
    hasOutput = Boolean(data.delta) || (type === 'response.output_item.added' && (data.item?.type === 'function_call' || data.item?.content?.length > 0));
  }
  for (const choice of data.choices ?? []) {
    const d = choice.delta ?? choice.message ?? {};
    hasOutput ||= Boolean(d.content || d.refusal || d.reasoning_content || d.reasoning || d.tool_calls?.length || d.function_call);
  }
  for (const candidate of data.candidates ?? []) {
    hasOutput ||= Boolean(candidate.content?.parts?.some(p => p.text || p.functionCall || p.inlineData));
  }
  const complete = ['message_stop', 'response.completed'].includes(type)
    || Boolean(data.choices?.some(c => c.finish_reason)) || Boolean(data.candidates?.some(c => c.finishReason));
  return { hasOutput, complete, failure: null };
}

export function protocolError(protocol, code, message = '请求已停止。提供商恢复后请由客户端继续。') {
  const type = ['content_filter', 'protocol_mismatch', 'invalid_request_error'].includes(code)
    ? 'invalid_request_error'
    : 'api_error';
  const error = { code, message, type };
  if (protocol === 'anthropic') return `event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`;
  if (protocol === 'responses') return `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error } })}\n\n`;
  if (protocol === 'gemini') return `data: ${JSON.stringify({ error: { code: 502, message, status: 'UNAVAILABLE', details: [{ reason: code }] } })}\n\n`;
  return `data: ${JSON.stringify({ error })}\n\n`;
}
