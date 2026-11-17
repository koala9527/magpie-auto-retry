import test from 'node:test';
import assert from 'node:assert/strict';
import { SSEDecoder, inspectEvent, stripMetadata, protocolError } from '../src/sse.mjs';

test('SSE decoder handles split UTF-8, CRLF and multiline data', () => {
  const decoder = new SSEDecoder();
  const bytes = new TextEncoder().encode('event: message\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\n');
  let frames = [];
  for (const byte of bytes) frames.push(...decoder.feed(Uint8Array.of(byte)));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data, { text: '你好' });
  assert.equal(frames[0].event, 'message');
  assert.deepEqual(decoder.finish(), []);
});

test('SSE EOF discards data without a complete blank-line event delimiter', () => {
  for (const ending of ['', '\n', '\r\n']) {
    const decoder = new SSEDecoder();
    assert.deepEqual(decoder.feed(new TextEncoder().encode(`data: [DONE]${ending}`)), []);
    assert.deepEqual(decoder.finish(), []);
    assert.equal(decoder.pending, '');
  }
});

test('SSE comments, ids and event names without data do not dispatch events', () => {
  const decoder = new SSEDecoder();
  assert.deepEqual(decoder.feed(new TextEncoder().encode(
    ': ping\n\nid: next\n\nevent: message_stop\n\nevent: response.completed\n\n',
  )), []);
  assert.deepEqual(decoder.finish(), []);
});

test('heartbeats and metadata events are not output or a successful completion', () => {
  for (const data of [{ type: 'message_start', message: {} }, { type: 'response.created', response: {} }, { choices: [{ delta: { role: 'assistant' } }] }]) {
    assert.equal(inspectEvent({ data }).hasOutput, false);
    assert.equal(inspectEvent({ data }).complete, false);
  }
  assert.equal(inspectEvent({ data: { type: 'content_block_delta', delta: { text: 'hello' } } }).hasOutput, true);
  assert.equal(inspectEvent({ data: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'call-1', name: 'write' } } }).hasOutput, true);
  assert.equal(inspectEvent({ data: { type: 'response.function_call_arguments.delta', delta: '{}' } }).hasOutput, true);
  assert.equal(inspectEvent({ data: { choices: [{ delta: { tool_calls: [{ id: 'call-1' }] } }] } }).hasOutput, true);
  assert.equal(inspectEvent({ data: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] } }).hasOutput, true);
});

test('all supported protocols recognize completion and stream failures', () => {
  for (const data of ['[DONE]', { type: 'message_stop' }, { type: 'response.completed' }, { choices: [{ finish_reason: 'stop' }] }, { candidates: [{ finishReason: 'STOP' }] }]) {
    assert.equal(inspectEvent({ data }).complete, true);
  }
  for (const data of [{ type: 'error', error: { type: 'overloaded_error' } }, { error: { code: 503 } }, { type: 'response.failed', response: { error: { code: 'server_error' } } }]) {
    assert.ok(inspectEvent({ data }).failure);
  }
});

test('internal attribution is stripped from JSON without removing vendor fields', () => {
  const body = { type: 'message_start', message: { id: 'x' }, _magpieAutoRetry: { version: 1, provider: { id: 'a', name: 'A' } } };
  const result = stripMetadata(body);
  assert.deepEqual(result.provider, { id: 'a', name: 'A' });
  assert.deepEqual(result.body, { type: 'message_start', message: { id: 'x' } });
  assert.equal(stripMetadata({ hello: true }).provider, null);
});

test('malformed and oversized SSE frames fail instead of filling unlimited memory', () => {
  const decoder = new SSEDecoder(100);
  assert.throws(() => decoder.feed(new TextEncoder().encode('data: ' + 'x'.repeat(101))), { code: 'SSE_FRAME_TOO_LARGE' });
  const plain = new SSEDecoder();
  assert.equal(plain.feed(new TextEncoder().encode('data: not-json\n\n'))[0].data, 'not-json');
  assert.ok(protocolError('anthropic', 'stream_interrupted').includes('event: error'));
  assert.ok(protocolError('responses', 'stream_interrupted').includes('response.failed'));
  assert.ok(protocolError('chat', 'stream_interrupted').includes('data:'));
  const gemini = JSON.parse(protocolError('gemini', 'stream_interrupted').slice(6));
  assert.equal(gemini.error.code, 502);
  assert.equal(gemini.error.status, 'UNAVAILABLE');
});
