# 小缺陷两则：日志无日期（跨天倒流）+ 发布页 uploader 提示噪音

- 日期：2026-07-15　状态：已修复

## ① 导出日志时间戳缺日期 `快速通道`

- 现象：日志只有 `HH:MM:SS`，跨天后时间"倒流"（23:40:49 → 23:07:28），排查困难。
- 根因：sidepanel.js 导出 `fmt()` 只格式化时分秒；存储条目本有毫秒级 `t`，纯展示层丢失。
- 修法：`fmt` 增加 `MM-DD` 前缀 → `07-10 22:40:21`。单文件 1 行、无分支变化、旧数据兼容。
- 前后对照：`22:40:21 [uploader] …` → `07-10 22:40:21 [uploader] …`

## ② 发布页里 uploader 反复刷「请进入章节管理页面」

- 现象：发布进行中运行日志不断出现 `[uploader] 📚 请进入你要上传的小说『章节管理』页面`。
- 根因：manifest 对 `writer/*` 全量注入 uploader.js，发布页也有一个 uploader 实例；
  SPA MutationObserver 反复触发 `detectAndAct()`，URL 不匹配章节管理页就 `setIndicator`
  该提示，而 setIndicator 每次都写运行日志。
- 修法：detectAndAct 开头对发布页 URL（`/\/publish(\/|\?|$)/`）直接静默返回——发布页归
  publisher 管。消息监听（GET_PUBLISHED 等）不在 detectAndAct 内，不受影响。
- 注：新增了条件分支，不满足 fix-lite 门槛，按完整流程执行（波及面核查见审查凭证）。

## 回归

- 53/53 通过；`bash tests/run.sh` 通过（UI 测试环境无 playwright 自动跳过）。

## 审查

- docs/fixes/.reviews/fix-log-date-uploader-noise-r1.md（AI 自审，Codex 未装降级，通过）
