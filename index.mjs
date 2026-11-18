import { join } from 'node:path';
import { createRetryServer } from './src/server.mjs';
import { configureCodexForwarding } from './src/local-forwarding.mjs';

let service;

// Magpie's documented OpenCode v1 entry, paired with magpie.page.service.
// https://usemagpie.ai/docs/zh/plugins
export default {
  id: 'magpie-auto-retry',
  async server(input, options = {}) {
    const port = options.port ?? 3430;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('magpie-auto-retry: port must be 1–65535.');
    if (!input?.directory) throw new Error('magpie-auto-retry: the host did not provide a configuration directory.');
    if (service) await service.close();
    service = await createRetryServer({ port, dataDir: join(input.directory, 'magpie-auto-retry'), settings: options, providerMetadata: true });
    service.localForwarding = await configureCodexForwarding({ directory: input.directory,
      upstreamUrl: service.snapshot().settings.upstreamUrl, proxyUrl: `${service.address}/v1`, enabled: options.autoForwardCodex !== false });
    return {};
  },
};

// Object export: the host must not mistake test helpers for plugin functions.
export const _internal = { get service() { return service; } };
