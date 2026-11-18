# Magpie Auto Retry

A local retry service for Magpie. When a provider temporarily fails, it waits and retries the same request. Once the request succeeds, the agent gets the result and continues its task. Retry count and total outage duration are unlimited by default.

[简体中文](README.md) · [Magpie plugin documentation](https://usemagpie.ai/docs/zh/plugins) · [Architecture](docs/architecture.md) · [Management API](docs/api.md)

## Read this first

**Repeated requests may incur additional charges and trigger provider rate limits, abuse controls, or account suspension.** A failed response does not mean the provider did not bill it. This plugin does not fix invalid keys, suspended accounts, or exhausted credit, and no settings guarantee account safety.

For persistent rate limiting, increase the waits, reduce concurrency, or disable retries.

## Install or update

```sh
magpie plugin add github:koala9527/magpie-auto-retry
```

Enable **Auto Retry** in Magpie's plugin list. Existing users can use Magpie's plugin update action, then restart the plugin. Current revision: **1.0.2**. Updating keeps saved settings.

The CLI command is `magpie plugin update`; it updates all community plugins. Restart this plugin afterward.

### Default local forwarding

On startup, the plugin automatically inspects Magpie-managed Codex configurations and updates the base URL from the default gateway (`3425`) to the retry service (`http://127.0.0.1:3430/v1`). If Codex is currently running, **restart Codex once** to apply the change. No manual configuration editing or connection setup is needed. Forwarding status is visible directly under the **Runtime info** section.

For standalone or unmanaged agents, point the API base URL to `http://127.0.0.1:3430/v1` while keeping the original model names and Magpie keys.

## How a request travels

Think of it as a forwarding desk in front of Magpie. It does not answer for the model or restart the agent; it keeps an existing request waiting for a result.

```text
Agent → Auto Retry :3430 → Magpie :3425 → provider
```

1. Forward the agent's request to local Magpie, which calls the provider.
2. On a temporary network error, 408/425/429/5xx, attempt timeout, or a temporary/empty/interrupted stream before output, keep the client connection open and retry the same body after a wait.
3. Increase the wait after consecutive failures. With defaults and jitter disabled: **2 → 4 → 8 → 16 → 32 → 60 → 60… seconds**. Jitter is enabled by default, so actual waits vary slightly.
4. On complete success, return the result. The agent then continues using its own task loop.
5. **Stop immediately on permanent errors and safety refusals**:
   - **Content filters (`content_filter` / safety refusal)**: When a provider's safety policy blocks a prompt, retrying repeatedly will never succeed and will trigger abuse detection, risking account suspension or bans. The plugin halts and returns the refusal directly.
   - **Protocol mismatch (e.g. `requires Responses for tool calls`)**: If the provider account protocol does not support the requested endpoint/tool features, retrying cannot resolve it; the error is returned immediately.
   - **Auth and quota errors**: 401/403, invalid keys, exhausted quota, or TLS errors terminate the request immediately.

### When retries stop

- Once text, reasoning, or tool-call output has been sent, never replay the request from the beginning. A subsequent interruption sends a protocol error and ends the response.
- Cancellation, disconnection, agent exit, plugin shutdown, or restart ends the in-memory request. Unfinished tasks are not stored or resurrected.
- A non-streaming client's own total HTTP timeout still applies.
- Waiting heartbeats are SSE comments, not model calls or provider health probes.

## Settings in plain language

Edits apply only after **Save settings**. Saving does not restart the current request; later attempts read updated settings. Disabling retries also ends requests waiting to retry. **Restore defaults** fills the form but does not save it.

The page uses seconds. API fields ending in `Ms` use milliseconds.

| Setting / API field | Default; range | What it changes |
| --- | --- | --- |
| Enable retry / `enabled` | On | Retry temporary failures. When off, new requests get one attempt and waiting retries stop. |
| Initial delay / `initialDelayMs` | 2 s; 0.1–60 s | Wait before the first retry. A shorter wait sends requests more frequently. |
| Maximum delay / `maxDelayMs` | 60 s; 0.1–3600 s | Ceiling for each normal backoff wait, at least the initial delay. **Not a total waiting limit.** A provider's `Retry-After` may require longer, up to 24 hours. |
| Jitter / `jitter` | On | Randomly vary waits by about ±25%, capped at the maximum delay, so requests do not retry together. Does not switch models or accounts. |
| Attempt timeout / `attemptTimeoutMs` | 120 s; 1–600 s | Limit for one attempt to receive headers and finish a non-streaming response. Not a task lifetime limit. Streaming responses use the idle timeout after headers. |
| Stream idle timeout / `streamIdleTimeoutMs` | 120 s; 1–600 s | Treat an upstream stream as interrupted if no bytes arrive for this long. Incoming data resets the timer; emitted output is never replayed. |
| Heartbeat interval / `heartbeatMs` | 10 s; 1–30 s | Send a waiting comment to streaming clients. No extra model call, no answer text, no health probe. |
| Concurrency / `maxConcurrentRequests` | 32; 1–256 | Shared admission budget for inference, request uploads, and model catalog requests. Return 429 when full. Not the retry count. |
| History retention / `historyDays` | 30 days; 1–90 | Retain statistics and incidents, not chat history. |
| Magpie upstream / `upstreamUrl` | `http://127.0.0.1:3425` | Local Magpie address, not the provider website or the retry service's own port 3430. |

To change the listening port, update Magpie's plugin options, restart the plugin, and update the agent address:

```sh
magpie plugin options magpie-auto-retry '{"port":3430,"upstreamUrl":"http://127.0.0.1:3425"}'
```

The upstream option seeds the first run. After that, saved dashboard settings take precedence.

## Reading the statistics

- A **failure** is a failed upstream attempt, not a failed task. One request may fail ten times before succeeding.
- A **recovered request** failed at least once and then completed successfully.
- **Observed availability** uses real request results. Successful observations count as available; failed observations count as unavailable. After five minutes without traffic, or while the service is offline, time is unknown.
- Availability = available time / (available + unavailable time). With no observations, show `—`, not 100%. This is neither a provider uptime guarantee nor a credit balance.
- Magpie may try several route members internally. Only results actually received by this retry service are counted.
- Cancel active requests on the page. JSON exports contain statistics only; copy them in Magpie or download them in a standalone browser.

## Protocols and storage

Supports OpenAI Chat Completions and Responses, Anthropic Messages, Gemini `generateContent` / `streamGenerateContent`, and `GET /v1/models`. File upload/deletion and tool execution endpoints are not forwarded.

The bundled request-local middleware identifies the actual responding provider; its metadata is removed before returning output. Standalone mode groups by requested model. A route group's name does not identify its actual provider.

Plugin data lives in `magpie-auto-retry/` under Magpie's configuration directory. Standalone data defaults to `~/.magpie-auto-retry/`; override with `--data-dir`.

`settings.json` stores settings. `statistics.json` stores provider names/IDs, hourly counters, incident intervals, and the latest 200 structured events. Prompts, chat content, tool arguments, and credentials are not written to logs, statistics, or exports. Requests and authentication headers stay in memory.

The service binds only to loopback. Admin requests require a random startup token and Host/Origin checks. No telemetry, external fonts, CDN, or runtime dependencies. Corrupt state is preserved as `.corrupt-<time>`; write failures are shown on the page.

## Development and checks

Standalone development requires Node.js 22+. Magpie runs the plugin in its managed Bun host. The UI is plain HTML/CSS/JS, with no build step.

```sh
git clone https://github.com/koala9527/magpie-auto-retry.git
cd magpie-auto-retry
npm ci --ignore-scripts
npm run dev
# Open http://127.0.0.1:3430/
```

```sh
node bin/magpie-auto-retry.mjs --port 3430 --upstream http://127.0.0.1:3425 --data-dir .local/state
npm run check
npm test
npm run test:coverage
npx playwright install chromium
npm run test:browser
npm pack
```

See the [1.0.2 verification record](docs/verification-1.0.2.md), [quality contract](CONSTRAINTS.md), and [contribution guide](CONTRIBUTING.md).

## License

[MIT](LICENSE)
