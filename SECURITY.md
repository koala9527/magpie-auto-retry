# Security policy

## Supported version

The latest 1.x release is maintained. Use the current Magpie host and Node.js 22+ in standalone mode.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/koala9527/magpie-auto-retry/security/advisories/new) if available. Do not post credentials, prompts, agent configuration or exploit details in a public issue. Include a minimal isolated reproduction, affected version and impact.

## Trust boundaries

The service runs locally with the plugin host's permissions. It binds loopback, accepts only a local Magpie upstream, rejects browser inference requests, validates Host/Origin, and requires a per-start token for administration. It is not a public multi-tenant gateway; expose Magpie rather than exposing this local service.

Authentication headers are forwarded to the existing Magpie gateway; no credential is stored or upgraded. The dashboard stores non-sensitive configuration and bounded aggregate observations only. Uploaded files, tool execution and destructive APIs are never proxied. Upstream responses and error objects are untrusted and byte-limited; rendering uses text nodes.

Infinite retries can cause additional provider requests/billing before a result is observed. The service preserves supplied idempotency headers but does not invent an exactly-once guarantee. It never retries after semantic text, reasoning or tool-call output and responds immediately to cancellation.
