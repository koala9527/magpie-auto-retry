import { readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
let checked = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.local', 'test-results', 'playwright-report', '.verification'].includes(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (/\.(?:mjs|js)$/.test(entry.name)) { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); checked++; }
  }
}
const { fileURLToPath } = await import('node:url');
await check(fileURLToPath(root));
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
for (const file of [pkg.main, pkg.magpie.middleware, pkg.magpie.page.file, 'ui/index.html', 'ui/app.js', 'ui/style.css', 'ui/icon.svg', ...Object.values(pkg.bin)]) await access(new URL(file, root));
if (pkg.name !== 'magpie-auto-retry' || !pkg.repository.url.includes('koala9527/magpie-auto-retry')) throw new Error('Invalid public package identity.');
if (Object.keys(pkg.dependencies ?? {}).length) throw new Error('Runtime must remain dependency-free.');
console.log(`CHECK_OK ${checked} JavaScript modules; manifest entries exist; zero runtime dependencies`);
