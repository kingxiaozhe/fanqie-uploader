# LESSONS — 架构决策与踩坑（cm:ai）

## 待触发备忘

- [挂起] 用户反馈 GBK 恰为合法 UTF-8 的误判真实发生 → 再考虑「导入后首章预览」让用户肉眼确认编码（来源 1.chapter-encoding-detect，PRD Q1 本期不做）

## 2026-07-19 — 1.chapter-encoding-detect / 编码探测

- [已结构化] 编码探测用「UTF-8 fatal 严格解码试探，抛错则回退 GBK」+ BOM 优先，仅原生 TextDecoder，零依赖。已知边界：恰为合法 UTF-8 的 GBK 字节（如 `C2 A1`）会被判 UTF-8——真实整章 GBK 稿几乎不可能全程合法 UTF-8，不改算法；已用 `C2 A1 → ¡` 测试锁定该已知行为，防「GBK 永远兜底成功」的安慰剂。（Codex r1 采纳其测试批评）

## 2026-07-19 — 2.zip-import / 测试可测性（规格期对抗审查预置，开发前必读）

- [已结构化-in-specs] `tests/logic.test.cjs` 抽取器按 `function name(` 切片会**丢弃 `async` 关键字**，抽出的 async 体 `eval` 抛 SyntaxError，且顶层 eval 无 try/catch → **打爆现存全部用例**。故 ZIP 可测面只放**同步**函数（readEOCD/readCentralDir/sliceEntryData），parseZip/inflate/onZipPicked（async）不进抽取清单。报错文案不得含裸 `{`/`}`（抽取器裸计花括号）。已写入 2.zip-import/design.md「可测性切分」与 tasks。
