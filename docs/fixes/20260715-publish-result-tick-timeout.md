# waitForPublishResult tick 计数超时：节流下 32s 预算变 40 分钟且反复重点「确认发布」

- 日期：2026-07-15　状态：已修复
- 修前证据：代码审读（质量评审 P1 项）+ 同根因已实证的僵尸页档案
  （20260715-zombie-publish-tab.md，日志 4 分钟间隔残留点击与节流周期严丝合缝）。

## 现象（潜在触发路径）

风险检测冻结把发布标签页拖过 Chrome 5 分钟节流线后弹出发布弹窗 →
waitForPublishResult 以 1 tick/分钟运行，`n>=40` 的 32 秒预算被拉成约 40 分钟，
期间 `n%5` 的自愈逻辑会长时间反复点击「确认发布」提交按钮。

## 根因

与 20260715-zombie-publish-tab 同根因的最后一处残留：tick 计数当超时
（`setInterval(…,800)` + `n>=40`），隐藏标签页 intensive throttling 下计数节奏失真。

## 修法

- 超时：`elapsedMs >= PUBLISH_RESULT_TIMEOUT_MS(32000)`（预算与原 40×800ms 等价）
- 重点「确认发布」节奏：`elapsedMs>4000 && nowMs-lastReclickMs>=4000`（真实 4 秒限流，
  节流下不积压连点，比原实现更安全）
- 成功判定持续期：`n>=4` → `elapsedMs>=3200`（"无弹窗需持续 3.2s"语义保留）
- 状态横幅计数展示改为秒数
- 放弃方案：无（方案与 submitAndConfirm 墙钟化同构，无竞争方案）

## 波及面与回归

- 正常前台/短时后台场景 tick≈800ms，三处判定与原行为等价（预算/节奏/持续期均按原值换算）
- netPublishResult 权威短路、-1010 单击防线、二次确认弹窗处理均未动
- 回归：tests/logic.test.cjs 70/70 基线无退化；`bash tests/run.sh` 通过（UI 测试环境无
  playwright 自动跳过）；浏览器节流场景无法自动化复现（同僵尸页档案，形态所限），
  建议真实批次跑一轮长时间风险检测章节观察

## 测试

- 无新增用例（DOM 重度函数 + 节流行为不可沙箱复现）；存量 70 条基线守护

## 审查

- docs/fixes/.reviews/fix-publish-result-wallclock-r1.md（AI 自审，Codex 未装降级，通过）
