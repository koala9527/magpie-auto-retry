import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetryServer } from '../src/server.mjs';

const service = await createRetryServer({ port: 3431, dataDir: await mkdtemp(join(tmpdir(), 'magpie-auto-retry-browser-')) });
const stop = async () => { await service.close(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
console.log(`BROWSER_SERVER_READY ${service.address}`);
