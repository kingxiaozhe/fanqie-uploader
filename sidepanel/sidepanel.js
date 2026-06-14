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

// 重发失败章节：把 failed 任务重置为待发，从头跑（已发的会被同步跳过，防重复仍生效）
$("retryFailed").addEventListener("click", async () => {
  const { upload_session: s } = await chrome.storage.local.get("upload_session");
  if (!s || !s.tasks) return;
  let count = 0;
  s.tasks.forEach((t) => {
    if (t.status === "failed") { delete t.status; count++; }
  });
  if (!count) return;
  s.retries = {};
  s.currentIndex = 0;
  s.runCount = 0;
  s.status = "preparing";
  await chrome.storage.local.remove("upload_control");
  await chrome.storage.local.set({ upload_session: s });
  chrome.runtime.sendMessage({ type: "RESUME_UPLOAD" });
  $("retryFailed").textContent = `🔁 已重新排队 ${count} 章`;
  $("retryFailed").disabled = true;
});

// #7 导出发布报告（CSV，可用 Excel 打开对账）
$("exportReport").addEventListener("click", async () => {
  const { upload_session: s } = await chrome.storage.local.get("upload_session");
  if (!s || !s.tasks?.length) { alert("暂无任务可导出"); return; }
  const label = (st) => (st === "uploaded" ? "已发布" : st === "failed" ? "失败" : "待发布");
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const head = "章节号,标题,状态,计划发布时间,字数\n";
  const body = s.tasks.map((t) =>
    [t.chapterNumber, t.title, label(t.status), t.publishTime && t.publishTime !== "now" ? t.publishTime : "立即/未排", t.wordCount || ""]
      .map(esc).join(",")
  ).join("\n");
  const blob = new Blob(["﻿" + head + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `发布报告_${s.folderName || "novel"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// 一键导出运行日志（.txt），给开发者排查用
$("exportLog").addEventListener("click", async () => {
  const { fq_logs = [] } = await chrome.storage.local.get("fq_logs");
  if (!fq_logs.length) { alert("暂无日志"); return; }
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const lines = fq_logs.map((e) => `${fmt(e.t)} [${e.src}] ${e.text}`).join("\n");
  const ua = navigator.userAgent;
  const header = `番茄发布助手 运行日志\n导出时间: ${new Date().toLocaleString()}\nUA: ${ua}\n共 ${fq_logs.length} 条\n${"=".repeat(40)}\n`;
  const blob = new Blob([header + lines], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `运行日志_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
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

  // 重发按钮：有失败章节且不在运行中时可用
  $("retryFailed").disabled = !(failed > 0 && !running);
  if (failed > 0 && !running) $("retryFailed").textContent = `🔁 重发失败章节 (${failed})`;

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
