# 审查凭证：fix-daily-limit-schedule 第 1 轮

- 审查方式：AI 自审（Codex CLI 未安装，按 N4 降级链执行）
- 审查对象：uploader.js 排期接续 + -1020 顺延 diff
- 结论：**通过**（0 阻断项，2 个已核实的边界确认，1 条留观项）

## 重点核查项

1. **根因是否真被修掉，而非只治症状**
   - 症状：批次开头连续 3 章 -1020。根因两层：
     a) `findLatestScheduledDate()` 只读当前 DOM 分页 → 接续起始日偏早（已修：优先接口全量缓存 `lastPublishedList` 取 `publishMs` 最大值，DOM 只作回退并在日志里标注"可能漏读"）；
     b) 首章 -1020 后无"当日已满"处理 → 后续章硬试同一天（已修：`rescheduleAfterDailyLimit` 起始日+1 整体重算）。
   - b) 是兜底保证：即使 a) 的接口时间字段名探测全部落空（`pickScheduleMs` 返回 null 回退 DOM=现状），撞车也只损失 1 章额度而非 3 章。根因与兜底双层齐备 ✓
2. **接口字段名是猜测的（publish_time 等 5 个候选）**——无法离线验证番茄真实返回。
   已核实降级安全：字段全不命中 → publishMs=null → latestScheduledFromList 返回 null → 回退 DOM 扫描 = 修复前行为，不会更糟。日志会写明来源（接口全量 / DOM 当前页），上线后一条日志即可核实字段是否命中。**留观项**
3. **顺延幂等**：同一天连续多章 -1020 → `newStart <= scheduleStartDate` 短路，只顺延一次；下一天再满会随失败章日期推进继续顺延（渐进收敛）。测试覆盖 ✓
4. **不越界**：已上传(`uploaded`)、已终局失败(`failed`)、失败章本身不重排；`fixed/tomorrow` 起始日模式不受影响（仅 `publishMode==="auto"` 且命中判定才触发）✓
5. **时区**：全链路本地时区（`toYMD`/`bumpStartDate` 用本地 getter；字符串日期 parse 前统一转 `/` 分隔确保本地解析）。测试用本地构造的 ISO 断言，测试机任意时区可复现 ✓
6. **波及面**：`computeScheduleStartDate` 内联 toYMD 抽为顶层（行为等价）；`fetchPublishedViaApi` 返回条目多一个 `publishMs` 字段——两处消费方（syncUploadedChapters、isChapterAlreadyPublished）只读 title/chapterNumber，不受影响 ✓
