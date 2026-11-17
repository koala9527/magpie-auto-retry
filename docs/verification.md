# Release verification — 1.0.0

Verified on 2026-11-17 with Node.js 22.23.2, npm 10.9.8, official Magpie 0.1.4358 and its Bun 1.4.2 host.

| Check | Observed result |
| --- | --- |
| `npm ci --ignore-scripts` | Clean install; 0 vulnerabilities |
| `npm run check` | 26 JavaScript modules; all manifest entries exist; 0 runtime dependencies |
| `npm run test:coverage` | 60 passed; 0 failed, skipped or cancelled |
| Core coverage | 98.19% lines; 88.47% branches; 92.11% functions |
| Same tests on official Bun | 60 passed; 0 failed |
| `npm run test:browser` | 28 dashboard/bridge contracts and 3 live-backend flows passed |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm pack` | Prepack checks/tests passed; 24 runtime/documentation files; no private state or development artifacts |
| Independent package smoke | CLI version, health, 3 assets, management API, 2 failures → recovery, persistence and no active requests left |

The deterministic retry test fails 1001 upstream attempts and succeeds on attempt 1002. This checks the absence of a finite retry counter; it does not claim a literal infinite-duration experiment.

The official host test installs the plugin in an isolated portable configuration and uses random loopback ports and a local provider fixture. It observes:

```text
MAGPIE_PLUGIN_LOADED hooks=onRequest,onProvider,onEvent,onResponse
MAGPIE_RECOVERY_OK upstreamAttempts=21 retries=2
MAGPIE_PROVIDER_ATTRIBUTION_OK retry-fixture
MAGPIE_SSE_OK complete=true metadataStripped=true
MAGPIE_NATIVE_PROTOCOLS_OK anthropic=true responses=true gemini=true
MAGPIE_SMOKE_OK
```

Reproduce it with an official Magpie CLI and its compatible Bun binary:

```sh
MAGPIE_TEST_BINARY=/absolute/path/to/magpie \
MAGPIE_TEST_BUN=/absolute/path/to/magpie-bun \
node scripts/magpie-smoke.mjs
```

The test writes only its isolated fixture configuration, starts its own host and cleans up its own process tree. It never uses an existing provider account or Agent configuration.

Covered boundaries include cancellation during backpressure, concurrency before upload and during model catalog reads, opaque sandbox authorization, partial tool/text/refusal output without replay, native protocol termination, bounded Gemini candidate indexes, incomplete SSE tails, atomic settings persistence and honest unknown availability after idle/offline intervals.

The [cross-platform CI run](https://github.com/koala9527/magpie-auto-retry/actions/runs/44085303081) for commit `3eea40a6afa2bcc3e2a91b3fcd48d7027856cef3` completed successfully: all four Windows/Linux × Node.js 22/24 jobs and the Linux Chromium browser job passed. The browser contract waits for the queued dialog close/focus event. The cancellation regression waits for actual backpressure with a bounded producer instead of assuming a fixed OS socket-buffer size.
