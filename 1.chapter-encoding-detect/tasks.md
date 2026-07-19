# 章节文件编码自适应 — 任务清单

## 任务版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-19 | v1 | 初始任务 |

## 项目信息

- 项目名: fanqie-uploader
- 架构类型: Chrome MV3 扩展（零依赖）
- specs 路径: 1.chapter-encoding-detect/

## 任务列表

### 防护网基线（B3，修改存量模块的第一任务）

- [x] T-001: 跑通存量 `bash tests/run.sh` 并记录基线（当前 74/74）——本 feature 改 popup 解析，开发后复跑，变红即碰坏老行为 ~5min

### 功能 1: 编码探测解码

- [x] T-002: 在 `popup/popup.js` 顶层新增纯函数 `decodeChapterBytes(buf)`（BOM 判定 + UTF-8 fatal 严格解码 + GBK 兜底 + UTF-16LE/BE），≤40 行，顶层具名声明以便测试抽取 ~30min
- [x] T-003: 接入 `onFolderPicked`：`f.text()` → `decodeChapterBytes(await f.arrayBuffer())`，其余解析链路不动 ~15min

### 集成与测试

- [x] T-004: `tests/logic.test.cjs` 新增 `decodeChapterBytes` 回归用例——喂「你好世界」的 UTF-8 / GBK / UTF-8+BOM / UTF-16LE 字节序列断言均解回原文；边界：纯 ASCII、中英混排、合法 UTF-8 不误判为 GBK ~30min
- [ ] T-005: 文档与版本同步——README/FEATURES 导入章节补「自动识别 UTF-8/GBK/UTF-16 编码」；`manifest.json` 1.8.1 → 1.8.2（单独提交）；复跑 T-001 基线确认全绿 ~15min

## 依赖关系

- T-002 → T-003（接入依赖函数就绪）
- T-003 → T-004（用例针对最终实现）
- T-001 在最前；T-005 在最后并复跑 T-001

## 风险点

- 编码误判（GBK 恰为合法 UTF-8）：靠 `fatal:true` 严格模式拦截，用例覆盖边界；残余风险记入 requirements 开放问题（Q1 预览为后续兜底）。
- `TextDecoder('gbk')` 在测试环境（Node）可用性：Node 18+ 支持；若个别环境不支持，按 run.sh 对 playwright 的惯例跳过并记原因。
