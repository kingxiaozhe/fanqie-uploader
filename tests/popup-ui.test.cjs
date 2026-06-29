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

// 可选：PW_EXECUTABLE 指定浏览器可执行文件（用预装 Chromium 时设它），否则用 playwright 自带
const LAUNCH = process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {};

(async () => {
  const b = await chromium.launch(LAUNCH);
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

    // 字数偏短预警：阈值内标红 + 统计提示 + 阈值=0 关闭
    $("minWords").value = "100"; $("minWords").dispatchEvent(new Event("input"));
    tasks = [
      { id: 1, chapterNumber: 1, title: "正常章", content: "x", wordCount: 1500, selected: true },
      { id: 2, chapterNumber: 2, title: "残章", content: "x", wordCount: 30, selected: true },
    ];
    render();
    let metas = [...document.querySelectorAll("#list .meta")];
    ok("偏短预警: 残章标红", metas[1].classList.contains("short"));
    ok("偏短预警: 正常章不标红", !metas[0].classList.contains("short"));
    ok("偏短预警: 统计提示偏短数", $("count").textContent.includes("1章偏短"), $("count").textContent);
    $("minWords").value = "0"; $("minWords").dispatchEvent(new Event("input"));
    ok("偏短预警: 阈值0关闭", ![...document.querySelectorAll("#list .meta")].some((m) => m.classList.contains("short")));
    ok("collectSettings 含 minWords", "minWords" in collectSettings());

    // 仅存草稿模式：默认关 + 进 collectSettings + 开启隐藏排期预览
    ok("草稿模式默认关", $("draftMode").checked === false);
    ok("collectSettings 含 draftMode", "draftMode" in collectSettings());
    document.querySelector("input[name=mode][value=auto]").checked = true;
    tasks = [{ id: 1, chapterNumber: 1, title: "a", content: "x", wordCount: 1500, selected: true }];
    render();
    $("draftMode").checked = true; $("draftMode").dispatchEvent(new Event("change"));
    ok("草稿模式隐藏排期预览", $("previewBox").hidden === true, $("previewBox").hidden);
    $("draftMode").checked = false; $("draftMode").dispatchEvent(new Event("change"));

    // 敏感词预检：词库+开关 → 命中标 🚫 + 统计 + tooltip；关闭后消失
    ok("collectSettings 含 sensitiveCheck", "sensitiveCheck" in collectSettings());
    tasks = [
      { id: 1, chapterNumber: 1, title: "正常章", content: "风和日丽", wordCount: 1500, selected: true },
      { id: 2, chapterNumber: 2, title: "问题章", content: "含违禁词A的正文", wordCount: 1400, selected: true },
    ];
    sensitiveWords = ["违禁词A"];
    render();
    ok("敏感词: 未开启不标记", document.querySelectorAll("#list .flag").length === 0);
    $("sensitiveCheck").checked = true; $("sensitiveCheck").dispatchEvent(new Event("change"));
    let flags = [...document.querySelectorAll("#list .flag")];
    ok("敏感词: 命中章打🚫", flags.length === 1, flags.length);
    ok("敏感词: tooltip列出命中词", flags[0] && flags[0].title.includes("违禁词A"), flags[0] && flags[0].title);
    ok("敏感词: 统计提示含敏感词", $("count").textContent.includes("🚫1章含敏感词"), $("count").textContent);
    $("sensitiveCheck").checked = false; $("sensitiveCheck").dispatchEvent(new Event("change"));
    ok("敏感词: 关闭后标记消失", document.querySelectorAll("#list .flag").length === 0);
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
