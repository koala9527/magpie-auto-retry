# Changelog

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
