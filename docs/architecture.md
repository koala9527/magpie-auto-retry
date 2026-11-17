# 架构与设计决策

## 为何持有 HTTP 请求

Magpie 是网关，Agent 管理工具和任务循环。官方同步中间件只有 250ms（SSE 事件 50ms）预算；异步请求钩子也有有界预算，不能承载长时间等待。将错误返回 Agent 会消耗它自己的重试预算。因此本插件使用官方本地页面服务扩展：请求先到重试服务，原 Magpie 网关仍负责认证、协议翻译、路由和提供商连接。

来源：[官方插件文档](https://usemagpie.ai/docs/zh/plugins)，核对源码版本 `cd89ccdb4003847e26716be99f70f98dec1ca6a3`。

## 模块

```text
index.mjs                         官方 Bun 插件入口，返回 {}
provider.middleware.js            无 I/O、请求局部的提供商归属标记
page/index.html + launch.js        官方 bridge → magpie.service / loopback
bin/magpie-auto-retry.mjs          Node 独立入口
src/settings.mjs                  配置默认值与输入校验
src/policy.mjs                    失败分类、退避、Retry-After、可取消睡眠
src/retry.mjs                     请求拥有者、fetch 重试、SSE 转发
src/sse.mjs                       增量解码、输出/终止识别、协议错误
src/statistics.mjs                按提供商聚合、观测区间、故障/事件
src/storage.mjs                   原子写入与损坏文件保留
src/server.mjs                    loopback HTTP、管理授权、并发与生命周期
ui/                              无构建管理页面
```

## 重试状态机

```text
requesting → temporary failure → waiting → requesting → complete → recovered
                  │                │           │
                  └────────────────┴───────────┴── client cancellation → cancelled
requesting → permanent failure → failed
streaming + semantic output → stream failure → interrupted (no replay)
```

每个请求有自己的 AbortController；单次尝试是它的子控制器。等待、读流、网络 fetch 和写出背压都响应取消。外层循环没有尝试次数或总时间上限，退避通过指数封顶避免溢出。设置逐次读取，停用在等待期间也生效。

## 流式提交点

SSE 心跳和 message_start/response.created/role-only 是协议序言，不是语义输出。服务暂存有限序言，在文本、思考、工具参数/工具调用开始或完整终止事件出现时提交。若输出前失败，丢掉该尝试的序言并重试。已输出后任何断流/错误都结束请求，绝不重复工具。

Chat 的 finish_reason 后可能还有独立 usage 和 `[DONE]` 帧，不在 finish_reason 处提前截断。终止帧按请求协议判定：Anthropic 需要 message_stop，Responses 需要 response.completed，Gemini 需要所有请求候选的合法索引都收到 finishReason；聊天协议的 `[DONE]` 不替代其他协议的完成条件。Gemini 候选状态最多保留请求的 1–8 项，未知/越界索引不扩容；EOF 丢弃缺少空行分隔的尾事件。客户端已获得内容时收到的错误仍使用原协议。

Gemini 的原生 URL 可以包含 `provider/model` 和模型冒号标签。重试服务保留路径、查询及 JSON 内容，从 URL 单独提取统计归属；不为统计向原生请求体注入 model。此形状与官方 `gemini` 网关入口一致。

## 真实提供商归属

只有重试服务发出的请求携带 `_magpieAutoRetry:1`。`onRequest` 在路由前移除标记，`onProvider` 仅保留实际提供商 id/name，`onResponse` /首个 `onEvent` 添加相同版本的公开归属字段。服务消费并移除此字段。普通直连 Magpie 的请求不变。中间件不收集账号、密钥或对话，不使用跨请求的模块全局状态。

服务记录它实际收到的失败/成功，不通过 `onProvider` 的调用次数猜测 Magpie 内部每次尝试的结果。缺少标记时展示请求模型归属，路由组不会冒充真实提供商。

## 可用时长

成功使提供商状态成为 healthy，失败成为 outage。状态只在最后真实观测之后五分钟内有效；之后不再累计时间。每个有效区间拆到小时桶，重启时状态变 unknown，离线时间不累加为正常。故障区间展示起止墙钟时间，观测故障时长单独计算。历史自动裁剪，事件 200 条、故障区间 1000 条、提供商最多 512 个，限制无界增长。

## 本地边界

HTTP 仅绑定 127.0.0.1。Host 防 DNS rebinding；浏览器 Origin 不准访问推理。页面 API 要求随机 256-bit 启动令牌，只有浏览器导航打开的 HTML 获得；带 Origin 的 opaque HTML fetch 被拒绝，不把 `null` 当作可信身份。Magpie 沙盒页面的 `Origin:null` API 请求仍需令牌。管理 API 不接受外部上游、凭据 URL 或自端口；fetch 不跟随上游重定向。推理上传、等待、流式回复与模型目录请求共用并发预算，上传前即占位。请求 16MiB、非流式响应/模型目录 32MiB、SSE 单事件 1MiB、序言 256KiB。

Magpie key 原样转发至本机网关，不将共享/受限 key 升级为其他身份。页面无认证 cookie、无 localStorage、无外部依赖。CSP 为文件脚本和精确本地连接来源。服务重启/关闭不存任务体，只保存聚合观测。

## 官方入口来源

- [服务页面描述与端口解析](https://github.com/yetone/magpie/blob/cd89ccdb4003847e26716be99f70f98dec1ca6a3/internal/plugin/page.go)
- [服务跨 Magpie web 的转发](https://github.com/yetone/magpie/blob/cd89ccdb4003847e26716be99f70f98dec1ca6a3/internal/gui/pageservice.go)
- [页面 bridge](https://github.com/yetone/magpie/blob/cd89ccdb4003847e26716be99f70f98dec1ca6a3/internal/gui/pagebridge.js)
- [中间件的请求局部上下文](https://github.com/yetone/magpie/blob/cd89ccdb4003847e26716be99f70f98dec1ca6a3/internal/middleware/run.go)
- [Gemini URL 模型与原生入口](https://github.com/yetone/magpie/blob/cd89ccdb4003847e26716be99f70f98dec1ca6a3/internal/gateway/gateway.go#L2441-L2490)
