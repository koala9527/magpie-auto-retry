# Quality contract

- Runtime dependencies: zero; ESM on Node >=22 or Magpie's Bun host.
- All retry/stream changes require a regression test; no skipped/deleted failing tests.
- Native `npm run check`, `npm test` and `npm run test:browser` are release gates.
- Core coverage: lines >=85%, functions >=85%, branches >=80%.
- Preserve caller cancellation and never replay after semantic SSE output.
- Bounded concurrency (default 32), request/event bytes and retained history; no retry-count or total-outage timeout.
- No telemetry, external assets, credential/prompt storage or cross-origin inference access.
- The dashboard must render empty/unknown/error states honestly and avoid horizontal overflow at 390px.
