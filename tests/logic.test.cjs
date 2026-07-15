// ============================================================
//  tests/logic.test.cjs — 内容脚本纯逻辑回归测试（零依赖）
//  做法：从 content/*.js 源码原文按花括号匹配抽取具名函数，在沙箱里执行。
//  测的是"实际发布的代码原文"，不是重写版。运行：node tests/logic.test.cjs
// ============================================================
const fs = require("fs");
const path = require("path");

function extract(src, name) {
  const sig = src.indexOf("function " + name + "(");
  if (sig < 0) throw new Error("找不到函数 " + name);
  let i = src.indexOf("{", sig), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) { i++; break; } }
  }
  return src.slice(sig, i);
}

const root = path.join(__dirname, "..");
const up = fs.readFileSync(path.join(root, "content/uploader.js"), "utf8");
const pub = fs.readFileSync(path.join(root, "content/publisher.js"), "utf8");
const popup = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");

// 沙箱：声明真实代码引用到的模块级变量
let session, rateBackoff = 1, netPublishResult = null, sawRateLimit = false, document;
eval(extract(up, "isNightTime"));
eval(extract(up, "computePublishTime"));
eval(extract(up, "nextFreeCadenceSlot"));
eval(extract(up, "assignRetryTimes"));
eval(extract(up, "noteRateSignal"));
eval(extract(up, "pickScheduleMs"));
eval(extract(up, "latestScheduledFromList"));
eval(extract(up, "toYMD"));
eval(extract(up, "bumpStartDate"));
eval(extract(up, "isDailyLimitRejection"));
eval(extract(up, "rescheduleAfterDailyLimit"));
eval(extract(pub, "classifyFailure"));
eval(extract(pub, "detectRiskControl"));
eval(extract(pub, "pureTitle"));
eval(extract(pub, "extractNumber"));
eval(extract(up, "sameTitle"));
eval(extract(popup, "cnToInt"));
eval(extract(popup, "numFromName"));
eval(extract(popup, "numFromText"));

let P = 0, F = 0;
const ok = (n, c, g) => { if (c) { P++; console.log("✅ " + n); } else { F++; console.log("❌ " + n + "  → " + JSON.stringify(g)); } };

// ---- computePublishTime ----
session = { settings: { publishMode: "immediate" } };
ok("immediate → now", computePublishTime(0) === "now");
session = { settings: { publishMode: "auto", dailyChapters: 3, startHour: "06:00" }, scheduleStartDate: "2026-06-20" };
ok("auto 第4章晚于第1章(跨天)", new Date(computePublishTime(3)) > new Date(computePublishTime(0)));

// ---- isNightTime 边界（默认 23:00~07:00 跨午夜）----
session = { settings: { nightAvoid: true, nightStart: "23:00", nightEnd: "07:00" } };
const at = (h, m = 0) => new Date(2026, 5, 20, h, m).getTime();
ok("夜间 03:00 命中", isNightTime(at(3)));
ok("夜间 23:30 命中", isNightTime(at(23, 30)));
ok("白天 12:00 不命中", !isNightTime(at(12)));
ok("07:00 右开不命中", !isNightTime(at(7)));
ok("23:00 左闭命中", isNightTime(at(23)));
session = { settings: { nightAvoid: false } };
ok("未开避让恒 false", !isNightTime(at(3)));

// ---- 夜间避让：跳过夜间档 + 章序单调 ----
session = { settings: { publishMode: "auto", dailyChapters: 3, startHour: "22:00", nightAvoid: true, nightStart: "23:00", nightEnd: "07:00" }, scheduleStartDate: "2026-06-20" };
let prev = 0, mono = true, noNight = true;
for (let i = 0; i < 6; i++) { const t = new Date(computePublishTime(i)); if (t.getTime() < prev) mono = false; prev = t.getTime(); if (isNightTime(t.getTime())) noNight = false; }
ok("夜间避让: 章序单调", mono);
ok("夜间避让: 无夜间档", noNight);

// ---- 重发排期：未来沿用 / 过期改期 / 不撞档 ----
session = { settings: { publishMode: "auto", dailyChapters: 3, startHour: "06:00" } };
const iso = (d, h) => new Date(2026, 5, d, h, 0).toISOString();
const future = new Date(Date.now() + 1000 * 60 * 60 * 72).toISOString();
session.tasks = [
  { id: 1, status: "uploaded", publishTime: iso(16, 6) },
  { id: 5, publishTime: iso(16, 22) },  // 过期 → 改期
  { id: 8, publishTime: future },        // 未来 → 沿用
  { id: 9, publishTime: iso(17, 6) },    // 过期 → 改期（避开 5 占的档）
];
assignRetryTimes();
const g = (id) => session.tasks.find((t) => t.id === id).publishTime;
ok("重发: 未来章沿用原时间(id8)", g(8) === future);
ok("重发: 过期章改期(id5)", g(5) !== iso(16, 22));
ok("重发: 两改期章不撞档(5≠9)", g(5) !== g(9));

// ---- 自适应限流退避 ----
rateBackoff = 1; noteRateSignal(true); ok("限流 → 放大(>1)", rateBackoff > 1);
rateBackoff = 1; for (let i = 0; i < 10; i++) noteRateSignal(true); ok("连续限流封顶 ≤4", rateBackoff <= 4);
rateBackoff = 4; noteRateSignal(false); ok("平稳 → 回落(<4)", rateBackoff < 4);
rateBackoff = 1; noteRateSignal(false); ok("平稳不低于 1", rateBackoff === 1);

// ---- 失败原因归类 ----
netPublishResult = { ok: false, code: 1, message: "内容含违禁词" }; sawRateLimit = false;
ok("归类: 违禁内容", classifyFailure(new Error("x")).reason === "违禁内容");
netPublishResult = { ok: false, code: 1, message: "标题不能为空" };
ok("归类: 校验不通过", classifyFailure(new Error("x")).reason === "校验不通过");
netPublishResult = null; sawRateLimit = true;
ok("归类: 限流", classifyFailure(new Error("x")).reason === "限流");
netPublishResult = null; sawRateLimit = false;
ok("归类: 版本冲突", classifyFailure(new Error("版本冲突反复出现，已中止本章（将自动重试）")).reason === "版本冲突");
ok("归类: 正文未填入", classifyFailure(new Error("正文未成功填入")).reason === "正文未填入");
ok("归类: 超时未确认", classifyFailure(new Error("未跳转回章节管理页")).reason === "超时未确认");

// ---- 风控检测 ----
const mkDoc = (sel, text) => ({ querySelector: (q) => (sel && q.includes(sel) ? {} : null), body: { textContent: text || "" } });
document = mkDoc(".captcha_verify_container", ""); ok("风控: 验证码容器命中", detectRiskControl() === "验证码/滑块验证");
document = mkDoc("", "请完成安全验证后继续"); ok("风控: 安全验证文案命中", detectRiskControl() === "需要安全验证");
document = mkDoc("", "登录已失效，请重新登录"); ok("风控: 登录异常命中", detectRiskControl() === "账号/登录异常");
document = mkDoc("", "正常的章节管理页内容"); ok("风控: 正常页不误报", detectRiskControl() === null);

// ---- 排期接续：从接口全量数据取最晚排期（修复只读当前 DOM 分页导致接续偏早撞满额日）----
const dayMs = (d, h) => new Date(2026, 5, d, h, 0).getTime();
ok("接续: publish_time 秒级时间戳", pickScheduleMs({ publish_time: Math.floor(dayMs(20, 6) / 1000) }) === dayMs(20, 6));
ok("接续: publish_time 毫秒时间戳", pickScheduleMs({ publish_time: dayMs(20, 6) }) === dayMs(20, 6));
ok("接续: 字符串日期可解析", pickScheduleMs({ publish_time: "2026-06-20 06:00:00" }) === new Date(2026, 5, 20, 6, 0).getTime());
ok("接续: 无时间字段 → null", pickScheduleMs({ title: "第1章" }) === null);
ok("接续: 全量取最晚", latestScheduledFromList([
  { publishMs: dayMs(18, 22) }, { publishMs: dayMs(21, 6) }, { publishMs: dayMs(20, 14) },
])?.getTime() === dayMs(21, 6));
ok("接续: 列表无时间 → null", latestScheduledFromList([{ publishMs: null }, {}]) === null);
ok("接续: 空列表 → null", latestScheduledFromList([]) === null);

// ---- 每日上限(-1020)：判定 + 后续排期整体顺延一天重算 ----
ok("上限判定: 每日上限文案命中", isDailyLimitRejection("发布被拒", "更新作品数超出每日上限"));
ok("上限判定: code=-1020 命中", isDailyLimitRejection("发布被拒", "code=-1020"));
ok("上限判定: 其它拒绝不命中", !isDailyLimitRejection("发布被拒", "内容审核不通过"));
ok("上限判定: 其它归类不命中", !isDailyLimitRejection("校验不通过", "更新作品数超出每日上限"));
ok("顺延: bumpStartDate = 失败章日期+1(本地时区)",
  bumpStartDate(new Date(2026, 6, 11, 6, 0).toISOString()) === "2026-07-12");
ok("顺延: 无效时间回退明天", (() => {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return bumpStartDate("not-a-date") === toYMD(d);
})());
session = {
  settings: { publishMode: "auto", dailyChapters: 3, startHour: "06:00" },
  scheduleStartDate: "2026-06-20",
  tasks: [
    { id: 1, publishTime: new Date(2026, 5, 20, 6, 0).toISOString() },   // -1020 失败章（已建草稿，不重排）
    { id: 2, publishTime: new Date(2026, 5, 20, 14, 0).toISOString() },  // 待发 → 顺延到 21 号
    { id: 3, publishTime: new Date(2026, 5, 20, 22, 0).toISOString() },  // 待发 → 顺延
    { id: 4, status: "uploaded", publishTime: new Date(2026, 5, 19, 6, 0).toISOString() }, // 已发不动
  ],
};
{
  const before4 = session.tasks[3].publishTime;
  const shifted = rescheduleAfterDailyLimit(1);
  ok("顺延: 命中后返回 true", shifted === true);
  ok("顺延: 起始日 +1", session.scheduleStartDate === "2026-06-21");
  ok("顺延: 待发章重排到次日起", new Date(session.tasks[1].publishTime).getDate() === 21);
  ok("顺延: 保持章序(id2 早于 id3)", new Date(session.tasks[1].publishTime) < new Date(session.tasks[2].publishTime));
  ok("顺延: 已发章不动", session.tasks[3].publishTime === before4);
  ok("顺延: 同日重复失败不重复顺延", rescheduleAfterDailyLimit(1) === false && session.scheduleStartDate === "2026-06-21");
}

// ---- 章节号解析：优先「第N章」，不被文件名里其它数字带偏 ----
ok("章节号: 第1章.txt → 1", numFromName("第1章.txt") === 1);
ok("章节号: 001.txt → 1", numFromName("001.txt") === 1);
ok("章节号: 2024第5章.txt → 5(不取年份)", numFromName("2024第5章.txt") === 5, numFromName("2024第5章.txt"));
ok("章节号: v2第3章.txt → 3(不取版本号)", numFromName("v2第3章.txt") === 3, numFromName("v2第3章.txt"));
ok("章节号: 第 56 章.txt → 56(容空格)", numFromName("第 56 章.txt") === 56, numFromName("第 56 章.txt"));
ok("章节号: 5 标题.txt → 5(无第章退首数字)", numFromName("5 标题.txt") === 5, numFromName("5 标题.txt"));
ok("章节号: 无数字 → null", numFromName("序章.txt") === null);

// ---- 中文数字章节：标题剥前缀 + 章节号解析（修复"第二十章 xx"前缀原样进标题框）----
ok("中文数字: cnToInt 二十 → 20", cnToInt("二十") === 20);
ok("中文数字: cnToInt 三十九 → 39", cnToInt("三十九") === 39);
ok("中文数字: cnToInt 一百零五 → 105", cnToInt("一百零五") === 105);
ok("中文数字: cnToInt 十 → 10", cnToInt("十") === 10);
ok("中文数字: cnToInt 两百 → 200", cnToInt("两百") === 200);
ok("中文数字: cnToInt 非法字符 → null", cnToInt("甲乙") === null);
ok("章节号: 第二十章 xx.md → 20", numFromName("第二十章 你好啊林光源.md") === 20, numFromName("第二十章 你好啊林光源.md"));
ok("章节号: 第一百零五章.txt → 105", numFromName("第一百零五章.txt") === 105);
ok("章节号: 正文首行中文数字 → 20", numFromText("第二十章 你好啊林光源\n正文…") === 20);
ok("标题剥前缀: 第20章 你好啊林光源 → 你好啊林光源", pureTitle("第20章 你好啊林光源") === "你好啊林光源");
ok("标题剥前缀: 第二十章 你好啊林光源 → 你好啊林光源(用户案例)", pureTitle("第二十章 你好啊林光源") === "你好啊林光源", pureTitle("第二十章 你好啊林光源"));
ok("标题剥前缀: 第 56 章 代价 → 代价(容空格)", pureTitle("第 56 章 代价") === "代价");
ok("标题剥前缀: 第二章：重算这笔账 → 重算这笔账(冒号分隔)", pureTitle("第二章：重算这笔账") === "重算这笔账");
ok("标题剥前缀: 无前缀不变", pureTitle("你好啊林光源") === "你好啊林光源");
ok("标题剥前缀: 剥空回退原标题", pureTitle("第二章") === "第二章");
ok("章节号兜底: extractNumber 第二十章 → 20", extractNumber("第二十章 你好") === 20);
ok("去重归一: 中文/阿拉伯数字前缀视为同章", sameTitle("第2章 重算这笔账", "第二章 重算这笔账"));

console.log(`\n内容脚本逻辑：${P}/${P + F} 通过`);
process.exit(F ? 1 : 0);
