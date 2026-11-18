import { lstat, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function localUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) throw new Error('Expected a local gateway URL.');
  return url;
}

export function planCodexForwarding(content, { upstreamUrl, proxyUrl }) {
  const upstream = localUrl(upstreamUrl);
  const proxy = localUrl(proxyUrl);
  if (upstream.port === proxy.port && upstream.protocol === proxy.protocol) throw new Error('Forwarding would loop.');
  const unchanged = status => ({ content, changed: false, status });
  // This edits one existing scalar, not arbitrary TOML. Multiline strings can
  // contain fake sections; leave unfamiliar configurations untouched.
  if (content.includes('"""') || content.includes("'''")) return unchanged('unsupported_config');
  const lines = content.split(/(?<=\n)/);
  let section = '';
  const selections = [];
  const bases = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/.exec(lines[i]);
    if (header) { section = header[1].replace(/["']/g, ''); continue; }
    const selected = /^\s*model_provider\s*=\s*(["'])([^"']+)\1\s*(?:#.*)?(?:\r?\n)?$/.exec(lines[i]);
    if (section === '' && selected) selections.push(selected[2]);
    const base = /^(\s*base_url\s*=\s*)(["'])([^"']+)\2(\s*(?:#.*)?(?:\r?\n)?)$/.exec(lines[i]);
    if (section === 'model_providers.magpie' && base) bases.push({ i, base });
  }
  if (selections.length !== 1 || selections[0] !== 'magpie') return unchanged('not_selected');
  if (bases.length !== 1) return unchanged('unsupported_config');
  const { i, base } = bases[0];
  let current;
  try { current = localUrl(base[3]); } catch { return unchanged('not_local'); }
  if (current.origin === proxy.origin && current.pathname.replace(/\/$/, '') === '/v1') return unchanged('already_configured');
  if (current.port !== upstream.port || current.protocol !== upstream.protocol) return unchanged('different_gateway');
  lines[i] = `${base[1]}${base[2]}${proxy.origin}/v1${base[2]}${base[4]}`;
  return { content: lines.join(''), changed: true, status: 'configured' };
}

export async function configureCodexForwarding({ directory, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), upstreamUrl, proxyUrl, enabled = true }) {
  const report = status => ({ status, restartRequired: status === 'configured' });
  if (!enabled) return report('disabled');
  let temporary;
  try {
    if (!isAbsolute(codexHome)) return report('not_managed');
    const home = resolve(codexHome);
    const trackingPath = join(directory, 'codex-portable.json');
    if ((await lstat(trackingPath)).size > 65536) return report('error');
    const tracking = JSON.parse(await readFile(trackingPath, 'utf8'));
    if (!tracking?.homes || !Object.entries(tracking.homes).some(([path, data]) => isAbsolute(path) && resolve(path) === home && data?.lineage === true)) return report('not_managed');
    if ((await lstat(home)).isSymbolicLink()) return report('unsupported_config');
    const file = join(home, 'config.toml');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || resolve(await realpath(file)).toLowerCase() !== file.toLowerCase()) return report('unsupported_config');
    const original = await readFile(file, 'utf8');
    const plan = planCodexForwarding(original, { upstreamUrl, proxyUrl });
    if (!plan.changed) return report(plan.status);
    temporary = join(home, `.auto-retry-${randomUUID()}.tmp`);
    await writeFile(temporary, plan.content, { flag: 'wx', mode: info.mode });
    if (await readFile(file, 'utf8') !== original) return report('config_changed');
    await rename(temporary, file);
    temporary = null;
    return report('configured');
  } catch (error) {
    return report(error.code === 'ENOENT' ? 'not_managed' : 'error');
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
