# Magpie Auto Retry — V1

## 目标

提供一个全新的 Magpie 本地服务插件，持有 Agent 的模型请求，对提供商临时故障无限重试，恢复后返回原请求的结果。独立页面提供基础设置、当前等待请求、按提供商的故障统计及观测可用时长。运行时只使用 Node/Bun 标准库。

## 能力与依赖

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| retry-policy | 错误分类、指数退避、Retry-After、取消 | — |
| observations | 聚合统计、故障区间、按小时观测时长 | — |
| retry-gateway | 保留原请求、真实 HTTP/SSE 转发、并发上限 | retry-policy, observations |
| dashboard | 设置、统计、接入说明、取消等待请求 | retry-gateway 的管理 API |
| magpie-plugin | 官方服务入口、页面桥接、提供商标记中间件 | retry-gateway, dashboard |

实现顺序：策略与统计 → 真实 HTTP 重试服务；页面按已定义的 API 并行实现 → 官方宿主验证与开源发布。

## 已核对的官方契约

- [插件开发文档](https://usemagpie.ai/docs/zh/plugins)：`main` 的插件函数返回 hooks；`magpie.page` 声明页面。
- [服务页面源码](https://github.com/yetone/magpie/blob/cd89ccdb4003847e26716be99f70f98dec1ca6a3/internal/plugin/page.go)：`magpie.page.service: {port, option}`；页面通过 `magpie.service` 访问服务。
- [网关中间件](https://github.com/yetone/magpie/blob/cd89ccdb4003847e26716be99f70f98dec1ca6a3/docs/subsystems/gateway-middleware.md)：`onRequest/onProvider/onResponse` 250ms，`onEvent` 50ms；这里仅传递无敏感内容的提供商归属标记。
- [网关默认地址](https://github.com/yetone/magpie/blob/cd89ccdb4003847e26716be99f70f98dec1ca6a3/internal/gateway/gateway.go)：`127.0.0.1:3425`。

## 行为验收

1. 408、425、429、5xx、连接失败、单次超时在客户端连接存续期间没有尝试次数/总时长上限；退避有上限、支持抖动及 Retry-After。
2. 无效请求、无效模型、401/403、明确不可用余额不循环；用户断开或页面取消会中止正在进行的 fetch 和等待。
3. SSE 在等待期间发送注释心跳。尚未产生语义输出时的错误/断流可重试；已输出的文本、思考或工具调用不从头重放，返回原协议的断流错误。
4. 原始推理请求只驻留内存；密钥原样转发至本机 Magpie，不写入设置、统计或日志。不代理工具执行、上传、删除等非推理接口。
5. 状态按提供商隔离。只有真实成功响应/完整流才能治愈；心跳、message_start、401、429 不当作成功。
6. 统计记录尝试失败数、重试数、恢复请求数、终止请求数、当前等待请求和故障区间。可用率 = 已观测可用时间 / 已观测时间；无流量超过 5 分钟、服务关闭期间是未知，不记为正常运行。
7. 设置热更新并原子落盘；保留 1–90 天的聚合数据。界面清楚区分真实数据、无数据及服务断连。
8. 服务只绑定 loopback；校验 Host 和 Origin；管理 API 使用每次启动随机的页面令牌。只允许本机 Magpie 作为上游，阻止回环及跨源推理。
9. 页面支持桌面和 390px 手机宽度、键盘操作、暗色、减少动画；无外部字体/CDN/遥测。

## 结构与命令

`src/` 标准库服务和纯逻辑；`ui/` 管理页面；`page/` Magpie 启动页面；`tests/` Node 单元/集成测试；`e2e/` Playwright；`docs/` 架构与使用说明。

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run test:coverage
npm run test:browser
npm run dev
npm pack
```

代码采用 ESM、两空格、分号；测试先写后实现。每个行为有确定性单元测试，真实 loopback HTTP/SSE 集成测试验证恢复、取消、断流和并发。浏览器测试覆盖实际设置保存、空态、统计和移动布局。

## 质量约束

禁止降低测试门槛、跳过失败测试、记录对话/密钥、依赖 Agent 自带的有限重试、在同步中间件睡眠、把未验证的宿主接口写成已支持。推理无限重试不意味着无限并发或无限内存。

## 接入契约

Agent 的 API 基址改为 `http://127.0.0.1:3430/v1`，模型名和 Magpie key 保持原样。Magpie 默认上游 `http://127.0.0.1:3425`。插件本身不会修改任何现有 Agent 的配置文件。

已退出的 Agent 进程、用户取消的请求和已发给客户端的部分输出不自动重放；它们的任务生命周期归客户端所有。持续存续的请求恢复后继续原任务。
