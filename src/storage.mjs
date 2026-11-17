import { mkdir, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Storage {
  constructor(directory) { this.directory = directory; this.status = 'ok'; this.chain = Promise.resolve(); }

  async read(name) {
    try {
      const path = join(this.directory, name);
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('State file is too large.');
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      this.status = 'memory-only';
      // Keep the damaged file for inspection instead of silently overwriting it.
      try { await rename(join(this.directory, name), join(this.directory, `${name}.corrupt-${Date.now()}`)); } catch { /* Original remains intact. */ }
      return null;
    }
  }

  write(name, data) {
    const serialized = JSON.stringify(data);
    const write = async () => {
      const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
      try {
        await mkdir(this.directory, { recursive: true });
        await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
        await rename(temporary, join(this.directory, name));
        this.status = 'ok';
      } catch (error) {
        this.status = 'memory-only';
        try { await unlink(temporary); } catch { /* Nothing was created. */ }
        throw error;
      }
    };
    const result = this.chain.then(write);
    this.chain = result.catch(() => {});
    return result;
  }
}
