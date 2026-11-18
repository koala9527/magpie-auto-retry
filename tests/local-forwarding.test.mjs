import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureCodexForwarding, planCodexForwarding } from '../src/local-forwarding.mjs';

const config = '# keep this comment\r\nmodel_provider = "magpie"\r\nmodel = "sample/model"\r\n[model_providers.magpie]\r\nbase_url = "http://127.0.0.1:3425/v1" # local\r\nwire_api = "responses"\r\nenv_key = "EXISTING_KEY"\r\n[model_providers.custom]\r\nbase_url = "https://example.invalid/v1"\r\n';
const urls = { upstreamUrl: 'http://127.0.0.1:3425', proxyUrl: 'http://127.0.0.1:3430/v1' };

test('local forwarding changes only the selected Magpie URL, preserving model, key and formatting', () => {
  const result = planCodexForwarding(config, urls);
  assert.equal(result.changed, true);
  assert.equal(result.content, config.replace('http://127.0.0.1:3425/v1', urls.proxyUrl));
  assert.equal(planCodexForwarding(result.content, urls).status, 'already_configured');
});

test('local forwarding leaves remote, custom, ambiguous and multiline TOML configurations alone', () => {
  for (const text of [
    config.replace('model_provider = "magpie"', 'model_provider = "custom"'),
    config.replace('http://127.0.0.1:3425/v1', 'https://example.invalid/v1'),
    config.replace('base_url = "http://127.0.0.1:3425/v1"', 'base_url = "http://127.0.0.1:3425/v1"\r\nbase_url = "http://localhost:3425/v1"'),
    'notice = """\n' + config + '\n"""',
  ]) {
    const result = planCodexForwarding(text, urls);
    assert.equal(result.changed, false);
    assert.equal(result.content, text);
  }
  assert.throws(() => planCodexForwarding(config, { ...urls, proxyUrl: 'https://external.invalid/v1' }));
  assert.throws(() => planCodexForwarding(config, { ...urls, proxyUrl: 'http://127.0.0.1:3425/v1' }));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'retry-forwarding-'));
  const directory = join(root, 'magpie');
  const codexHome = join(root, 'codex');
  await mkdir(directory); await mkdir(codexHome);
  await writeFile(join(codexHome, 'config.toml'), config);
  return { directory, codexHome, ...urls };
}

test('startup forwards only the current Codex home explicitly tracked by Magpie', async () => {
  const f = await fixture();
  assert.equal((await configureCodexForwarding(f)).status, 'not_managed');
  assert.equal(await readFile(join(f.codexHome, 'config.toml'), 'utf8'), config);
  await writeFile(join(f.directory, 'codex-portable.json'), JSON.stringify({ homes: { [f.codexHome]: { lineage: true } } }));
  const report = await configureCodexForwarding(f);
  assert.equal(report.status, 'configured');
  assert.equal(report.restartRequired, true);
  assert.equal(await readFile(join(f.codexHome, 'config.toml'), 'utf8'), config.replace('http://127.0.0.1:3425/v1', urls.proxyUrl));
  assert.equal((await configureCodexForwarding(f)).status, 'already_configured');
  assert.ok(!JSON.stringify(report).includes('EXISTING_KEY'));
  assert.ok(!JSON.stringify(report).includes(f.codexHome));
});

test('damaged tracking data, disabled forwarding and symlinked config do not overwrite files', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'codex-portable.json'), '{broken');
  assert.equal((await configureCodexForwarding(f)).status, 'error');
  assert.equal((await configureCodexForwarding({ ...f, enabled: false })).status, 'disabled');
  assert.equal(await readFile(join(f.codexHome, 'config.toml'), 'utf8'), config);
  // Directory escape protection is platform-independent; symlinks may need Windows privileges.
  const other = join(f.directory, 'other'); await mkdir(other);
  await writeFile(join(other, 'config.toml'), config);
  await writeFile(join(f.directory, 'codex-portable.json'), JSON.stringify({ homes: { [other]: { lineage: true } } }));
  assert.equal((await configureCodexForwarding(f)).status, 'not_managed');
  assert.equal(await readFile(join(other, 'config.toml'), 'utf8'), config);
  const linked = join(f.directory, 'linked');
  await symlink(other, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(f.directory, 'codex-portable.json'), JSON.stringify({ homes: { [linked]: { lineage: true } } }));
  assert.equal((await configureCodexForwarding({ ...f, codexHome: linked })).status, 'unsupported_config');
  assert.equal(await readFile(join(other, 'config.toml'), 'utf8'), config);
});
