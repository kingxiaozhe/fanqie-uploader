# 规格对抗审查凭证 — 导入体验（编码 + ZIP）r1

- 日期：2026-07-19
- 通道：codex exec 主通道 2 分钟超时未产出结论 → 按 N4 降级链改用对抗子代理（general-purpose）完成
- 覆盖 Step 9.5（方案对抗）+ Step 10.6（拆分质量）两意图

## 采纳并已修入 specs 的问题

| 编号 | 严重度 | 问题 | 处置 |
| ---- | ---- | ---- | ---- |
| B1 | 阻断 | async 函数被抽取器丢 `async`，eval 抛 SyntaxError，顶层无 try/catch → 打爆现存 74 用例；T-006「STORED 同步可测」是空承诺 | design 增「可测性切分」：仅 readEOCD/readCentralDir/sliceEntryData 同步可测；parseZip/inflate/onZipPicked 不进抽取。tasks T-003/T-004/T-006 据此重写 |
| B2 | 高 | 切片长度若取 local header，GP bit3 流式 zip 的 size=0 → 静默空章 | design 明确：切片长度取中央目录 compressedSize，数据起点用 local header 自己的 name/extra 长度 |
| B3 | 中 | parseZip 契约标同步却要 await | 契约统一 async，声明不进抽取 |
| B4 | 中 | EOCD 倒扫缺注释区(22+65535)与误命中防护 | design 增倒扫范围、取最后匹配 + comment-length 校验；T-003/T-007 覆盖带注释 zip |
| B5 | 中 | T-002 绑未定义 onZipPicked，不可独立验收 | T-002 只做 html 入口；绑定+实现挪 T-005 |
| B6 | 低 | Feature1 AC-004 措辞：GBK 非 fatal 永不抛，"解码异常兜底"是死路径 | requirements AC-004 改述为异常或空文件、� 由 minWords 兜底 |
| B7 | 低 | zip 解压在零依赖沙箱净可测覆盖≈0，勿造虚假安全感 | T-006 如实记录 DEFLATE 端到端走 playwright/人工 |
| B8 | 低 | 抽取器裸计花括号，报错文案含落单 `{`/`}` 会打爆 | design + T-003 注明报错文案不得含裸花括号 |

## 放行判定（子代理结论）

- Feature 1（编码探测）：方案正确、纯函数同步可抽取、耦合干净、波及面判定准确；改一句 AC 即可放行。
- Feature 2（ZIP 导入）：修 B1/B2、澄清 B3/B4/B5、备注 B7/B8 后放行；均已修入 specs。

（子代理 agentId: a632bf07ccd44f0ab，实测环境 Node v24 证实 B1/B2 两条关键断言。）
