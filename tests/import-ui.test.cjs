// ============================================================
//  tests/import-ui.test.cjs — 导入功能真·浏览器 UI 测试（Playwright）
//  加载真实 popup.html + popup.js，打桩 chrome API，用 setInputFiles 驱动
//  真实文件输入，断言渲染出的章节列表。覆盖：GBK 文件夹导入、GBK ZIP 一键导入。
//  需要 playwright（npx playwright install chromium）。缺失时优雅跳过，不算失败。
//  运行：NODE_PATH=<npx缓存> node tests/import-ui.test.cjs（tests/run.sh 自动定位）
// ============================================================
const path = require("path");
const fs = require("fs");

let chromium;
try { ({ chromium } = require("playwright")); }
catch { console.log("⏭️  跳过：未找到 playwright"); process.exit(0); }

const root = path.join(__dirname, "..");
const FIX = path.join(root, "tests", "fixtures");
const LAUNCH = process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {};

// 缺夹具（GBK 稿 / zip 未生成）→ 跳过，不算失败
if (!fs.existsSync(path.join(FIX, "gbk_book.zip"))) {
  console.log("⏭️  跳过：缺 tests/fixtures（运行 tests/make-fixtures.sh 生成 GBK 稿与 zip）");
  process.exit(0);
}

let P = 0, F = 0;
const ok = (n, c, g) => { if (c) { P++; console.log("✅ " + n); } else { F++; console.log("❌ " + n + "  → " + JSON.stringify(g)); } };
const clean = (s) => !/�/.test(s); // 无替换符 = 未乱码

(async () => {
  const b = await chromium.launch(LAUNCH);
  const p = await b.newPage();
  await p.addInitScript(() => {
    const store = {};
    window.__store = store;
    window.chrome = {
      storage: { local: {
        get: (k) => Promise.resolve(typeof k === "string" ? { [k]: store[k] } : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]])) : { ...store }),
        set: (o) => { Object.assign(store, o); return Promise.resolve(); },
        remove: (k) => { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); return Promise.resolve(); },
      } },
      runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, lastError: null },
      tabs: { query: () => Promise.resolve([]), sendMessage: () => {} },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      sidePanel: { open: () => Promise.resolve() },
      notifications: { create: () => {} },
    };
  });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto("file://" + root + "/popup/popup.html");
  await p.waitForTimeout(300);

  // 读当前渲染出的章节标题列表
  const titles = () => p.$$eval("#list .title", (els) => els.map((e) => e.textContent.trim()));

  // ---------- ① ZIP 一键导入（GBK 文件名 + GBK 正文）----------
  await p.setInputFiles("#zip", path.join(FIX, "gbk_book.zip"));
  await p.waitForFunction(() => document.querySelectorAll("#list .title").length >= 3, null, { timeout: 8000 }).catch(() => {});
  let t = await titles();
  ok("ZIP: 渲染出 3 章", t.length === 3, t);
  ok("ZIP: 标题无乱码", t.every(clean), t);
  ok("ZIP: 含第1章·起航", t.some((x) => x.includes("第1章") && x.includes("起航")), t);
  ok("ZIP: 含第10章·活口", t.some((x) => x.includes("第10章") && x.includes("活口")), t);
  ok("ZIP: 书名取 zip 文件名", await p.$eval("#zipName", (e) => e.textContent) === "gbk_book", await p.$eval("#zipName", (e) => e.textContent));

  // ---------- ② 选文件夹（GBK 稿）----------
  await p.setInputFiles("#folder", path.join(FIX, "gbk_book"));
  await p.waitForFunction(() => document.querySelectorAll("#list .title").length >= 3, null, { timeout: 8000 }).catch(() => {});
  t = await titles();
  ok("文件夹: 渲染出 3 章", t.length === 3, t);
  ok("文件夹: 标题无乱码", t.every(clean), t);
  ok("文件夹: 章号顺序 1→2→10", /第1章/.test(t[0]) && /第2章/.test(t[1]) && /第10章/.test(t[2]), t);

  ok("页面无 JS 错误", errors.length === 0, errors);

  await b.close();
  console.log(`\n导入 UI 测试：${P}/${P + F} 通过`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error("测试异常：", e); process.exit(1); });
