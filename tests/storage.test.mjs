import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.mjs';
import { Statistics } from '../src/statistics.mjs';

test('writes are atomic and serialized so the newest settings win', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-storage-'));
  const storage = new Storage(dir);
  assert.equal(await storage.read('missing.json'), null);
  await Promise.all([storage.write('settings.json', { enabled: true }), storage.write('settings.json', { enabled: false })]);
  assert.equal((await storage.read('settings.json')).enabled, false);
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('invalid JSON is kept under a corrupt filename and state starts empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-storage-'));
  const storage = new Storage(dir);
  await writeFile(join(dir, 'statistics.json'), 'not-json');
  assert.equal(await storage.read('statistics.json'), null);
  assert.equal(storage.status, 'memory-only');
  const files = await readdir(dir);
  assert.ok(files[0].startsWith('statistics.json.corrupt-'));
  assert.equal(await readFile(join(dir, files[0]), 'utf8'), 'not-json');
  await storage.write('statistics.json', { schemaVersion: 1, providers: [] });
  assert.equal(storage.status, 'ok');
});

test('unwritable paths report memory-only and do not claim a successful settings save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-storage-'));
  const blocked = join(dir, 'is-a-file');
  await writeFile(blocked, 'keep');
  const storage = new Storage(blocked);
  await assert.rejects(storage.write('settings.json', {}));
  assert.equal(storage.status, 'memory-only');
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
});

test('valid JSON with an invalid statistics schema cannot prevent service recovery', () => {
  assert.doesNotThrow(() => new Statistics({ now: () => 1000, saved: {
    schemaVersion: 1, providers: [null, 'invalid', { id: 'a', buckets: [null, 'invalid', {}] }], events: {}, incidents: {},
  } }).snapshot());
});
