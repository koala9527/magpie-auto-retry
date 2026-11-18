# 管理 API 与前端契约

页面使用相对 URL（`api/state` 而非 `/api/state`），以兼容 Magpie web 的服务路径前缀。每个请求附加 HTML meta `name="auto-retry-token"` 的值：`X-Auto-Retry-Token`。页面不用 Magpie bridge；只有 `page/` 启动页使用官方 bridge。

## API

- `GET api/state?period=24h|7d|30d` → 下列 Snapshot。
- `PATCH api/settings`，JSON 为部分 Settings → `{settings}`。未知字段/范围错误返回 422；失败保留旧设置。
- `POST api/statistics/reset`，JSON `{confirm:true}` → `{ok:true}`。界面先确认；仍然活跃的请求保留。
- `POST api/requests/<id>/cancel` → `{ok:true}`；id 来自当前 Snapshot。
- `GET api/export` → 聚合统计 JSON（不含页面令牌、请求内容或密钥）。

导出先在对话框显示可选择/复制的 JSON，兼容 Magpie 的 `allow-scripts` 沙盒页面；独立浏览器另提供下载按钮。不把浏览器禁止的下载显示成已完成。导出内容只包含聚合观测。

错误形状 `{error:{code,message,fields?}}`。API 断连必须显式显示，不能伪装成正常空态。每 3 秒刷新；隐藏页面可暂停。保存设置时不要因轮询覆盖未保存表单。成功与错误状态使用 aria-live。

## Settings

```json
{
  "enabled": true,
  "upstreamUrl": "http://127.0.0.1:3425",
  "initialDelayMs": 2000,
  "maxDelayMs": 60000,
  "jitter": true,
  "attemptTimeoutMs": 120000,
  "streamIdleTimeoutMs": 120000,
  "heartbeatMs": 10000,
  "maxConcurrentRequests": 32,
  "historyDays": 30
}
```

范围：initialDelayMs 100–60000；maxDelayMs 100–3600000 且 >=initialDelayMs；attemptTimeoutMs/streamIdleTimeoutMs 1000–600000；heartbeatMs 1000–30000；maxConcurrentRequests 1–256；historyDays 1–90。重试次数固定为无限，不是设置项。界面以秒显示时间，提交时转为毫秒。

## Snapshot

```js
{
  version: "1.0.1", generatedAt: 1794900000000, period: "24h",
  server: {
    port: 3430, proxyUrl: "http://127.0.0.1:3430/v1",
    upstreamUrl: "http://127.0.0.1:3425", runningSince: 1794900000000,
    uptimeMs: 100000, storageStatus: "ok", // or "memory-only"
    admittedRequests: 0 // 上传、推理与模型目录共用的占位数
  },
  settings: Settings,
  totals: {
    requests: 0, successes: 0, failures: 0, retries: 0,
    recoveredRequests: 0, failedRequests: 0, cancelledRequests: 0,
    interruptedStreams: 0, activeRequests: 0, waitingRequests: 0,
    availableMs: 0, unavailableMs: 0, observedMs: 0,
    availabilityPercent: null // 无观测用 —，不能显示 100%
  },
  providers: [{
    id: "provider-id", name: "Provider Name", status: "unknown", // healthy/outage
    attribution: "gateway" , // requested-model（无中间件归属数据时）
    requests: 0, successes: 0, failures: 0, retries: 0, recoveredRequests: 0,
    availableMs: 0, unavailableMs: 0, observedMs: 0, availabilityPercent: null,
    lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null,
    consecutiveFailures: 0,
    buckets: [{startAt: 1794900000000, availableMs: 0, unavailableMs: 0,
      requests: 0, successes: 0, failures: 0, retries: 0, recoveredRequests: 0}]
  }],
  activeRequests: [{id: "random-id", providerId: "provider-id", model: "provider/model",
    startedAt: 1794900000000, attempt: 3, nextRetryAt: null,
    status: "requesting", hasOutput: false}], // waiting/streaming
  incidents: [{id: "random-id", providerId: "provider-id", providerName: "Provider Name",
    startedAt: 1794900000000, endedAt: null, durationMs: 10000,
    failures: 3, reason: "http_503"}],
  events: [{id: "random-id", time: 1794900000000, type: "retry", providerId: "provider-id",
    attempt: 3, status: 503, delayMs: 8000, code: "http_503"}]
}
```

providers 的计数和时长按 period 汇总；activeRequests 始终是当前值；incidents/events 按 period 限制，最新在前。可用率为观测指标，不是无流量时探活的 SLA。归属为 requested-model 的路由别名不是实际提供商，界面应显示「按请求模型归属」。

前端设计：精致、克制的运维仪表台，墨绿/薄荷强调色、温暖浅灰背景、清晰数字与小时状态带；避免泛用渐变卡片。中文为主，英文产品名 Magpie Auto Retry。真实默认空态，不添加固定的示例提供商或统计。
