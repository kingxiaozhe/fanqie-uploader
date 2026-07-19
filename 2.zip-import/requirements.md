# ZIP 一键导入 — 需求规格

## 概述

支持选择 / 拖入 `.zip` 压缩包，零依赖自动解压其中的 `.txt/.md` 章节文件，与「选文件夹」等价接入现有解析流水线。仅支持「一文件一章」的多文件 zip，不做单文件整本切章。

## 项目信息

- 项目名: fanqie-uploader
- 架构类型: Chrome MV3 浏览器扩展（零依赖，无构建；改动集中在 popup 层）

## 需求版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-19 | v1 | 初始需求（对标竞品「番茄小说注入神器」ZIP 一键解压导入） |

## 用户故事

- 作为拿到打包好 zip 稿件的作者，我想要直接拖 zip 进来一键导入，以便省去「先解压到文件夹再选」这一步。

## 功能需求

1. [F-001] popup 新增 ZIP 导入入口：可选择 `.zip` 文件（与现有「选文件夹」并存，不互相破坏）。
2. [F-002] 零依赖解析 ZIP：手写解析中央目录，STORED（method 0）直取、DEFLATE（method 8）走原生 `DecompressionStream('deflate-raw')` 解压。
3. [F-003] 仅收 `.txt/.md/.markdown`，忽略目录项、`__MACOSX/`、隐藏文件与其它类型。
4. [F-004] 每个条目字节复用 feature 1 的 `decodeChapterBytes` 解码（兼容 GBK 文件名与 GBK 正文），再汇入现有 files 流水线（排序、splitTitleBody、章号解析等一律复用）。
5. [F-005] 书名（folderName）取 zip 文件名去扩展名。
6. [F-006] 不支持/损坏的 zip（加密、分卷、zip64、非法结构）给友好报错，不崩溃、不影响已加载内容。

## 非功能需求

- 性能: 解压/解码在内存进行；大 zip 期间 popup 显示「读取中…」（复用现有按钮文案）。
- 安全: 不新增任何 manifest 权限；zip 仅在浏览器内存解压，不落盘、不上传。
- 兼容性: 仅用浏览器原生 API（DecompressionStream / Response / TextDecoder），零第三方依赖。

## 验收标准

- [ ] [AC-001] 含 9 个 `.txt`（STORED 与 DEFLATE 各覆盖）的 zip，导入后 9 章齐、按章号排序、标题/正文正确。
- [ ] [AC-002] zip 内混有非章节文件（封面.jpg、readme）与子目录 → 正确忽略，只收章节。
- [ ] [AC-003] zip 内为 GBK 编码 txt 且文件名为 GBK → 正文与文件名均不乱码。
- [ ] [AC-004] 非法/损坏/加密 zip → 友好报错提示，不崩溃、不清空已加载内容。
- [ ] [AC-005] 现有「选文件夹」入口行为无回归；`bash tests/run.sh` 全绿。

## 依赖

- Feature `1.chapter-encoding-detect`（复用 `decodeChapterBytes`）——**必须先完成**。
- 浏览器原生 `DecompressionStream('deflate-raw')`、`Response`、`TextDecoder`。无外部库。

## 开放问题

- 已决（本期不做）：单文件整本 txt 靠「第N章」分隔的自动切章——另开需求。
- 已决（本期不做）：rar/7z（需重型依赖，违背零依赖红线）。
- 待定：拖拽导入（拖 zip 到 popup）作为 P2 增强，可与本 feature 同批做或后补。
