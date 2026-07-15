---
description: 原生 JS 扩展的编码风格：文件头注释、双引号分号、集中常量、中文注释
---

# 编码风格

## 量化标准

| 项 | 上限 |
| ---- | ---- |
| 函数长度 | 40 行（现存 publisher.js 巨型轮询函数是待重构负债，不是许可） |
| 文件长度 | 800 行（无模块系统，单文件承载一个注入点；超限优先抽函数而非拆文件） |
| 嵌套深度 | 3 层 |
| 函数参数 | 5 个（超过改传对象） |

## 命名

- 文件命名：kebab-case 小写（`net-hook.js`、`popup-ui.test.cjs`）
- 变量/函数：camelCase（`awaitingTaskId`、`computePublishTime()`、`scanSensitive()`）
- 常量：UPPER_SNAKE（`CHAPTER_TIMEOUT`、`WORDS_KEY`）；魔法数字一律提为具名常量并注释单位
- 消息类型：UPPER_SNAKE 字符串（`TASK_DONE`、`OPEN_PUBLISH_TAB`、`FILL_CHAPTER`），跨文件收发必须逐字一致
- chrome.storage 键：`fq_` 前缀（`fq_sensitive_words`）

## 文件组织

- 无模块系统（content script 不能用 import）：每个注入文件用 IIFE `(function () { "use strict"; ... })()` 包裹，禁止污染页面全局
- 每个文件顶部保留 banner 注释块：`// ==== 路径 — 职责说明 ====`，列出该文件核心职责
- DOM 选择器集中在文件顶部常量（publisher.js 的 `SEL`），禁止散落在逻辑中间裸写选择器
- 时延数值集中为常量（TIMINGS 风格），禁止行内裸写 `setTimeout(fn, 700)`

## 格式

- 缩进 2 空格；字符串双引号；语句带分号（与现有代码一致，无 lint 配置，靠自觉对齐）

## 注释

- 注释用中文，解释"为什么"与业务背景（风控、番茄页面行为），不复述代码
- 行尾注释标注状态变量语义（如 `let busy = false; // 防重入`）

## Bad / Good 示例

```js
// Bad: 选择器和延时散落在逻辑里，番茄改版后没法排查
await sleep(700);
document.querySelector(".arco-btn-primary").click();

// Good: 选择器进 SEL、延时进常量，改版只改顶部
await sleep(TIMINGS.confirmGap);
clickEl(SEL.publishConfirmBtn);
```
