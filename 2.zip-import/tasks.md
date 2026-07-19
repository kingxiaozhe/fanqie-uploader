# ZIP 一键导入 — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-19 | v1 | 初始任务 |

## 项目信息

- 项目名: fanqie-uploader
- 架构类型: Chrome MV3 扩展（零依赖）
- specs 路径: 2.zip-import/
- 前置: feature `1.chapter-encoding-detect` 已合入（复用 decodeChapterBytes）

## 任务列表

### 防护网基线（B3，修改存量模块的第一任务）

- [x] T-001: 跑通存量 `bash tests/run.sh` 记录基线（含 feature 1 后的用例数），开发后复跑防回归 ~5min

### 功能 1: ZIP 入口

- [x] T-002: 仅 `popup/popup.html` 新增 `<input type="file" accept=".zip" hidden>` + 触发按钮（复用现有样式，可独立验收：点按钮弹出文件选择框）。change 绑定与 `onZipPicked` 实现挪到 T-005，避免绑定未定义函数无法自证（评审 B5） ~15min

### 功能 2: 零依赖 ZIP 解析（同步部分可测，异步部分不进抽取）

- [x] T-003: 实现同步 `readEOCD`（倒扫覆盖 22+65535、取最后匹配 + comment-length 校验）+ `readCentralDir`（压缩大小只信中央目录、加密位/zip64 判错），顶层具名 function 以便抽取；抛错文案不含裸花括号（评审 B4/B8） ~40min
- [x] T-004: 实现同步 `sliceEntryData`（数据起点用 local header 自己的 name/extra 长度、切片长度用中央目录 compressed size，绕过 GP bit3 data descriptor）+ 异步 `inflate`（STORED 直取 / DEFLATE 走 `DecompressionStream('deflate-raw')`）（评审 B1/B2） ~30min

### 功能 3: 汇入流水线

- [x] T-005: 异步 `parseZip`（串起解析+inflate）+ `onZipPicked`（try/catch 友好报错、过滤目录/`__MACOSX/`/隐藏/非章节、每项走 `decodeChapterBytes` 汇入现有 files 流水线、folderName 取 zip 名）；并在 T-002 入口上绑定 change → onZipPicked ~30min

### 集成与测试

- [x] T-006: `tests/logic.test.cjs` 对**三个同步函数** `readEOCD`/`readCentralDir`/`sliceEntryData` 做字节级断言（内置最小 STORED zip 与一个 bit3 流式 zip 的字节常量，断言偏移/切片长度/条目名正确）。**如实记录**：DEFLATE 端到端解压依赖 async + DecompressionStream，不在本零依赖沙箱覆盖，须走 playwright 或人工（评审 B1/B7）。`parseZip`/`inflate`/`onZipPicked` 不加入抽取清单 ~40min
- [x] T-007: 损坏/加密/分卷/zip64/带注释 zip 友好报错核对（AC-004 + 评审 B4）；文档同步 README/FEATURES 补「ZIP 一键导入」；`manifest.json` 1.8.2 → 1.9.0（单独提交）；复跑 T-001 基线 ~20min

## 依赖关系

- T-002 → T-005（入口就绪才接汇入）
- T-003 → T-004 → T-005（解析链自底向上）
- T-005 → T-006（用例针对最终汇入）
- T-001 最前；T-007 最后并复跑 T-001
- 整个 feature 依赖 `1.chapter-encoding-detect` 完成

## 风险点

- 手写 ZIP 解析边界多（变长字段偏移、data descriptor、GP bit3 流式标记）：用例覆盖 STORED/DEFLATE/含目录/非章节混入；不支持项一律报错不静默错解。
- `DecompressionStream` 在测试环境可用性：Node 18+ 支持；不支持则该异步用例跳过记原因，STORED 分支仍同步可测。
- 与 feature 1 的耦合：decodeChapterBytes 未合入则本 feature 无法开发——依赖关系已在前置声明。
