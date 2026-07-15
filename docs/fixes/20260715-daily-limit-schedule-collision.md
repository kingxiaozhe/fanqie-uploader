# 排期起始日与番茄每日上限撞车（-1020 连环失败）

- 日期：2026-07-15　状态：已修复
- 修前证据：用户导出运行日志——两个批次的开头 3 章全部被拒
  `发布接口返回 ok=false code=-1020 msg=更新作品数超出每日上限`，目标日期同为 07-11；
  失败章已点过「下一步」→ 留下 6 个未排期孤儿草稿，各白耗一次全面检测额度。

## 现象

`startDateMode: "auto"`（自动接续已排期）批次开头连续 -1020；首章被拒后调度器继续把
第 2、3 章往同一天塞，全部撞死。

## 根因（两层）

1. **接续读数漏页**：`computeScheduleStartDate` 依赖 `findLatestScheduledDate()`，后者只扫
   当前 DOM 分页（`tbody .arco-table-tr`）。章节多到翻页后，最晚排期若在其他分页就读漏，
   起始日偏早，落在已排满的日期上。（同步去重早已用跨分页接口，接续却还在读单页 DOM——
   同类问题第二次出现。）
2. **无"当日已满"反馈处理**：`onTaskFailed` 对 -1020 与普通失败同等对待，后续章按原计划
   继续尝试同一天，每次必败。
3. 曾怀疑 UTC 时区错位（日志发布时间为 `Z` 格式）——排查排除：排期计算全链路本地时区，
   日志里的 ISO 串只是序列化表现。

## 修法

- `fetchPublishedViaApi` 条目增提 `publishMs`（新函数 `pickScheduleMs`：5 个候选字段名探测，
  兼容秒/毫秒时间戳与字符串日期）；`getPublishedChapters` 缓存全量列表；
  `computeScheduleStartDate` 优先 `latestScheduledFromList(缓存)`，拿不到才回退 DOM，
  并在运行日志标注数据来源。
- 新增 `isDailyLimitRejection` + `rescheduleAfterDailyLimit`：-1020 命中 → 起始日=失败章日期+1，
  后续待发章整体重算（已上传/已终局失败/失败章本身不动；同日重复失败只顺延一次）。
- 放弃方案：只做 -1020 顺延不修接续读数（治标）；把 computeScheduleStartDate 改 async 现场
  拉接口（改动面大，缓存已够——同步流程先于排期执行）。

## 波及面与回归

- `fetchPublishedViaApi` 返回结构加字段：两个消费方只读 title/chapterNumber，不受影响。
- `toYMD` 从内联抽为顶层函数：行为等价。
- 回归：tests/logic.test.cjs 53/53（含存量基线 34 条无退化）；`bash tests/run.sh` 通过
  （UI 测试因本环境无 playwright 自动跳过）。
- 留观：接口时间字段名为候选探测，全落空则回退 DOM=修复前行为；上线后看一条
  `📅 排期接续：…（来源:接口全量）` 日志即可确认命中。

## 测试

- tests/logic.test.cjs 新增 19 条：`接续:*` 7 条、`上限判定:*` 4 条、`顺延:*` 8 条（红→绿）。

## 审查

- docs/fixes/.reviews/fix-daily-limit-schedule-r1.md（AI 自审，Codex 未装降级，通过）
