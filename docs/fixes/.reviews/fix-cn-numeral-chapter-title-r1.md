# 审查凭证：fix-cn-numeral-chapter-title 第 1 轮

- 审查方式：AI 自审（Codex CLI 未安装，按 N4 降级链执行）
- 审查对象：popup.js / publisher.js / uploader.js 中文数字章节名支持 diff
- 结论：**通过**（0 阻断项，4 个已核实的边界确认）

## 重点核查项

1. **根因是否全链路修掉**：「第N章」识别共五处——publisher 剥标题前缀(fillTitle→pureTitle)、
   publisher 章节号兜底(extractNumber)、popup 章节号+文件排序(numFromName)、popup 正文兜底
   (numFromText)、popup/uploader 两处去重归一(sameTitleLoose/sameTitle)。五处全部升级为
   `(?:\d+|[零〇一二两三四五六七八九十百千]+)`，无漏点。uploader 的番茄侧列表提号
   (fetchPublishedViaApi/scrape) 保持阿拉伯——番茄标题前缀由其章节号框生成，恒为阿拉伯，
   不是同一根因，不扩面 ✓
2. **历史脏数据兼容**：此前中文数字批次已把"第二章 重算这笔账"整串填进标题框，番茄侧标题
   形如"第2章 第二章 重算这笔账"。去重归一各剥一层前缀后："第二章 重算这笔账" vs
   "第二章 重算这笔账" 相等 → 旧章去重不受影响 ✓
3. **cnToInt 边界**：`零→0` 为 falsy，numFromName 的 `if (n)` 与 extractNumber 调用点的
   `|| ""` 均按"未解析"处理，不会把 0 填进章节号框；非法字符返回 null；`两/〇` 已支持；
   十/两百/一百零五/一千零一 均验证 ✓
4. **行为变化（正向）**：中文数字文件名此前 numFromName 返回 null → 排序按 0 挤在一起
   顺序不稳，现按章号正确排序。属根因同源的修复而非顺手扩展 ✓
5. **重复实现说明**：cnToInt 在 popup 与 publisher 各一份（MV3 content script 无模块系统，
   与既有 sameTitle 双份先例一致）；两份实现逐字符相同，测试锁 popup 份，publisher 份由
   extractNumber 用例间接覆盖 ✓
6. **防护网**：17 条新用例（含用户案例"第二十章 你好啊林光源"），红→绿；存量 53 条无退化。
