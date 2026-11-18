# Changelog

## 1.0.2 — 2026-11-18

- 默认开启本地转发：启动时自动检测 Magpie 管理的本机 Codex 配置，将原网关端口平滑切至重试插件端口（重开 Codex 即生效）。
- 移除页面原“接入方式”标签页与手动修改提示，替换为“运行信息”面板显示本地转发状态与服务信息。
- 优化重试策略与风控保护：
  - 内容安全过滤（`content_filter` / `SAFETY` / `PROHIBITED_CONTENT`）判定为非临时故障，立即终止并返回客户端，避免反复违规重试导致账号被上游风控封号。
  - 协议不匹配（如账号仅支持 Chat Completions 但调用了 Responses 工具格式）判定为非临时故障，立即返回不重试。
- 移除 README 中的“停用和回退”，去除 AI 腔调，使说明更通俗直观。

## 1.0.1 — 2026-11-18

- 页面改为灰白配色、横向导航和紧凑双栏，缩小字号；深色主题和启动页同步调整。
- 总览与设置增加持续重试可能产生费用、触发风控或封号的提示。
- 页面补充每项参数的默认值、作用和完整重试流程；区分单次等待、总等待、心跳与模型调用。
- 中英文 README 改用直接的说明，补充取消、部分输出、永久错误和统计口径。
- 修正双栏导航高亮，新增布局、风险、参数与流程的浏览器回归测试。
- 重试逻辑、默认参数、数据格式和依赖保持不变。

## 1.0.0 — 2026-11-17

- Local Magpie service plugin and standalone CLI with zero runtime dependencies.
- Unbounded, cancellable provider retries with jitter, exponential backoff and Retry-After.
- Request-preserving HTTP/SSE recovery and no replay after semantic output.
- Public provider attribution through a request-local synchronous middleware.
- Hot settings, current requests, incidents, exports and observed-availability dashboard.
- Local-only management boundaries, atomic aggregate persistence and open-source test/CI workflow.
