---
description: MV3 扩展前端约定：消息协议、注入页面 DOM 操作、storage、UI 惯例
globs: "popup/**, sidepanel/**, content/**, background.js"
---

# 前端规范（MV3 扩展）

## 架构分层（职责不越界）

- `popup/` 只管：选文件夹、解析章节、设置读写、启动会话——不直接操作番茄页面
- `background.js` 只做消息总线与标签页/通知管理——不含业务逻辑
- `content/uploader.js` 是唯一调度者（串行、看门狗、重试）；`content/publisher.js` 只执行单章填表发布
- `sidepanel/` 纯展示 + 用户控制（停止/重发），数据来自消息与 storage

## 消息协议

- 跨脚本通信一律 `chrome.runtime.sendMessage` / `onMessage`，消息类型 UPPER_SNAKE 常量
- 新增消息类型：发送方、接收方、README 架构图三处同步
- 异步 sendResponse 必须 `return true` 保持通道开启（现有代码已有正例）

## 番茄页面 DOM 操作（本项目最脆弱层）

- 所有选择器进 `publisher.js` 顶部 `SEL` / uploader 对应常量区，并更新 popup「选择器自检」覆盖清单
- React 受控输入：设值后必须派发 `input` 事件；ProseMirror 正文按段落插入 `<p>`
- Arco 日期/时间选择：只能模拟点击日历/时间面板，直接写 value 无效
- 所有页面等待用轮询 + 超时兜底，禁止无限等待；单章有 5 分钟看门狗保底

## 状态与数据

- 持久化一律 `chrome.storage.local`，键加 `fq_` 前缀；设置读写走 popup 现有的记忆机制
- 多本书配置按 `bookId` 隔离，取不到 bookId 回退全局设置（向后兼容，不得破坏）
- 会话状态（session）由 uploader.js 持有，popup/sidepanel 只读镜像

## UI 惯例

- 无框架、无构建：popup/sidepanel 用原生 DOM API + 内联 `<style>`；不引入组件库
- 支持暗色模式（沿用现有 CSS 变量/媒体查询做法）
- 用户可见文案走 `_locales`（`__MSG_xxx__` / `chrome.i18n`）者保持双语同步；popup 内联中文文案是现状，新增文案对齐现状即可，不强制迁移
