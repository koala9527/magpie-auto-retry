# Magpie Auto Retry

**Keep the task alive until the provider recovers, not until the retry budget runs out.**

[中文](README.md) · [Magpie plugin documentation](https://usemagpie.ai/docs/plugins) · [Architecture](docs/architecture.md)

## Features

- Infinite retries for temporary provider/network faults, with capped exponential backoff, jitter and Retry-After.
- A single retained inference request: recovery returns the result to the original client without spending the client's finite retry budget.
- SSE keepalive while waiting, pre-output stream recovery, and cancellation of active fetches and backoff.
- Never replay after text, reasoning or tool-call output; permanent request/authentication/quota errors end promptly.
- A local dashboard for hot settings, waiting requests, provider failures/recoveries, incidents and observed availability.
- Zero runtime dependencies, no telemetry/CDNs, bounded concurrency/history/memory, MIT license.

## Install

```sh
magpie plugin add github:koala9527/magpie-auto-retry
```

Enable the plugin and open **Auto Retry** in Magpie's sidebar. Set your agent's Magpie API base URL to `http://127.0.0.1:3430/v1`, retaining its original model, key and protocol. Anthropic SDKs usually take the origin without `/v1`. The local Magpie upstream defaults to `http://127.0.0.1:3425`.

```text
Agent → Auto Retry :3430 → Magpie :3425 → Provider
```

The plugin uses Magpie's official `main` and `magpie.page.service` interfaces. Its synchronous middleware only passes public provider attribution; it does not run the retry loop. Agent configuration files are never changed automatically.

Supported inference endpoints: Chat Completions, Responses, Anthropic Messages and Gemini generateContent/streamGenerateContent. Native Gemini URL models retain `provider/model` and colon tags. GET `/v1/models` preserves the original catalog. Uploads, deletions and tool execution are not proxied.

## Standalone development

Node.js 22+ is required for standalone mode; the installed plugin runs on Magpie's Bun host.

```sh
git clone https://github.com/koala9527/magpie-auto-retry.git
cd magpie-auto-retry
npm ci --ignore-scripts
npm run dev
```

Dashboard: `http://127.0.0.1:3430/`.

```sh
node bin/magpie-auto-retry.mjs --port 3430 --upstream http://127.0.0.1:3425 --data-dir .local/state
```

Standalone observations without the installed middleware are attributed to the requested model prefix, not inferred internal routing members.

## Defaults

| Setting | Default |
| --- | --- |
| Retry enabled / retry limit | Yes / infinite |
| Initial / maximum backoff | 2s / 60s |
| Jitter | ±25% |
| Attempt / stream idle timeout | 120s / 120s |
| SSE heartbeat | 10s |
| Concurrent requests | 32 |
| History | 30 days, configurable 1–90 |

Retry-After may extend the backoff beyond its normal cap, up to 24 hours. Dashboard settings are persisted atomically and apply to subsequent attempts. Disabling retries releases waiting requests. Restore defaults only fills the form; save explicitly.

The port is a startup setting in Magpie's plugin options. Restart the plugin after changing it. The options' upstream URL bootstraps the first run; subsequent settings come from the dashboard's dedicated settings file.

## Availability and request semantics

Failures count **upstream attempts**, not tasks. Recovered requests experienced at least one failure followed by a complete success. Availability is passive observation, not active probing or an account allowance: no traffic for five minutes becomes unknown, and process downtime never counts as healthy. An empty availability value is `—`, not 100%.

A request still connected to the service continues after recovery. Cancelled requests, exited agent processes and requests lost on a service restart are not persisted or resurrected. Partial-output failures end with a protocol-shaped error, preventing duplicate tool calls; the client owns the subsequent task lifecycle. Non-streaming clients retain their own HTTP timeout.

## Privacy

Only provider identifiers, counters, hourly observations, incidents and the latest 200 structured events are persisted. Prompts, credentials, accounts, tool arguments and full upstream error text are never logged or exported. The service is loopback-only, validates Host/Origin, rejects browser inference requests, uses a per-start dashboard token and only accepts a local Magpie upstream. No TLS verification is disabled.

Plugin data: `<Magpie config>/magpie-auto-retry/`. Standalone data: `~/.magpie-auto-retry/` or `--data-dir`.

Exports open a selectable/copyable aggregate JSON dialog inside Magpie's sandbox. Standalone browsers also offer an explicit download button.

## Verify and contribute

```sh
npm run check
npm test
npm run test:coverage
npx playwright install chromium
npm run test:browser
npm pack
```

See the [1.0.0 verification record](docs/verification.md), [CONTRIBUTING.md](CONTRIBUTING.md), [CONSTRAINTS.md](CONSTRAINTS.md) and [docs/api.md](docs/api.md). To revert an installation, point the agent back to Magpie and disable/remove the plugin; no provider or agent state was changed.

[MIT](LICENSE) · [koala9527/magpie-auto-retry](https://github.com/koala9527/magpie-auto-retry)
