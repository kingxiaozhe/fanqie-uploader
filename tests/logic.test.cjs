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

// 沙箱：声明真实代码引用到的模块级变量
let session, rateBackoff = 1, netPublishResult = null, sawRateLimit = false, document;
eval(extract(up, "isNightTime"));
eval(extract(up, "computePublishTime"));
eval(extract(up, "nextFreeCadenceSlot"));
eval(extract(up, "assignRetryTimes"));
eval(extract(up, "noteRateSignal"));
eval(extract(pub, "classifyFailure"));
eval(extract(pub, "detectRiskControl"));

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
ok("归类: 正文未填入", classifyFailure(new Error("正文未成功填入")).reason === "正文未填入");
ok("归类: 超时未确认", classifyFailure(new Error("未跳转回章节管理页")).reason === "超时未确认");

// ---- 风控检测 ----
const mkDoc = (sel, text) => ({ querySelector: (q) => (sel && q.includes(sel) ? {} : null), body: { textContent: text || "" } });
document = mkDoc(".captcha_verify_container", ""); ok("风控: 验证码容器命中", detectRiskControl() === "验证码/滑块验证");
document = mkDoc("", "请完成安全验证后继续"); ok("风控: 安全验证文案命中", detectRiskControl() === "需要安全验证");
document = mkDoc("", "登录已失效，请重新登录"); ok("风控: 登录异常命中", detectRiskControl() === "账号/登录异常");
document = mkDoc("", "正常的章节管理页内容"); ok("风控: 正常页不误报", detectRiskControl() === null);

console.log(`\n内容脚本逻辑：${P}/${P + F} 通过`);
process.exit(F ? 1 : 0);
