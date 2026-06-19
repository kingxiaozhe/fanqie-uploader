// ============================================================
//  tests/popup-ui.test.cjs — 真实 popup.js + popup.html UI 交互测试
//  用 Playwright 加载真实页面、打桩 chrome API、驱动真实点击并断言 DOM/状态。
//  需要 playwright（npx playwright install chromium）。缺失时优雅跳过，不算失败。
//  运行：node tests/popup-ui.test.cjs   （或 tests/run.sh 自动定位 playwright）
// ============================================================
const path = require("path");

let chromium;
try { ({ chromium } = require("playwright")); }
catch { console.log("⏭️  跳过：未找到 playwright（npx playwright install chromium 后可跑）"); process.exit(0); }

const root = path.join(__dirname, "..");

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  // 关键：在任何页面脚本执行前注入 chrome 桩
  await p.addInitScript(() => {
    const store = {};
    window.__store = store;
    window.chrome = {
      storage: { local: {
        get: (k) => Promise.resolve(
          typeof k === "string" ? { [k]: store[k] }
          : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]]))
          : { ...store }),
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
  await p.waitForTimeout(400);

  const r = await p.evaluate(() => {
    const out = []; const ok = (n, c, g) => out.push({ name: n, pass: !!c, got: g });
    const $ = (id) => document.getElementById(id);
    applyPreset("conservative");
    ok("保守 gapMin=60", $("gapMin").value === "60", $("gapMin").value);
    ok("保守 gapMax=180", $("gapMax").value === "180", $("gapMax").value);
    ok("保守 jitter=15", $("minuteJitter").value === "15", $("minuteJitter").value);
    ok("保守 maxPerBatch=8", $("maxPerBatch").value === "8", $("maxPerBatch").value);
    ok("保守 pace=1.6", $("pace").value === "1.6", $("pace").value);
    ok("保守 humanize=on", $("humanize").checked === true);
    ok("保守 nightAvoid=on", $("nightAvoid").checked === true);
    ok("保守 夜间时段行显示", $("nightRow").hidden === false);
    ok("保守 按钮高亮", document.querySelector(".preset[data-preset=conservative]").classList.contains("on"));
    applyPreset("fast");
    ok("快速 gapMin=8", $("gapMin").value === "8", $("gapMin").value);
    ok("快速 nightAvoid=off", $("nightAvoid").checked === false);
    ok("快速 夜间时段行隐藏", $("nightRow").hidden === true);
    $("nightAvoid").checked = true; $("nightAvoid").dispatchEvent(new Event("change"));
    ok("手动开夜间 时段行显示", $("nightRow").hidden === false);
    $("nightAvoid").checked = false; $("nightAvoid").dispatchEvent(new Event("change"));
    ok("手动关夜间 时段行隐藏", $("nightRow").hidden === true);
    const setMode = (v) => { const el = document.querySelector("input[name=mode][value=" + v + "]"); el.checked = true; el.dispatchEvent(new Event("change")); };
    setMode("auto");
    ok("模式auto autoCfg显示", $("autoCfg").hidden === false);
    ok("模式auto customCfg隐藏", $("customCfg").hidden === true);
    setMode("custom");
    ok("模式custom customCfg显示", $("customCfg").hidden === false);
    setMode("immediate");
    ok("模式immediate 两区隐藏", $("autoCfg").hidden && $("customCfg").hidden);
    const cs = collectSettings();
    ok("collectSettings 含 nightAvoid", "nightAvoid" in cs);
    ok("collectSettings 含 nightStart/End", ("nightStart" in cs) && ("nightEnd" in cs));
    applyPreset("conservative");
    ok("设置写入 storage", window.__store.popup_settings && window.__store.popup_settings.gapMin === 60);

    // 移除已发布章节（真实 dropPublished / sameTitleLoose）
    tasks = [
      { id: 1, chapterNumber: 1, title: "第1章 甲", selected: true },
      { id: 2, chapterNumber: 2, title: "第2章 乙", selected: true },
      { id: 3, chapterNumber: 3, title: "第3章 丙", selected: true },
    ];
    render();
    ok("移除前 按钮可见", $("removePublished").hidden === false);
    const removed = dropPublished([{ title: "第1章 甲", chapterNumber: 1 }, { title: "第 2 章 乙", chapterNumber: 2 }]);
    ok("移除已发布: 移除数=2", removed === 2, removed);
    ok("移除已发布: 仅剩第3章", tasks.length === 1 && tasks[0].chapterNumber === 3, tasks.map((t) => t.chapterNumber).join(","));
    ok("sameTitleLoose 容空格", sameTitleLoose("第2章 乙", "第 2 章 乙"));
    ok("sameTitleLoose 不同标题不误删", !sameTitleLoose("第1章 甲", "第9章 戊"));
    return out;
  });

  console.log("\n=== 真实 popup.js UI 交互测试 ===");
  let pass = 0;
  for (const t of r) { console.log((t.pass ? "✅" : "❌") + " " + t.name + (t.pass ? "" : "  → 实际:" + t.got)); if (t.pass) pass++; }
  console.log("\n" + pass + "/" + r.length + " 通过");
  if (errors.length) { console.log("\n⚠️ 页面 JS 错误:"); errors.forEach((e) => console.log("  " + e)); }
  await b.close();
  process.exit(pass === r.length && !errors.length ? 0 : 1);
})();
