#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRetryServer } from '../src/server.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Magpie Auto Retry 1.0.1

Usage: magpie-auto-retry [--port 3430] [--upstream http://127.0.0.1:3425] [--data-dir PATH]

Dashboard: http://127.0.0.1:3430/
Agent base URL: http://127.0.0.1:3430/v1
Keep the original Magpie model name and key. Ctrl+C stops the service.`);
} else if (args.includes('--version')) {
  console.log('1.0.1');
} else {
  try {
    const flags = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--port', '--upstream', '--data-dir'].includes(args[i]) || !args[i + 1]) throw new Error(`Invalid argument: ${args[i]}`);
      flags[args[i]] = args[i + 1];
    }
    const port = flags['--port'] ? Number(flags['--port']) : 3430;
    const dataDir = flags['--data-dir'] ? resolve(flags['--data-dir']) : join(homedir(), '.magpie-auto-retry');
    const settings = flags['--upstream'] ? { upstreamUrl: flags['--upstream'] } : {};
    const service = await createRetryServer({ port, dataDir, settings });
    console.log(`Magpie Auto Retry 1.0.1\nDashboard: ${service.address}/\nAgent base URL: ${service.address}/v1\nRetry policy: infinite, cancellable`);
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; await service.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(`magpie-auto-retry: ${error.code === 'EADDRINUSE' ? 'The listen port is already in use.' : error.message}`);
    process.exitCode = 1;
  }
}
