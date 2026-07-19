# 章节文件编码自适应 — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-19 | v1 | 初始设计 |

## 项目架构

- 架构类型: Chrome MV3 扩展，无模块系统、零依赖、无构建。
- 涉及层: 仅 popup（选文件夹、解析章节是 popup 职责；content/background 不涉及）。
- 设计基准: 无（本 feature 不改可见 UI，沿用现有 popup 原生 DOM，不建 design-baseline）。

## 波及面（B2）

| 改动点 | 位置 | 调用方 | 可能受影响的老功能 |
| ---- | ---- | ---- | ---- |
| `f.text()` → `f.arrayBuffer()` + `decodeChapterBytes` | `popup/popup.js` `onFolderPicked`（约 272 行，唯一读文件处） | 仅 `onFolderPicked`（用户点「选文件夹」触发） | 章节解析（splitTitleBody/numFromName/numFromText）——输入仍是 string，接口不变，理论零回归；真实风险在「编码误判导致正文错误」 |

- 下游 `splitTitleBody`、`numFromName`、`numFromText`、排序、去重、发布/排期链路**全部不改**。
- 不碰 content/*、background.js、manifest.json 权限段。

## 功能模块设计

### 模块 1: 编码探测解码 `decodeChapterBytes(buf)`（新增纯函数，popup.js）

输入 `ArrayBuffer`，输出解码后的 `string`。步骤：

1. 取前若干字节判 BOM：
   - `EF BB BF` → 去 BOM，`TextDecoder('utf-8')` 解码剩余。
   - `FF FE` → `TextDecoder('utf-16le')`；`FE FF` → `TextDecoder('utf-16be')`。
2. 无 BOM：先 `new TextDecoder('utf-8', { fatal: true }).decode(buf)`。
   - 不抛错 → 采信 UTF-8（覆盖纯 ASCII、UTF-8 中文等绝大多数）。
   - 抛 `TypeError`（存在非法 UTF-8 序列）→ 回退 `new TextDecoder('gbk').decode(buf)`（Chrome 的 gbk 标签映射 GB18030 解码器，覆盖 GB2312/GBK）。
3. 返回文本（换行归一化 `\r\n → \n` 与 `.trim()` 保留在调用处，与现状一致）。

> 函数 ≤40 行；BOM 判定若过长则内部拆 `sniffBom(bytes)` 子函数。为可被 logic.test.cjs 抽取，必须是**顶层 `function decodeChapterBytes(...)` 声明**（非箭头/方法简写）。

### 模块 2: 接入 `onFolderPicked`（改存量，popup.js）

- 将 `const raw = (await f.text()).replace(/\r\n/g,"\n").trim();`
  改为 `const raw = decodeChapterBytes(await f.arrayBuffer()).replace(/\r\n/g,"\n").trim();`
- 其余逻辑（章号解析、排序、task 组装）一字不动。

## 接口契约

```js
// popup.js 顶层新增
function decodeChapterBytes(buf /* ArrayBuffer */) -> string
// 可选内部子函数
function sniffBom(bytes /* Uint8Array */) -> { encoding, offset } | null
```

## 数据模型

无变化。task 对象结构（`{ id, fileName, title, chapterNumber, content, wordCount, selected }`）不变。

## 安全考虑

- 基于 rules/security.md：零第三方依赖（只用原生 TextDecoder）；不新增权限；数据不出浏览器内存。
- 日志不输出正文全文（沿用现有约定）。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 编码探测方式 | UTF-8 `fatal` 严格解码试探 vs 字节频率统计 | 前者零依赖、实现简单、误判率低；后者复杂且无必要 |
| GBK 解码器 | 原生 `TextDecoder('gbk')` vs 引入 iconv | 原生零依赖，守住安全红线 |
| 换行/trim 归一 | 留在调用处 vs 进解码函数 | 留在调用处，保持 decodeChapterBytes 纯粹「字节→文本」，与现状 diff 最小 |
