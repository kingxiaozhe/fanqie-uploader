// ============================================================
//  popup/popup.js — 弹窗 UI 逻辑
//  选文件夹 → 解析 .txt 章节 → 生成任务列表 → 勾选 → 开始上传
// ============================================================

let tasks = []; // [{ id, fileName, title, chapterNumber, content, wordCount, selected }]

const $ = (id) => document.getElementById(id);

$("pick").addEventListener("click", () => $("folder").click());
$("folder").addEventListener("change", onFolderPicked);
$("selectAll").addEventListener("change", (e) => {
  tasks.forEach((t) => (t.selected = e.target.checked));
  render();
});
$("start").addEventListener("click", onStart);

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

// 收集发布设置
function collectSettings() {
  return {
    publishMode: currentMode(),                       // immediate | auto | custom
    dailyChapters: Math.max(1, Math.min(10, +$("dailyChapters").value || 3)),
    startHour: $("startHour").value || "10:00",        // 智能定时的每日起始时刻
    customStart: $("customStart").value || null,       // 自定义首章时间(datetime-local)
    autoRetry: $("autoRetry").checked,
    maxRetries: 3,
    dryRun: $("dryRun").checked,                        // 试填模式：只填表不发布
  };
}

async function onFolderPicked(e) {
  const files = [...e.target.files].filter((f) => f.name.toLowerCase().endsWith(".txt"));
  if (!files.length) {
    alert("该文件夹下没有 .txt 文件");
    return;
  }
  // 文件夹名（webkitRelativePath 形如 "我的小说/第1章.txt"）
  const folderName = files[0].webkitRelativePath.split("/")[0] || "已选择";
  $("folderName").textContent = folderName;

  // 按文件名里的章节号排序，保证上传顺序正确
  files.sort((a, b) => (numFromName(a.name) || 0) - (numFromName(b.name) || 0));

  tasks = [];
  for (const f of files) {
    const content = (await f.text()).trim();
    const chapterNumber = numFromName(f.name) || numFromText(content);
    const title = titleFrom(f.name, content, chapterNumber);
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
}

function render() {
  const list = $("list");
  if (!tasks.length) {
    list.innerHTML = '<div class="empty">尚未选择文件夹</div>';
    $("count").textContent = "未加载";
    $("start").disabled = true;
    return;
  }
  list.innerHTML = "";
  tasks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <input type="checkbox" ${t.selected ? "checked" : ""} data-i="${i}" />
      <span class="title" title="${escapeHtml(t.title)}">第${t.chapterNumber || "?"}章 · ${escapeHtml(t.title)}</span>
      <span class="meta">${t.wordCount}字</span>`;
    row.querySelector("input").addEventListener("change", (e) => {
      tasks[+e.target.dataset.i].selected = e.target.checked;
      updateCount();
    });
    list.appendChild(row);
  });
  updateCount();
  $("start").disabled = false;
}

function updateCount() {
  const sel = tasks.filter((t) => t.selected).length;
  $("count").textContent = `已选 ${sel} / 共 ${tasks.length} 章`;
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
    data: { tasks: selected, sessionId, settings: collectSettings() },
  });
  alert(resp?.message || "上传会话已启动");
  window.close();
}

// ---------- 解析工具 ----------
function numFromName(name) {
  const m = name.match(/(?:第)?(\d+)(?:章)?/);
  return m ? parseInt(m[1], 10) : null;
}
function numFromText(text) {
  const m = text.slice(0, 50).match(/第(\d+)章/);
  return m ? parseInt(m[1], 10) : null;
}
function titleFrom(fileName, content, num) {
  // 优先用正文首行作标题，否则用去掉扩展名的文件名
  const firstLine = content.split("\n")[0]?.trim() || "";
  if (firstLine && firstLine.length <= 40) return firstLine;
  return fileName.replace(/\.txt$/i, "");
}
function cryptoId() {
  return Math.random().toString(36).slice(2, 10);
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
