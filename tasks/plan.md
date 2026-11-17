# Implementation plan

Source: SPEC.md; API contract: docs/api.md.

1. Preserve original tree/hash and execute the baseline suite.
2. Write failing tests for settings, retry classification/backoff and observation accounting; implement and verify.
3. Write failing real HTTP/SSE recovery/cancellation tests; implement a loopback retry gateway with request ownership.
4. In parallel with step 3, build the dashboard against the frozen API contract; UI write scope is ui/ and page/.
5. Integrate official Magpie main/middleware/page service, verify through an isolated official CLI.
6. Test the real browser, security boundaries, packaging and an independently restored baseline copy.
7. Replace public package metadata/docs, prepare clean open-source history, publish to the requested remote and record exact evidence.

Risks: replayed partial output → never retry after semantic output; unknown provider attribution → explicit requested-model fallback; idle uptime inflation → 5-minute freshness; service restarts → abort active requests, persist aggregates only; local browser abuse → loopback Host/Origin guards plus per-start admin token.
