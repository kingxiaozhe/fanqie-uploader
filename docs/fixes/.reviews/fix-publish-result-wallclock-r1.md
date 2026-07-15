# 审查凭证：fix-publish-result-wallclock 第 1 轮

- 审查方式：AI 自审（Codex CLI 未安装，按 N4 降级链执行）
- 审查对象：publisher.js waitForPublishResult 墙钟化 diff
- 结论：**通过**（0 阻断项，4 个已核实的等价性确认）

## 重点核查项

1. **根因是否修掉**：waitForPublishResult 是僵尸页根因（tick 计数超时 × Chrome 隐藏标签页
   节流）的最后一处残留实例，且比 submitAndConfirm 更危险——期间反复重点的是「确认发布」
   提交按钮。墙钟化后节流场景第二个 tick（≤2 分钟）即达 32s 预算收口。修复后全文件已无
   计数型超时（submitAndConfirm 的 n%4 仅是点击节奏，其生命期已被墙钟超时约束）✓
2. **预算等价**：40 tick × 800ms = 32s → PUBLISH_RESULT_TIMEOUT_MS = 32000，行为预算不变 ✓
3. **重点节奏等价**：原 `n>4 && n%5===0`（首次 4s、之后每 4s）→ `elapsedMs>4000 &&
   nowMs-lastReclickMs>=4000`，正常 tick 频率下节奏一致；节流下墙钟版不会积压连点
  （lastReclickMs 按真实时间限流），比原实现更安全 ✓
4. **成功判定的持续期等价**：`dialogClosed && !anyModalVisible && n>=4`（≈3.2s）→
   `elapsedMs>=3200`。语义都是"确认发布后至少观察 3.2s 无任何弹窗才判成功"，防止
   "发布弹窗关→二次确认弹出"空档误判的原注释意图保留 ✓
5. **重复提交风险**：-1010 防线不变（单次 realClick + 接口权威结果优先短路）；netPublishResult
   命中时最先 return，重点逻辑根本不会执行 ✓
6. **防护网形态**：浏览器节流无法在 node 沙箱复现（同 fix-zombie-publish-tab 先例）；
   存量 70 条基线无退化，墙钟算式直读核验。
