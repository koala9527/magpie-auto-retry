# Contributing

谢谢参与 Magpie Auto Retry。

## 开发

Node.js 22+、npm 10.9.8。运行时保持零依赖；仅浏览器测试使用锁定版本的 Playwright。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:coverage
npx playwright install chromium
npm run test:browser
```

重试行为先补失败用例，再修改逻辑。集成测试使用本机假上游与独立临时数据目录，不使用个人 Magpie 登录/Agent 配置。UI 显示实际空态，不硬编码漂亮的示例统计。测试不得跳过，覆盖率门槛见 CONSTRAINTS.md。

## 提交与 PR

- 从 main 创建短期分支；一个提交处理一个独立变化，使用 `feat:` / `fix:` / `docs:` / `test:` 等前缀。
- PR 说明动机、涉及的协议/行为、验证命令与结果；UI 改动附桌面和移动截图。
- 公开 API、统计口径和默认值的变化同时更新 docs/ 与两个 README。
- 不提交 .env、密钥、对话、真实提供商错误日志、运行状态、浏览器产物或 node_modules。
- 新增运行时依赖前说明标准库为什么不足；不得使用 eval 或把不可信数据插入 innerHTML。

## Magpie 宿主验证

在隔离 HOME、XDG_CONFIG_HOME、XDG_CACHE_HOME（Windows 同时隔离 USERPROFILE）和独立 MAGPIE_ADDR 中添加本地包，再验证页面服务及中间件。不要用个人配置进行测试。

发现问题请提供版本、协议、脱敏复现步骤、期望/实际行为及聚合统计，不提供提示词或 API key。
