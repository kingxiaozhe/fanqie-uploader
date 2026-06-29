// ============================================================
//  tests/selftest.test.cjs — 选择器自检（publisher.js）真实运行测试
//  把真实 content/publisher.js 注入到模拟「发布页」，触发 fq_selftest，
//  验证自检报告浮层正确判定核心选择器命中/失效。
//  需要 playwright；缺失时优雅跳过，不算失败。
//  运行：node tests/selftest.test.cjs   （或 tests/run.sh）
// ============================================================
const fs = require("fs");
const path = require("path");

let chromium;
try { ({ chromium } = require("playwright")); }
catch { console.log("⏭️  跳过：未找到 playwright"); process.exit(0); }

const root = path.join(__dirname, "..");
const LAUNCH = process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {};
const pubSrc = fs.readFileSync(path.join(root, "content/publisher.js"), "utf8");

// 核心选择器齐全的发布页
const OK_BODY = `
  <div class="serial-editor-title-left"><input /></div>
  <input placeholder="请输入标题" />
  <div class="ProseMirror" contenteditable="true"></div>
  <button data-apm-action="core_chain_long_story_next_confirm">下一步</button>`;
// 缺正文编辑器 + 缺提交按钮
const BAD_BODY = `<input placeholder="请输入标题" />`;

(async () => {
  const b = await chromium.launch(LAUNCH);

  async function scenario(name, bodyHtml, expectCoreOk) {
    const p = await b.newPage();
    await p.addInitScript(() => {
      const store = { fq_selftest: true };
      window.chrome = {
        storage: { local: {
          get: (k) => Promise.resolve(typeof k === "string" ? { [k]: store[k] } : { ...store }),
          set: (o) => { Object.assign(store, o); return Promise.resolve(); },
          remove: (k) => { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); return Promise.resolve(); },
        } },
        runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, lastError: null },
      };
    });
    const errors = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    // 用 data: 导航确保 addInitScript 生效，再注入 publisher.js
    await p.goto("data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><html><body>" + bodyHtml + "</body></html>"));
    await p.addScriptTag({ content: pubSrc });
    let appeared = false;
    try { await p.waitForSelector("#fq-selftest-panel", { timeout: 12000 }); appeared = true; } catch (_) {}
    let res = { allHit: false, hasMiss: false };
    if (appeared) res = await p.evaluate(() => {
      const t = document.getElementById("fq-selftest-panel").innerText;
      return { allHit: t.includes("核心选择器全部命中"), hasMiss: t.includes("核心选择器失效") };
    });
    const pass = appeared && (expectCoreOk ? res.allHit : res.hasMiss) && errors.length === 0;
    await p.close();
    return { name, pass, appeared, res, errors };
  }

  const results = [
    await scenario("核心齐全 → 报告全部命中", OK_BODY, true),
    await scenario("缺正文/提交按钮 → 报告核心失效", BAD_BODY, false),
  ];

  await b.close();
  console.log("\n=== 选择器自检测试 ===");
  let pass = 0;
  for (const t of results) {
    console.log((t.pass ? "✅" : "❌") + " " + t.name);
    if (!t.pass) { console.log("   appeared:", t.appeared, "res:", JSON.stringify(t.res)); if (t.errors.length) console.log("   errors:", t.errors); }
    if (t.pass) pass++;
  }
  console.log("\n" + pass + "/" + results.length + " 通过");
  process.exit(pass === results.length ? 0 : 1);
})();
