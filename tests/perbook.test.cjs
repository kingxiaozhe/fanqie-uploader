// ============================================================
//  tests/perbook.test.cjs — 多本书独立配置（按 bookId）真实交互测试
//  跨多个 popup 实例共享一个模拟 storage，验证：
//   - 从番茄标签页 URL 识别 bookId，标题栏显示「本书专属」
//   - 不同书的设置互不污染，重开各自恢复
//   - 无番茄标签页时退回「全局设置」
//  需要 playwright；缺失时优雅跳过，不算失败。
//  运行：node tests/perbook.test.cjs   （或 tests/run.sh）
// ============================================================
const path = require("path");

let chromium;
try { ({ chromium } = require("playwright")); }
catch { console.log("⏭️  跳过：未找到 playwright"); process.exit(0); }

const root = path.join(__dirname, "..");
const LAUNCH = process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {};

(async () => {
  const b = await chromium.launch(LAUNCH);

  // 打开一个 popup 实例，注入共享 store + 指定活动标签页 URL；返回页面与错误收集
  async function openPopup(tabUrl, sharedStore) {
    const p = await b.newPage();
    await p.addInitScript((args) => {
      const [url, initStore] = args;
      const store = initStore || {};
      window.__dump = () => store;
      window.chrome = {
        storage: { local: {
          get: (k) => Promise.resolve(
            typeof k === "string" ? { [k]: store[k] }
            : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]]))
            : { ...store }),
          set: (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); return Promise.resolve(); },
          remove: (k) => { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); return Promise.resolve(); },
        } },
        runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, lastError: null },
        tabs: { query: () => Promise.resolve(url ? [{ url }] : []), sendMessage: () => {} },
        windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
        sidePanel: { open: () => Promise.resolve() },
        notifications: { create: () => {} },
      };
    }, [tabUrl, sharedStore]);
    const errors = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto("file://" + root + "/popup/popup.html");
    await p.waitForTimeout(350);
    return { p, errors };
  }

  const out = []; const ok = (n, c, g) => out.push({ name: n, pass: !!c, got: g });
  let store = {};
  const allErr = [];

  // 书A（#1001）：设 gapMin=11
  let s = await openPopup("https://fanqienovel.com/main/writer/chapter-manage/1001", store);
  ok("书A 标题栏显示本书专属#1001", await s.p.evaluate(() => document.getElementById("bookScope").textContent.includes("#1001")));
  await s.p.evaluate(() => { const e = document.getElementById("gapMin"); e.value = "11"; e.dispatchEvent(new Event("change")); });
  await s.p.waitForTimeout(150);
  store = await s.p.evaluate(() => window.__dump());
  allErr.push(...s.errors); await s.p.close();

  // 书B（#2002）：设 gapMin=77
  s = await openPopup("https://fanqienovel.com/main/writer/chapter-manage/2002", store);
  await s.p.evaluate(() => { const e = document.getElementById("gapMin"); e.value = "77"; e.dispatchEvent(new Event("change")); });
  await s.p.waitForTimeout(150);
  store = await s.p.evaluate(() => window.__dump());
  allErr.push(...s.errors); await s.p.close();

  // 重开书A → 恢复 11（不被书B污染）
  s = await openPopup("https://fanqienovel.com/main/writer/chapter-manage/1001", store);
  ok("重开书A 恢复11(不被书B污染)", (await s.p.evaluate(() => document.getElementById("gapMin").value)) === "11");
  allErr.push(...s.errors); await s.p.close();

  // 重开书B → 恢复 77
  s = await openPopup("https://fanqienovel.com/main/writer/chapter-manage/2002", store);
  ok("重开书B 恢复77", (await s.p.evaluate(() => document.getElementById("gapMin").value)) === "77");
  allErr.push(...s.errors); await s.p.close();

  // 无番茄标签 → 全局设置
  s = await openPopup(null, store);
  ok("无标签显示全局设置", await s.p.evaluate(() => document.getElementById("bookScope").textContent.includes("全局")));
  allErr.push(...s.errors); await s.p.close();

  await b.close();
  console.log("\n=== 多本书独立配置测试 ===");
  let pass = 0;
  for (const t of out) { console.log((t.pass ? "✅" : "❌") + " " + t.name + (t.pass ? "" : "  → 实际:" + t.got)); if (t.pass) pass++; }
  console.log("\n" + pass + "/" + out.length + " 通过");
  if (allErr.length) { console.log("\n⚠️ 页面 JS 错误:"); allErr.forEach((e) => console.log("  " + e)); }
  process.exit(pass === out.length && !allErr.length ? 0 : 1);
})();
