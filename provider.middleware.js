// Synchronous Magpie hooks only annotate requests owned by our retry service.
// Contract: https://usemagpie.ai/docs/zh/plugins#middleware
// No timers, I/O, shared module state, prompt capture or account metadata here.

export function onRequest(body, ctx) {
  if (body?._magpieAutoRetry !== 1) return;
  ctx.state.autoRetry = true;
  const { _magpieAutoRetry, ...clean } = body;
  return clean;
}

export function onProvider(_body, ctx) {
  if (!ctx.state.autoRetry || !ctx.provider) return;
  ctx.state.provider = { id: ctx.provider.id, name: ctx.provider.name };
  ctx.state.tagged = false;
}

function annotate(body, ctx) {
  if (!ctx.state.autoRetry || !ctx.state.provider) return;
  return { ...body, _magpieAutoRetry: { version: 1, provider: ctx.state.provider } };
}

export function onResponse(body, ctx) { return annotate(body, ctx); }

export function onEvent(event, ctx) {
  if (!ctx.state.autoRetry) return;
  if (ctx.state.tagged && !event.error && event.type !== 'response.failed') return;
  ctx.state.tagged = true;
  return annotate(event, ctx);
}
