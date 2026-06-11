# 番茄小说批量上传器（MV3 脚手架）

纯手写的 Chrome Manifest V3 扩展脚手架：选择本地章节文件夹，自动批量发布到
番茄小说作者后台（fanqienovel.com）。不依赖任何打包框架，加载即用，便于学习和二次开发。

## 架构

```
popup (选文件夹/勾选/开始)
   │ chrome.storage.local + sendMessage
   ▼
background.js  ← 消息总线 + 开/关标签页 + 通知
   │ OPEN_PUBLISH_TAB / FILL_CHAPTER          ▲ TASK_DONE
   ▼                                          │
content/publisher.js (发布页)   ──TASK_DONE──▶ content/uploader.js (章节管理页)
   填标题/正文/发布/处理弹窗                      找入口 + 串行调度
```

- **popup/** — 选本地文件夹，解析 `.txt` 为章节任务，勾选后启动上传。
- **background.js** — 后台 Service Worker，负责开发布标签页、转发完成信号、关标签页。
- **content/uploader.js** — 注入"章节管理页"，按顺序逐章触发发布（串行，避免风控）。
- **content/publisher.js** — 注入"发布页"，把章节号/标题/正文填进编辑器并点发布。

## 安装运行

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本文件夹
4. 点扩展图标 → 选择章节文件夹 → 勾选 → 开始上传
5. 在弹出的番茄后台**登录**，进入你的小说**『章节管理』**页面，上传会自动开始

## 章节文件约定

- 一个 `.txt` = 一章；文件名建议含章节号（如 `第1章.txt`、`001.txt`）
- 章节号解析顺序：文件名 → 正文首部 `第N章`
- 标题：正文首行（≤40字）优先，否则用文件名

## ⚠️ 重要说明

- 本工具靠**模拟网页操作**实现，番茄前端改版（DOM 结构变化）后，
  `content/publisher.js` 与 `content/uploader.js` 里的 **CSS 选择器需要对照实际页面调整**。
- 番茄使用 React + Arco Design + ProseMirror。代码中已处理"受控组件需派发 input 事件"
  和"富文本按段落塞 `<p>`"两个关键点，但具体类名以番茄当前页面为准。
- 仅供学习与个人合规使用；请遵守番茄小说的用户协议与平台规则。

## 待办 / 可扩展

- [ ] 定时发布（`publisher.js` 的 `setPublishOption` 已留 TODO）
- [ ] 已发布章节状态同步（抓取章节管理页表格，标记"已上传"，避免重复）
- [ ] 失败自动重试
- [ ] 图标资源（`icon.png`）
- [ ] 设置页（每日章数 / 发布间隔 / 主题）
