# 审查凭证：fix-zombie-publish-tab 第 1 轮

- 审查方式：AI 自审（Codex CLI 未安装，按 N4 降级链执行）
- 审查对象：publisher.js 墙钟超时 + uploader.js/background.js 看门狗关页 diff
- 结论：**通过**（0 阻断项，3 个已核实的边界确认）

## 重点核查项

1. **根因是否真被修掉**：僵尸页成因 = `n>=60` tick 计数超时在 Chrome intensive throttling
  （隐藏>5min → 定时器 1 次/分钟）下被拉长约 60 倍，期间 `n%4` 重点"下一步"变成每 4 分钟一次
  （与日志 21:24:51→21:28:51→21:32:51→21:36:51 严丝合缝）。改墙钟后：节流下第二个 tick（≤2 分钟）
   即达 60s 真实超时 → resolve(false) → 既有失败路径发 TASK_FAILED + 1.5s 后 CLOSE_TAB 自关。✓
2. **风险检测"要多久等多久"语义保留**：原实现 `n--` 冻结计数；新实现 `frozenMs += sinceLastTick`
   冻结墙钟——节流场景下 sinceLastTick 变大，冻结量同步变大，语义在两种 tick 频率下都正确。
   原 `n--` 在节流下反而会把 5 分钟的检测等待错误消耗掉 60 个"秒"额度，新实现更准。✓
3. **二道闸（看门狗关页）越界检查**：
   - dryRun 试填页是留给用户检查的 → 已加 `!session?.settings?.dryRun` 守卫，不关 ✓
   - 风控暂停（PAUSE_BATCH）要保留页面给用户过验证 → onBatchPaused 先 clearWatchdog，
     看门狗不会触发，CLOSE_PUBLISH_TAB 不会发出 ✓
   - `last_publish_tab_id` 时序：看门狗只在等待当前章时触发，而该 key 在每次 OPEN_PUBLISH_TAB
     时覆盖写入 → 关的一定是当前章的页；tab 已被自关时 tabs.remove 抛错已 catch ✓
4. **行为变化说明**：看门狗超时后发布页被强制关闭——修复前该页可能在超时后仍完成发布
  （调度器已标失败，产生"标失败实际已发"的错位），修复后状态确定性更强，防重复查重
  （isChapterAlreadyPublished）仍兜底已创建的草稿。属改善而非回归。
5. **防护网形态**：Chrome 节流行为无法在 node 测试中复现（需真实浏览器后台标签页 >5min），
   按 /cm:fix 第 3 步"写不了自动化测试的形态"留证据：修前证据 = 运行日志 4 分钟间隔僵尸点击；
   逻辑正确性由墙钟算式直读核验（60s 真实时间，冻结段扣除）。
