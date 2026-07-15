---
description: 扩展安全红线：最小权限、本地存储、无远程代码、合规使用
---

# 安全规范

## 权限最小化（MV3 红线）

- `manifest.json` 权限保持现状：`storage / tabs / notifications / sidePanel`；`host_permissions` 仅 `https://fanqienovel.com/*`
- **新增任何 permission / host_permission / content_script 注入范围 = 契约变更**，必须在 PR/提交说明里单独声明理由，并同步更新 `PRIVACY.md`
- content script 注入 `world: "MAIN"` 仅限 `net-hook.js` 既有用途，不得扩大

## 数据与隐私

- 用户数据（章节内容、设置、敏感词词库）只存 `chrome.storage.local`，**禁止上传到任何外部服务器**——这是 PRIVACY.md 的对外承诺
- 日志（console）不得输出章节正文全文与用户词库内容；输出标题/章节号用于排障可以
- 导出功能（CSV 报告）只写本地下载，不经网络

## 代码红线

- 禁止远程加载/执行代码（MV3 商店审核红线）：no `eval`、no `new Function` 于生产路径、no 远程 script 注入
- 禁止硬编码任何账号、cookie、token；登录态完全依赖用户在番茄页面的会话，扩展不读写凭据
- 不引入第三方运行时依赖（零依赖是本项目的安全边界与卖点）

## 合规使用

- 工具定位为**模拟用户手动操作**：串行发布、操作节奏延迟、发布量上限等反风控节奏机制是产品与合规约束，代码变更不得绕过或默认关闭
- 仅供学习与个人合规使用；涉及绕过平台风控检测的"能力增强"需求一律先人工确认，不默认实现
