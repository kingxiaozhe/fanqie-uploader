// ============================================================
//  popup/popup.js — 弹窗 UI 逻辑
//  选文件夹 → 解析 .txt 章节 → 生成任务列表 → 勾选 → 开始上传
// ============================================================

let tasks = []; // [{ id, fileName, title, chapterNumber, content, wordCount, selected }]
let folderName = ""; // 选中的文件夹名（= 书名），随会话一路带到进度面板/导出报告
let sensitiveWords = []; // 敏感词预检词库（用户自定义，存 chrome.storage.local）
const WORDS_KEY = "fq_sensitive_words";

// 扫描一章命中的敏感词（标题+正文，去重）。词库为空或未开启时返回 []
function scanSensitive(task) {
  if (!$("sensitiveCheck").checked || !sensitiveWords.length) return [];
  const hay = (task.title || "") + "\n" + (task.content || "");
  const hits = [];
  for (const w of sensitiveWords) {
    if (w && hay.includes(w) && !hits.includes(w)) hits.push(w);
  }
  return hits;
}

const $ = (id) => document.getElementById(id);

$("pick").addEventListener("click", () => $("folder").click());
$("folder").addEventListener("change", onFolderPicked);
$("selectAll").addEventListener("change", (e) => {
  tasks.forEach((t) => (t.selected = e.target.checked));
  render();
});
$("start").addEventListener("click", onStart);

// 停止上传：写入停止信号，发布器在提交前、调度器在章节间都会响应
$("stopBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({ upload_control: "stop" });
  $("stopBtn").disabled = true;
  $("stopBtn").textContent = "⏹ 已请求停止";
});

// 🩺 选择器自检：打开一个发布页做诊断（只加载、不建章），由 publisher.js 检测并弹报告
$("selfTest").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = (tab?.url || "").match(/\/main\/writer\/(?:chapter-manage\/)?(\d+)/);
  if (!m) { toast("请先在番茄『章节管理』页打开你的书，再点自检"); return; }
  await chrome.storage.local.set({ fq_selftest: true });
  const url = `https://fanqienovel.com/main/writer/${m[1]}/publish/?enter_from=newchapter`;
  await chrome.tabs.create({ url, active: true });
  window.close();
});

// 打开侧边进度面板
$("openPanel").addEventListener("click", async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  } catch (e) {
    alert("打开进度面板失败：" + e.message);
  }
});

// 发布模式切换：显示对应的配置区
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener("change", () => {
    const mode = currentMode();
    $("autoCfg").hidden = mode !== "auto";
    $("customCfg").hidden = mode !== "custom";
  })
);

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

// 起始日期模式切换：选「指定日期」时才显示日期框
$("startDateMode").addEventListener("change", (e) => {
  $("startDate").hidden = e.target.value !== "fixed";
});

// ---------- 设置持久化：记住上次的选择（支持按书独立配置）----------
const SETTINGS_KEY = "popup_settings";          // 全局"上次使用"（无法定位到书时用）
const BY_BOOK_KEY = "popup_settings_by_book";   // { [bookId]: settings } 每本书专属
let currentBookId = null;                        // 当前番茄标签页对应的书 id（定位不到为 null）

// 从当前活动的番茄作者标签页 URL 提取 bookId
async function detectBookId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const m = (tab?.url || "").match(/\/main\/writer\/(?:chapter-manage\/)?(\d+)/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

// 设置作用域提示
function syncBookLabel() {
  const el = $("bookScope");
  if (!el) return;
  el.textContent = currentBookId ? `📕 本书专属 · #${currentBookId}` : "全局设置";
  el.title = currentBookId
    ? "已定位到当前番茄书，设置仅对本书生效"
    : "未在番茄『章节管理』页打开书，使用全局设置";
}

async function restoreSettings() {
  currentBookId = await detectBookId();
  const { [SETTINGS_KEY]: global, [BY_BOOK_KEY]: byBook } = await chrome.storage.local.get([SETTINGS_KEY, BY_BOOK_KEY]);
  // 优先本书专属；没有则用全局"上次使用"作为模板（首次配置一本书时不必从零开始）
  const s = (currentBookId && byBook && byBook[currentBookId]) || global;
  syncBookLabel();
  // 敏感词库（全局共享，与按书设置分开存）
  const { [WORDS_KEY]: words } = await chrome.storage.local.get(WORDS_KEY);
  sensitiveWords = Array.isArray(words) ? words : [];
  if (s) {
    if (s.publishMode) {
      const radio = document.querySelector(`input[name="mode"][value="${s.publishMode}"]`);
      if (radio) radio.checked = true;
    }
    if (s.dailyChapters) $("dailyChapters").value = s.dailyChapters;
    if (s.startHour) $("startHour").value = s.startHour;
    if (s.startDateMode) $("startDateMode").value = s.startDateMode;
    if (s.startDate) $("startDate").value = s.startDate;
    if (s.customStart) $("customStart").value = s.customStart;
    if (typeof s.autoRetry === "boolean") $("autoRetry").checked = s.autoRetry;
    if (s.pace) $("pace").value = String(s.pace);
    if (typeof s.humanize === "boolean") $("humanize").checked = s.humanize;
    if (s.gapMin != null) $("gapMin").value = s.gapMin;
    if (s.gapMax != null) $("gapMax").value = s.gapMax;
    if (s.minuteJitter != null) $("minuteJitter").value = s.minuteJitter;
    if (s.maxPerBatch != null) $("maxPerBatch").value = s.maxPerBatch;
    if (s.minWords != null) $("minWords").value = s.minWords;
    if (typeof s.nightAvoid === "boolean") $("nightAvoid").checked = s.nightAvoid;
    if (s.nightStart) $("nightStart").value = s.nightStart;
    if (s.nightEnd) $("nightEnd").value = s.nightEnd;
    if (s.detectionMode) $("fullDetection").checked = s.detectionMode === "full";
    if (s.useAI) $("useAI").value = s.useAI;
    if (typeof s.draftMode === "boolean") $("draftMode").checked = s.draftMode;
    if (typeof s.sensitiveCheck === "boolean") $("sensitiveCheck").checked = s.sensitiveCheck;
    // dryRun（试填模式）不恢复，每次默认关闭，避免下次静默不发布
  }
  // 同步各配置区的显隐
  const mode = currentMode();
  $("autoCfg").hidden = mode !== "auto";
  $("customCfg").hidden = mode !== "custom";
  $("startDate").hidden = $("startDateMode").value !== "fixed";
}

function saveSettings() {
  const s = collectSettings();
  chrome.storage.local.set({ [SETTINGS_KEY]: s }); // 全局"上次使用"（同步写）
  // 定位到书时，额外存一份本书专属（读-改-写 map，用户操作节奏下无竞态）
  if (currentBookId) {
    chrome.storage.local.get(BY_BOOK_KEY).then(({ [BY_BOOK_KEY]: byBook = {} }) => {
      byBook[currentBookId] = s;
      chrome.storage.local.set({ [BY_BOOK_KEY]: byBook });
    });
  }
}

// 任一设置项变化即保存；并在加载时恢复
document.querySelectorAll("#settings input, #settings select").forEach((el) =>
  el.addEventListener("change", () => { saveSettings(); renderPreview(); })
);
// 字数阈值改动时即时刷新列表标红（input 事件覆盖键入与微调）
$("minWords").addEventListener("input", () => { if (tasks.length) render(); });
// 敏感词开关切换时重扫列表
$("sensitiveCheck").addEventListener("change", () => { if (tasks.length) render(); });
// 编辑敏感词库：弹层里一行一词（或逗号/分号分隔），保存到 storage 并重扫
$("editWords").addEventListener("click", openWordEditor);
restoreSettings();

function openWordEditor() {
  const mask = document.createElement("div");
  mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center;";
  mask.innerHTML = `
    <div style="background:var(--bg,#fff);color:inherit;width:92%;max-height:86%;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;box-shadow:0 8px 30px rgba(0,0,0,.3);">
      <div style="font-weight:600;">🚫 敏感词库（共 <span id="wc">${sensitiveWords.length}</span> 词）</div>
      <div style="font-size:11px;color:var(--muted,#888);">一行一个词，也可用逗号/分号分隔。词库存在本地、对所有书生效。建议粘贴番茄公布的敏感词或自己的禁词清单。</div>
      <textarea id="ed-words" placeholder="例如：\n某敏感词\n另一个词" style="font:13px/1.6 system-ui;flex:1;min-height:240px;padding:8px;border:1px solid #ccc;border-radius:6px;resize:vertical;">${escapeHtml(sensitiveWords.join("\n"))}</textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button id="ew-cancel" class="ghost">取消</button>
        <button id="ew-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  mask.querySelector("#ew-cancel").addEventListener("click", close);
  mask.querySelector("#ew-save").addEventListener("click", async () => {
    const raw = mask.querySelector("#ed-words").value;
    // 按换行/逗号/分号/顿号切分，去空白去重
    sensitiveWords = [...new Set(raw.split(/[\n,，;；、]/).map((w) => w.trim()).filter(Boolean))];
    await chrome.storage.local.set({ [WORDS_KEY]: sensitiveWords });
    if (sensitiveWords.length && !$("sensitiveCheck").checked) { $("sensitiveCheck").checked = true; saveSettings(); }
    close();
    if (tasks.length) render();
    toast(`已保存 ${sensitiveWords.length} 个敏感词`);
  });
}

// #2.2 安全档位：一键套用一组反风控参数（间隔/偏移/上限/拟人/夜间避让）
const PRESETS = {
  conservative: { pace: "1.6", gapMin: 60, gapMax: 180, minuteJitter: 15, maxPerBatch: 8, humanize: true,  nightAvoid: true  },
  standard:     { pace: "1.6", gapMin: 30, gapMax: 90,  minuteJitter: 10, maxPerBatch: 0, humanize: true,  nightAvoid: false },
  fast:         { pace: "1",   gapMin: 8,  gapMax: 25,  minuteJitter: 5,  maxPerBatch: 0, humanize: true,  nightAvoid: false },
};
function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  $("pace").value = p.pace;
  $("gapMin").value = p.gapMin;
  $("gapMax").value = p.gapMax;
  $("minuteJitter").value = p.minuteJitter;
  $("maxPerBatch").value = p.maxPerBatch;
  $("humanize").checked = p.humanize;
  $("nightAvoid").checked = p.nightAvoid;
  document.querySelectorAll(".preset").forEach((b) => b.classList.toggle("on", b.dataset.preset === name));
  syncNightRow();
  saveSettings();
  renderPreview();
}
document.querySelectorAll(".preset").forEach((b) =>
  b.addEventListener("click", () => applyPreset(b.dataset.preset))
);
// 夜间时段子行：仅在开启夜间避让时显示
function syncNightRow() { const r = $("nightRow"); if (r) r.hidden = !$("nightAvoid").checked; }
$("nightAvoid").addEventListener("change", syncNightRow);
syncNightRow();

// 收集发布设置
function collectSettings() {
  return {
    publishMode: currentMode(),                       // immediate | auto | custom
    dailyChapters: Math.max(1, Math.min(12, +$("dailyChapters").value || 1)),
    startHour: $("startHour").value || "06:00",        // 每日起始时刻（当天内均分的基准）
    startDateMode: $("startDateMode").value,           // auto | fixed | tomorrow
    startDate: $("startDate").value || null,           // 指定起始日期(YYYY-MM-DD)
    customStart: $("customStart").value || null,       // 自定义首章时间(datetime-local)
    autoRetry: $("autoRetry").checked,
    maxRetries: 3,
    pace: Number($("pace").value) || 1,                // 操作节奏倍率（>1 更慢更稳）
    humanize: $("humanize").checked,                   // 拟人随机延迟（反识别）
    gapMin: Math.max(0, +$("gapMin").value || 5),      // 章节间隔随机下限（秒）
    gapMax: Math.max(1, +$("gapMax").value || 20),     // 章节间隔随机上限（秒）
    minuteJitter: Math.max(0, +$("minuteJitter").value || 0), // 发布时间随机偏移±分钟
    maxPerBatch: Math.max(0, +$("maxPerBatch").value || 0),   // 本次发布量上限（0=不限）
    minWords: Math.max(0, +$("minWords").value || 0),         // 字数偏短提醒阈值（0=关，仅前端提醒）
    nightAvoid: $("nightAvoid").checked,                // #2.3 夜间避让：跳过夜间档位
    nightStart: $("nightStart").value || "23:00",       // 夜间时段起
    nightEnd: $("nightEnd").value || "07:00",           // 夜间时段止
    detectionMode: $("fullDetection").checked ? "full" : "basic", // 内容检测方式
    useAI: $("useAI").value,                            // 是否使用AI声明: no | yes
    draftMode: $("draftMode").checked,                  // 仅存草稿：点下一步建章后取消发布
    sensitiveCheck: $("sensitiveCheck").checked,        // 敏感词预检开关（词库另存 WORDS_KEY）
    dryRun: $("dryRun").checked,                        // 试填模式：只填表不发布
  };
}

async function onFolderPicked(e) {
  const files = [...e.target.files].filter((f) => /\.(txt|md|markdown)$/i.test(f.name));
  if (!files.length) {
    alert("该文件夹下没有 .txt / .md 文件");
    return;
  }
  // 文件夹名（webkitRelativePath 形如 "我的小说/第1章.txt"）= 书名
  folderName = files[0].webkitRelativePath.split("/")[0] || "已选择";
  $("folderName").textContent = folderName;

  // 按文件名里的章节号排序，保证上传顺序正确
  files.sort((a, b) => (numFromName(a.name) || 0) - (numFromName(b.name) || 0));

  tasks = [];
  for (const f of files) {
    const raw = (await f.text()).replace(/\r\n/g, "\n").trim();
    const { title, content } = splitTitleBody(raw, f.name);
    const chapterNumber = numFromName(f.name) || numFromText(raw);
    tasks.push({
      id: cryptoId(),
      fileName: f.name,
      title,
      chapterNumber,
      content,
      wordCount: content.replace(/\s/g, "").length,
      selected: true,
    });
  }
  render();
  // 自动剔除已发布章节（仅当当前正停在番茄书页面时；静默，有移除才提示）
  const auto = await fetchPublishedFromPage();
  if (auto.ok && auto.list.length) {
    const n = dropPublished(auto.list);
    if (n) toast(`已自动移除 ${n} 章已发布的，仅保留待发`);
  }
}

// ---------- 移除已发布章节：读取当前番茄书的已发列表，从本地任务里剔除 ----------
function sameTitleLoose(a, b) {
  const norm = (s) => (s || "").replace(/^\s*第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*章[\s：:、.．·\-]*/, "").trim();
  const x = norm(a), y = norm(b);
  return !!x && (x === y || x.includes(y) || y.includes(x));
}

async function fetchPublishedFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/fanqienovel\.com\/main\/writer/.test(tab.url || "")) return { ok: false, reason: "no-tab" };
  try {
    const list = await chrome.tabs.sendMessage(tab.id, { type: "GET_PUBLISHED" });
    return { ok: true, list: Array.isArray(list) ? list : [] };
  } catch {
    return { ok: false, reason: "no-cs" };
  }
}

function dropPublished(published) {
  const before = tasks.length;
  tasks = tasks.filter((t) => !published.some((p) =>
    (t.chapterNumber && p.chapterNumber === t.chapterNumber) || sameTitleLoose(p.title, t.title)
  ));
  const removed = before - tasks.length;
  if (removed) render();
  return removed;
}

// 手动按钮：明确反馈每种情况
$("removePublished").addEventListener("click", async () => {
  const btn = $("removePublished");
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "读取中…";
  const r = await fetchPublishedFromPage();
  btn.disabled = false; btn.textContent = old;
  if (!r.ok && r.reason === "no-tab") return toast("请先在番茄『章节管理』页打开你的书");
  if (!r.ok) return toast("读取失败，请刷新番茄页面后重试");
  if (!r.list.length) return toast("没读到已发布章节（这本书可能还没发过）");
  const removed = dropPublished(r.list);
  toast(removed ? `已移除 ${removed} 章已发布的` : "列表里没有已发布的章节");
});

// 轻量 toast（动态创建，无需改 HTML）
let toastTimer = null;
function toast(msg) {
  let el = $("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function render() {
  const list = $("list");
  $("removePublished").hidden = !tasks.length; // 有章节才显示"移除已发布"
  if (!tasks.length) {
    list.innerHTML = '<div class="empty">尚未选择文件夹</div>';
    $("count").textContent = "未加载";
    $("start").disabled = true;
    return;
  }
  const minWords = +$("minWords").value || 0;
  list.innerHTML = "";
  tasks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "item";
    const short = minWords > 0 && t.wordCount < minWords; // 正文偏短：多半解析出错/残章
    const hits = scanSensitive(t); // 敏感词命中
    const flag = hits.length ? `<span class="flag" title="命中敏感词：${escapeHtml(hits.join("、"))}">🚫</span>` : "";
    row.innerHTML = `
      <input type="checkbox" ${t.selected ? "checked" : ""} data-i="${i}" />
      ${flag}
      <span class="title" title="${escapeHtml(t.title)}">第${t.chapterNumber || "?"}章 · ${escapeHtml(t.title)}</span>
      <span class="meta${short ? " short" : ""}" title="${short ? `正文仅 ${t.wordCount} 字，少于阈值 ${minWords}，请检查是否解析出错` : ""}">${short ? "⚠️ " : ""}${t.wordCount}字</span>
      <button class="edit" data-i="${i}" title="预览/编辑" style="border:none;background:none;cursor:pointer;font-size:14px;padding:0 4px;">✏️</button>`;
    row.querySelector('input[type="checkbox"]').addEventListener("change", (e) => {
      tasks[+e.target.dataset.i].selected = e.target.checked;
      updateCount();
    });
    row.querySelector(".edit").addEventListener("click", (e) => openEditor(+e.currentTarget.dataset.i));
    list.appendChild(row);
  });
  updateCount();
  $("start").disabled = false;
}

function updateCount() {
  const sel = tasks.filter((t) => t.selected).length;
  const minWords = +$("minWords").value || 0;
  const shortSel = minWords > 0 ? tasks.filter((t) => t.selected && t.wordCount < minWords).length : 0;
  const hitSel = tasks.filter((t) => t.selected && scanSensitive(t).length).length;
  $("count").textContent = `已选 ${sel} / 共 ${tasks.length} 章`
    + (shortSel ? ` · ⚠️${shortSel}章偏短` : "")
    + (hitSel ? ` · 🚫${hitSel}章含敏感词` : "");
  renderPreview();
}

// #4 排期预览：按当前设置算出每章发布时间（与 uploader.computePublishTime 同算法）
function renderPreview() {
  const box = $("previewBox");
  const s = collectSettings();
  const selected = tasks.filter((t) => t.selected);
  // 草稿模式不发布、不排期；立即模式无需预览
  if (!selected.length || s.draftMode || s.publishMode === "immediate") {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  let baseNote = "";
  let startDate;
  if (s.publishMode === "auto") {
    if (s.startDateMode === "fixed" && s.startDate) startDate = new Date(s.startDate + "T00:00:00");
    else { startDate = new Date(); startDate.setDate(startDate.getDate() + 1); startDate.setHours(0, 0, 0, 0); }
    if (s.startDateMode === "auto") baseNote = "（自动接续：实际起始日以发布页已排期为准，下表按「明天」估算）";
  }
  const rows = selected.map((t, i) => {
    let when;
    if (s.publishMode === "custom" && s.customStart) {
      const d = new Date(s.customStart); d.setHours(d.getHours() + i); when = fmtDT(d);
    } else {
      const N = Math.max(1, s.dailyChapters || 1);
      const [hh, mm] = (s.startHour || "06:00").split(":").map(Number);
      const step = Math.floor(1440 / N);
      const d = new Date(startDate);
      d.setDate(d.getDate() + Math.floor(i / N));
      d.setMinutes(hh * 60 + mm + (i % N) * step);
      when = fmtDT(d) + (s.minuteJitter ? ` ±${s.minuteJitter}分` : "");
    }
    return `<div>第${t.chapterNumber || "?"}章 · ${escapeHtml(t.title).slice(0, 12)} → <b>${when}</b></div>`;
  });
  $("preview").innerHTML = (baseNote ? `<div style="color:#f39c12;margin-bottom:4px;">${baseNote}</div>` : "") + rows.join("");
}

function fmtDT(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// #6 章节预览/编辑：弹层里改标题/正文，保存回 tasks（发前纠错，避免解析错了直接发）
function openEditor(i) {
  const t = tasks[i];
  if (!t) return;
  const mask = document.createElement("div");
  mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center;";
  mask.innerHTML = `
    <div style="background:var(--bg,#fff);color:inherit;width:92%;max-height:86%;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;box-shadow:0 8px 30px rgba(0,0,0,.3);">
      <div style="font-weight:600;">✏️ 编辑第${t.chapterNumber || "?"}章</div>
      <input id="ed-title" value="${escapeHtml(t.title)}" style="font:inherit;padding:6px 8px;border:1px solid #ccc;border-radius:6px;" />
      <textarea id="ed-content" style="font:13px/1.6 system-ui;flex:1;min-height:240px;padding:8px;border:1px solid #ccc;border-radius:6px;resize:vertical;">${escapeHtml(t.content)}</textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button id="ed-cancel" class="ghost">取消</button>
        <button id="ed-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  mask.querySelector("#ed-cancel").addEventListener("click", close);
  mask.querySelector("#ed-save").addEventListener("click", () => {
    t.title = mask.querySelector("#ed-title").value.trim() || t.title;
    t.content = mask.querySelector("#ed-content").value;
    t.wordCount = t.content.replace(/\s/g, "").length;
    close();
    render();
  });
}

async function onStart() {
  const selected = tasks.filter((t) => t.selected);
  if (!selected.length) {
    alert("请先勾选要上传的章节");
    return;
  }
  const sessionId = "s_" + cryptoId();
  const resp = await chrome.runtime.sendMessage({
    type: "START_UPLOAD",
    data: { tasks: selected, sessionId, settings: collectSettings(), folderName },
  });
  alert(resp?.message || "上传会话已启动");
  window.close();
}

// ---------- 解析工具 ----------
function numFromName(name) {
  // 优先「第N章」：避免被文件名里的其它数字（年份/版本号如 "2024第5章"、"v2第3章"）带偏
  const zh = name.match(/第\s*(\d+)\s*章/);
  if (zh) return parseInt(zh[1], 10);
  // 中文数字章节名（第二十章 / 第一百零五章）——排序与章节号框都靠它
  const cn = name.match(/第\s*([零〇一二两三四五六七八九十百千]+)\s*章/);
  if (cn) { const n = cnToInt(cn[1]); if (n) return n; }
  // 退而求其次：取第一个数字（兼容 "001.txt"、"5 标题.txt" 这类纯数字命名）
  const m = name.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function numFromText(text) {
  const head = text.slice(0, 50);
  const m = head.match(/第\s*(\d+)\s*章/);
  if (m) return parseInt(m[1], 10);
  const cn = head.match(/第\s*([零〇一二两三四五六七八九十百千]+)\s*章/);
  return cn ? cnToInt(cn[1]) : null;
}
// 中文数字 → 整数（二十→20、三十九→39、一百零五→105、两百→200）；含非法字符返回 null
function cnToInt(s) {
  const digit = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unit = { 十: 10, 百: 100, 千: 1000 };
  let total = 0, cur = 0;
  for (const ch of s || "") {
    if (ch in digit) cur = digit[ch];
    else if (ch in unit) { total += (cur || 1) * unit[ch]; cur = 0; }
    else return null;
  }
  return total + cur;
}
// 把一篇文档拆成「标题 + 正文」，并清理 Markdown 标记
// 规则：首个非空行当标题（清掉 # / ** 等）；其余为正文。
//      若首行太长(>40字)更像正文，则用文件名当标题、整篇当正文。
function splitTitleBody(raw, fileName) {
  const baseName = fileName.replace(/\.(txt|md|markdown)$/i, "");
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => l.trim());
  if (idx === -1) return { title: baseName, content: "" };

  const firstLine = cleanInline(lines[idx]);
  if (firstLine.length > 40) {
    return { title: baseName, content: stripMd(raw) };
  }
  const body = lines.slice(idx + 1).join("\n").trim();
  return { title: firstLine || baseName, content: stripMd(body) };
}

// 清理单行里的 Markdown 标记（标题井号、引用、加粗、斜体）
function cleanInline(line) {
  return (line || "")
    .trim()
    .replace(/^#{1,6}\s*/, "")        // # 标题
    .replace(/^>\s?/, "")             // > 引用
    .replace(/\*\*(.+?)\*\*/g, "$1")  // **加粗**
    .replace(/\*(.+?)\*/g, "$1")      // *斜体*
    .replace(/`/g, "")                // 行内代码
    .trim();
}

// 逐行清理正文里的 Markdown 标记，保留段落结构
function stripMd(text) {
  return text
    .split("\n")
    .map((l) => cleanInline(l))
    .join("\n")
    .trim();
}
function cryptoId() {
  return Math.random().toString(36).slice(2, 10);
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
