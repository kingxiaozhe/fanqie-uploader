# ZIP 一键导入 — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-19 | v1 | 初始设计 |

## 项目架构

- 架构类型: Chrome MV3 扩展，无模块系统、零依赖、无构建。
- 涉及层: 仅 popup。
- 设计基准: 无（新增入口沿用现有 popup 原生 DOM 风格；两者皆无设计稿 → 不建 design-baseline、不生成 UI 还原任务）。

## 波及面（B2）

| 改动点 | 位置 | 调用方 | 可能受影响的老功能 |
| ---- | ---- | ---- | ---- |
| 新增 ZIP 入口元素 | `popup/popup.html`（在现有「选文件夹」旁加入口） | 用户点击 | 无（新增独立元素，不改现有 input） |
| `onFolderPicked` 分流 / 新增 zip 处理路径 | `popup/popup.js` | 现有「选文件夹」change 事件 | 需保证选文件夹分支逻辑不被 zip 分支破坏 |
| 复用 `decodeChapterBytes` | popup.js（feature 1 产物） | zip 与文件夹两条路径 | 依赖 feature 1 已合入 |

- 汇入点是现有 files 流水线（排序、去重、task 组装、发布/排期）——**全部不改**，zip 只是多一个「产出 files 数组」的来源。
- 不碰 content/*、background.js、manifest.json 权限段。

## 功能模块设计

### 模块 1: ZIP 导入入口（popup.html + popup.js）

- popup.html：现有 `<input webkitdirectory>` 旁新增 `<input type="file" id="zip" accept=".zip" hidden>` + 触发按钮（复用现有按钮样式）。
- popup.js：绑定 change → `onZipPicked(e)`；沿用「读取中…」按钮态。
- 「选文件夹」与「选 ZIP」两入口并存、互不干扰。

### 模块 2: 零依赖 ZIP 解析 `parseZip(buf)`（新增，popup.js）

输入 `ArrayBuffer`，输出 `[{ name, bytes /* Uint8Array */ }]`。`parseZip` 因需 await DEFLATE 解压故为 **async**，**不进 logic.test.cjs 抽取清单**（见下「可测性切分」）。手写，内部拆子函数（守 40 行/函数）：

- `readEOCD(dv)`（**同步·可测**）：从尾部倒扫签名 `50 4B 05 06`（EOCD）。倒扫范围须覆盖 `22 + 65535` 字节（尾部可跟最长 65535 的归档注释）；取**最后一个**匹配，并用 EOCD 的 comment-length 与 cdOffset 做合法性校验后再采信（防数据/注释里偶然出现签名的误命中）。取中央目录偏移与条目数。找不到/校验不过 → 抛错。
- `readCentralDir(dv, eocd)`（**同步·可测**）：遍历中央目录条目（签名 `50 4B 01 02`），每条取：文件名字节、压缩方法、**压缩大小（真值只信中央目录）**、local header 偏移、GP 标志位。加密位（bit0）置位 → 抛「不支持加密 ZIP」。
- `sliceEntryData(dv, entry)`（**同步·可测**）：定位 local header（签名 `50 4B 03 04`），**数据起始偏移用 local header 自己的 name-length / extra-length 字段计算**（local 的 extra 长度常与中央目录不同，经典坑）；**切片长度用中央目录的 compressed size**（应对 GP bit3 流式写入时 local header 的 size/CRC 全为 0、真值在数据后 data descriptor 的情况——直接用中央目录值即可绕过 data descriptor）。返回 `{ method, slice /* Uint8Array */ }`；zip64 标记 / 未知 method → 抛「不支持的压缩方式」。
- `inflate(slice, method)`（**异步·不可测抽取**）：method 0（STORED）→ 直接返回 slice；method 8（DEFLATE）→ `new Response(new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()`。
- 文件名解码走 `decodeChapterBytes`（兼容 UTF-8 标志位与 GBK 文件名）。
- ⚠️ 所有抛错文案**不得含裸 `{` / `}`**（logic.test.cjs 抽取器按裸花括号计深度，字符串里的落单花括号会截断抽取、`eval` SyntaxError 打爆整套）。

#### 可测性切分（应对测试抽取器约束 —— 关键）

`tests/logic.test.cjs` 抽取器按 `function name(` 定位并从 `function` 起切片，会**丢弃 `async` 关键字**，抽出的 async 体内 `await` 在 `eval` 时抛 `SyntaxError`，且该 eval 在模块顶层无 try/catch → **现存 74 条用例一条都跑不了**。因此：

- **可进 logic.test.cjs 抽取的只有纯同步函数**：`readEOCD` / `readCentralDir` / `sliceEntryData`（做字节级偏移与切片断言）。
- **async 函数不进抽取清单**：`parseZip` / `inflate` / `onZipPicked`。它们的端到端解压走 playwright 或人工验证，不在零依赖沙箱里断言。

### 模块 3: 汇入流水线 `onZipPicked`（popup.js）

1. `parseZip(await file.arrayBuffer())`（try/catch，失败 → 友好报错、保留现有内容）。
2. 过滤：仅留 `.txt/.md/.markdown`；剔除以 `/` 结尾的目录项、`__MACOSX/`、`.` 开头隐藏文件。
3. 每项 `decodeChapterBytes(bytes)` → 组装成与文件夹路径等价的 `{ name, raw }`，走**现有** splitTitleBody / numFromName / numFromText / 排序 / task 组装。
4. `folderName` = zip 文件名去 `.zip`。

## 接口契约

```js
// 同步·可进 logic.test.cjs 抽取
function readEOCD(dv /* DataView */) -> { cdOffset, cdCount } | throw
function readCentralDir(dv, eocd) -> Array<entryMeta>        // entryMeta: { nameBytes, method, compressedSize, localOffset, flags }
function sliceEntryData(dv, entry) -> { method, slice: Uint8Array } | throw
// 异步·不进抽取清单（端到端走 playwright/人工）
async function inflate(slice /* Uint8Array */, method /* number */) -> Uint8Array
async function parseZip(buf /* ArrayBuffer */) -> Array<{ name: string, bytes: Uint8Array }>
async function onZipPicked(e /* Event */) -> void
```

## 数据模型

无变化。最终仍产出现有 task 对象数组，进度面板/CSV/发布链路口径一致。

## 安全考虑

- rules/security.md：零第三方依赖（DEFLATE 用原生 DecompressionStream，不引 jszip）；不新增权限；zip 仅内存解压。
- 明确不支持：加密、分卷、zip64——给报错而非静默错解，避免脏数据混入发布。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| ZIP 解压 | 原生 `DecompressionStream('deflate-raw')` + 手写目录解析 vs 引入 jszip | 前者守零依赖红线、无供应链风险，代价是手写 ~120 行；后者违背卖点 |
| 支持范围 | 单卷/未加密/method 0,8 vs 全 ZIP 规范 | 覆盖真实作者稿件的绝大多数；其余明确报错，复杂度与体积可控 |
| 入口形态 | 独立 `<input accept=".zip">` vs 复用 webkitdirectory input | webkitdirectory input 只能选目录，必须独立入口；拖拽作为 P2 |
| 单文件切章 | 不做 | 用户已确认本期仅多文件；切章另开需求 |
