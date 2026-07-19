# 开发度量（cm:ai）

| 任务 | Feature | 开始 | 结束 | 审查轮次 | Codex拦截 | QA | 人工介入(次:原因) |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| T-001 | 1.chapter-encoding-detect | — | — | — | 基线核验(无产物,74/74) | — | 0 |
| T-002 | 1.chapter-encoding-detect | — | — | 1 | 0 | — | 0 |
| T-003 | 1.chapter-encoding-detect | — | — | 1 | 0（并入 T-002 提交） | — | 0 |
| T-004 | 1.chapter-encoding-detect | — | — | 1 | 1（GBK歧义测试覆盖） | — | 0 |
| T-005 | 1.chapter-encoding-detect | — | — | 自审(核验类) | — | 通过(变异自证2/2红) | 0 |
| T-001 | 2.zip-import | — | — | — | 基线核验(无产物,83/83) | — | 0 |
| T-002 | 2.zip-import | — | — | — | ZIP入口html(并入实现提交) | — | 0 |
| T-003 | 2.zip-import | — | — | 2 | r2共11条:采纳9修/1随解/1残余 | — | 0 |
| T-004 | 2.zip-import | — | — | 2 | 并入T-003审查 | — | 0 |
| T-005 | 2.zip-import | — | — | 2 | 并入T-003审查 | — | 0 |
| T-006 | 2.zip-import | — | — | 2 | 并入T-003审查 | — | 0 |
| T-007 | 2.zip-import | — | — | 自审(核验类) | AC-004错误4/4报错 | 通过(变异自证B2+过滤红) | 0 |
