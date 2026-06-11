// ============================================================
//  sidepanel/sidepanel.js — 实时上传进度面板
//  从 chrome.storage 读 upload_session 渲染，storage 变化时实时刷新。
//  「停止」按钮写入 upload_control=stop，调度器会在下一章前停下。
// ============================================================

const $ = (id) => document.getElementById(id);

$("stop").addEventListener("click", async () => {
  await chrome.storage.local.set({ upload_control: "stop" });
  $("stop").disabled = true;
  $("stop").textContent = "⏹ 已请求停止…";
});

function render(session) {
  const list = $("list");
  if (!session || !session.tasks?.length) {
    list.innerHTML = '<div class="empty">暂无上传任务</div>';
    $("summary").innerHTML = "";
    $("proj").textContent = "";
    $("barfill").style.width = "0%";
    $("stop").disabled = true;
    return;
  }

  const tasks = session.tasks;
  const done = tasks.filter((t) => t.status === "uploaded").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const pending = tasks.length - done - failed;

  $("proj").textContent = `共 ${tasks.length} 章 · 状态：${statusLabel(session.status)}`;
  $("summary").innerHTML =
    `<span class="chip done">✅ 完成 ${done}</span>` +
    `<span class="chip failed">❌ 失败 ${failed}</span>` +
    `<span class="chip pending">⏳ 待发 ${pending}</span>`;
  $("barfill").style.width = Math.round((done / tasks.length) * 100) + "%";

  // 停止按钮：仅在进行中可用
  const running = session.status !== "completed" && session.status !== "stopped";
  $("stop").disabled = !running;
  if (running) { $("stop").textContent = "⏹ 停止上传"; }

  list.innerHTML = "";
  tasks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "item";
    const cur = i === session.currentIndex && running ? "▶ " : "";
    row.innerHTML =
      `<span class="t" title="${esc(t.title)}">${cur}第${t.chapterNumber || "?"}章 · ${esc(t.title)}</span>` +
      (t.publishTime && t.publishTime !== "now"
        ? `<span class="time">${fmt(t.publishTime)}</span>` : "") +
      `<span class="badge ${badgeClass(t.status)}">${badgeText(t.status)}</span>`;
    list.appendChild(row);
  });
}

function statusLabel(s) {
  return { preparing: "准备中", uploading: "上传中", completed: "已完成", stopped: "已停止" }[s] || s || "—";
}
function badgeClass(s) { return s === "uploaded" ? "uploaded" : s === "failed" ? "failed" : "pending"; }
function badgeText(s) { return s === "uploaded" ? "✅ 已发" : s === "failed" ? "❌ 失败" : "⏳ 待发"; }

function fmt(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ""; }
}
function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 初次加载 + 监听 storage 变化实时刷新
chrome.storage.local.get("upload_session").then((r) => render(r.upload_session));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.upload_session) render(changes.upload_session.newValue);
});
