// Optional real-host verification. Only fixture state under an isolated portable HOME is used.
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const binary = process.env.MAGPIE_TEST_BINARY;
if (!binary) throw new Error('Set MAGPIE_TEST_BINARY to an official Magpie CLI binary.');
const root = await mkdtemp(join(tmpdir(), 'magpie-auto-retry-host-'));
const exe = join(root, process.platform === 'win32' ? 'magpie.exe' : 'magpie');
await copyFile(binary, exe);
await writeFile(join(root, '.portable'), '');
if (process.env.MAGPIE_TEST_BUN) {
  const dir = join(root, 'data', 'cache', 'bun', '1.4.2');
  await mkdir(dir, { recursive: true });
  await copyFile(process.env.MAGPIE_TEST_BUN, join(dir, process.platform === 'win32' ? 'magpie-bun.exe' : 'magpie-bun'));
}
const home = join(root, 'home');
await mkdir(home, { recursive: true });
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const magpiePort = await freePort();
const retryPort = await freePort();
const gatewayUrl = `http://127.0.0.1:${magpiePort}`;
const retryUrl = `http://127.0.0.1:${retryPort}`;
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
  APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'local'), MAGPIE_PLUGIN_MARKET: 'off', MAGPIE_ADDR: `127.0.0.1:${magpiePort}` };
const run = async args => {
  const result = await promisify(execFile)(exe, args, { env, cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  return result.stdout;
};
let failuresRemaining = 0;
let upstreamAttempts = 0;
const upstream = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"object":"list","data":[{"id":"fixture-model","object":"model"}]}'); return;
  }
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  assert.ok(!('_magpieAutoRetry' in body), 'middleware must remove internal request marker');
  upstreamAttempts++;
  if (failuresRemaining-- > 0) {
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"fixture outage","code":"server_error"}}'); return;
  }
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"id":"fixture-chat","object":"chat.completion.chunk","model":"fixture-model","choices":[{"index":0,"delta":{"content":"fixture recovery"},"finish_reason":null}]}\n\ndata: {"id":"fixture-chat","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"fixture-chat","object":"chat.completion","model":"fixture-model","choices":[{"index":0,"message":{"role":"assistant","content":"fixture recovery"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}');
  }
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
let child;
let logs = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const workspace = resolve(fileURLToPath(new URL('../', import.meta.url)));
  await run(['plugin', 'add', workspace]);
  await run(['plugin', 'options', 'magpie-auto-retry', JSON.stringify({ port: retryPort, upstreamUrl: gatewayUrl, initialDelayMs: 100, maxDelayMs: 100, jitter: false })]);
  const plugin = JSON.parse(await run(['plugin', '--json']));
  assert.ok(plugin.loaded?.some(p => p.spec === workspace), JSON.stringify(plugin));
  assert.equal(plugin.middleware[workspace].failures, 0);
  console.log('MAGPIE_PLUGIN_LOADED hooks=onRequest,onProvider,onEvent,onResponse');
  await run(['provider', 'add', 'Retry Fixture', `url=http://127.0.0.1:${upstream.address().port}/v1`, 'key=fixture-key', 'id=retry-fixture', 'models=fixture-model']);
  child = spawn(exe, ['serve'], { env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', c => { logs += c; });
  child.stderr.on('data', c => { logs += c; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${retryUrl}/health`)).ok) break; } catch { /* Host is starting. */ }
    if (i === 79) throw new Error('Fixture service did not start: ' + logs.slice(-3000));
    await delay(250);
  }
  const token = (await fetch(`${retryUrl}/`).then(r => r.text())).match(/name="auto-retry-token" content="([^"]+)"/)?.[1];
  assert.ok(token);
  const send = stream => fetch(`${retryUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'retry-fixture/fixture-model', messages: [{ role: 'user', content: 'fixture' }], stream }), signal: AbortSignal.timeout(120000) });
  // Exhaust Magpie's own short retries so the retained outer request really retries.
  failuresRemaining = 20;
  const result = await send(false);
  const reply = await result.json();
  assert.equal(result.status, 200, JSON.stringify(reply));
  assert.equal(reply.choices[0].message.content, 'fixture recovery');
  assert.ok(!('_magpieAutoRetry' in reply));
  const state = await fetch(`${retryUrl}/api/state`, { headers: { 'X-Auto-Retry-Token': token } }).then(r => r.json());
  const provider = state.providers.find(p => p.id === 'retry-fixture');
  assert.equal(provider.attribution, 'gateway');
  assert.ok(state.totals.recoveredRequests >= 1, JSON.stringify({ upstreamAttempts, totals: state.totals }));
  console.log(`MAGPIE_RECOVERY_OK upstreamAttempts=${upstreamAttempts} retries=${state.totals.retries}`);
  console.log('MAGPIE_PROVIDER_ATTRIBUTION_OK retry-fixture');
  const stream = await send(true).then(r => r.text());
  assert.ok(stream.includes('fixture recovery') && stream.includes('[DONE]'));
  assert.ok(!stream.includes('_magpieAutoRetry'));
  console.log('MAGPIE_SSE_OK complete=true metadataStripped=true');
  for (const [path, body, ending] of [
    ['/v1/messages', { model: 'retry-fixture/fixture-model', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'fixture' }] }, 'message_stop'],
    ['/v1/responses', { model: 'retry-fixture/fixture-model', input: 'fixture', stream: true }, 'response.completed'],
    ['/v1beta/models/retry-fixture/fixture-model:streamGenerateContent?alt=sse', {
      contents: [{ role: 'user', parts: [{ text: 'fixture' }] }],
    }, 'finishReason'],
  ]) {
    const response = await fetch(retryUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(text.includes('fixture recovery') && text.includes(ending), text);
    assert.ok(!text.includes('stream_interrupted') && !text.includes('_magpieAutoRetry'), text);
    assert.ok(!text.includes('[DONE]'), 'non-Chat native streams must use their own terminal shape');
  }
  console.log('MAGPIE_NATIVE_PROTOCOLS_OK anthropic=true responses=true gemini=true');
  console.log('MAGPIE_SMOKE_OK');
} finally {
  if (child?.pid) {
    if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else child.kill('SIGTERM');
  }
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await writeFile(join(root, 'host-test.log'), logs);
  console.log(`MAGPIE_FIXTURE_DIR ${root}`);
}
