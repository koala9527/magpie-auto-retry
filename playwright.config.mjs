import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/live.spec.mjs',
  fullyParallel: false,
  retries: 0,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3431', browserName: 'chromium', viewport: { width: 1440, height: 1050 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/browser-server.mjs', url: 'http://127.0.0.1:3431/health', reuseExistingServer: false, timeout: 10000 },
});
