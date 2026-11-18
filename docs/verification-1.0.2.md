# 1.0.2 验证记录

日期：2026-11-18。对照版本：1.0.1。

## 改了什么

- **默认本地转发**：启动时自动检测 Magpie 管理的本机 Codex 配置（读取 `codex-portable.json` 与 `config.toml`），自动安全替换 `base_url` 至重试插件端口（3430）。非受管配置、符号链接或格式未识别配置保持原样，安全退避。
- **页面与说明精简**：移除页面中“接入方式”标签页及手动配置输入框，替换为“运行信息”面板展示本地转发状态（已设置/重开生效/未受管/已关闭等）。无流量时提示重启 Codex 进程。
- **重试策略合理化与防封号加固**：
  - 内容安全过滤（`content_filter`、`SAFETY`、`PROHIBITED_CONTENT`）判定为非临时故障，立即终止并不再重发，避免反复撞击提供商安全风控导致账号封禁（封号）。
  - 协议不匹配（如模型要求 Responses 工具格式而账号仅支持 Chat Completions）判定为永久故障，立即返回。
  - `protocolError` 对安全拦截与协议错误返回 `invalid_request_error` 协议载荷。
- **文档通俗化与去冗余**：移除 README 中“停用和回退”章节，去 AI 腔调，简化语言，说明为什么之前无数据反应（Codex 原配置绕过插件直连 3425 网关）及如何重启生效。

## 本地检查

环境：Windows，Node.js 22.23.2，Chromium / Playwright。

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 语法、清单入口检查通过；零运行时依赖 |
| `npm test` | 67 通过，0 失败 |
| `npm run test:coverage` | 67 通过；行 98.36%、分支 88.27%、函数 91.87% |
| `npm run test:browser` | 35 项页面契约测试 + 3 项真实服务浏览器测试通过 |
| `npm audit --audit-level=high` | 0 vulnerabilities |

测试覆盖本地转发配置写入与跳过、安全拒答与协议不匹配终止、无流量提示、本地转发状态展示及浏览器端回归测试。

## 发布资产

发布资产见 [v1.0.2](https://github.com/koala9527/magpie-auto-retry/releases/tag/v1.0.2)。[1.0.1 验证记录](verification-1.0.1.md)与 [1.0.0 验证记录](verification.md)仍保留。
