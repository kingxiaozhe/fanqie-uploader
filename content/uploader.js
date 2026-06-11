// ============================================================
//  content/uploader.js — 调度器（注入到番茄作者后台所有 writer 页面）
//  职责：
//   1) 在"章节管理页"先【同步】已发布章节，跳过重复
//   2) 按顺序为每个待发布章节计算【发布时间】并开发布标签页
//   3) 串行处理：等本章发布完成再下一章；失败按设置【自动重试】
//  这是整套流程的"大脑"。
// ============================================================

(function () {
  "use strict";

  let session = null;   // { sessionId, tasks, settings, currentIndex, retries, status }
  let indicator = null; // 右上角状态浮标
  let busy = false;

  init();

  async function init() {
    console.log("🚀 番茄上传调度器已加载:", location.href);
    createIndicator();

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "TASK_DONE") onTaskDone(msg.taskId);
      else if (msg.type === "TASK_FAILED") onTaskFailed(msg.taskId);
      sendResponse?.({ success: true });
      return true;
    });

    const { upload_session } = await chrome.storage.local.get("upload_session");
    session = upload_session || null;

    // 监听 SPA 路由变化（番茄是单页应用）
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(detectAndAct, 800);
      }
    }).observe(document, { subtree: true, childList: true });

    detectAndAct();
  }

  function detectAndAct() {
    if (!session || session.status === "completed") return;
    if (/\/main\/writer\/chapter-manage\/\d+/.test(location.href)) {
      startUpload();
    } else {
      setIndicator("📚 请进入你要上传的小说『章节管理』页面", "info");
    }
  }

  async function startUpload() {
    if (busy) return;
    busy = true;

    // ① 先同步：把页面上已存在的章节标记为已上传，避免重复发
    await delay(1500); // 等表格渲染
    const synced = syncUploadedChapters();
    if (synced > 0) {
      setIndicator(`🔄 已同步 ${synced} 章为"已上传"，将跳过`, "info");
      await saveSession();
      await delay(1200);
    }

    const pending = session.tasks.filter((t) => t.status !== "uploaded").length;
    setIndicator(`🚀 准备上传 ${pending} 章（共 ${session.tasks.length}）`, "info");
    await processNext();
  }

  // ---------- 串行处理 ----------
  async function processNext() {
    if (!session) return;

    // 跳过已上传的章节
    while (session.currentIndex < session.tasks.length &&
           session.tasks[session.currentIndex].status === "uploaded") {
      session.currentIndex += 1;
    }

    const i = session.currentIndex;
    if (i >= session.tasks.length) {
      session.status = "completed";
      await saveSession();
      const ok = session.tasks.filter((t) => t.status === "uploaded").length;
      setIndicator(`✅ 全部完成！成功 ${ok}/${session.tasks.length} 章`, "success");
      chrome.runtime.sendMessage({ type: "NOTIFY", message: `上传结束：成功 ${ok}/${session.tasks.length} 章` });
      busy = false;
      return;
    }

    const task = session.tasks[i];
    task.publishTime = computePublishTime(i); // 按发布模式算出本章时间
    setIndicator(`📝 第 ${i + 1}/${session.tasks.length} 章：${task.title}`, "info");
    await saveSession();

    const publishUrl = buildPublishUrl();
    if (!publishUrl) {
      setIndicator("❌ 未找到『新建章节』入口，请刷新页面重试", "error");
      busy = false;
      return;
    }

    chrome.runtime.sendMessage({
      type: "OPEN_PUBLISH_TAB",
      data: { url: publishUrl, task, sessionId: session.sessionId },
    });
  }

  async function onTaskDone(taskId) {
    if (!session) return;
    const t = session.tasks.find((x) => x.id === taskId);
    if (t) t.status = "uploaded";
    console.log("✅ 本章完成:", taskId);
    session.currentIndex += 1;
    await saveSession();
    setTimeout(processNext, 1000);
  }

  async function onTaskFailed(taskId) {
    if (!session) return;
    const s = session.settings || {};
    const used = session.retries[taskId] || 0;

    if (s.autoRetry && used < (s.maxRetries || 3)) {
      session.retries[taskId] = used + 1;
      await saveSession();
      setIndicator(`🔁 第 ${session.currentIndex + 1} 章失败，重试 ${used + 1}/${s.maxRetries || 3}`, "warning");
      setTimeout(processNext, 1500); // 不前进 index，重发当前章
      return;
    }

    const t = session.tasks.find((x) => x.id === taskId);
    if (t) t.status = "failed";
    console.warn("❌ 本章最终失败，跳过:", taskId);
    session.currentIndex += 1;
    await saveSession();
    setTimeout(processNext, 1000);
  }

  // ---------- 发布时间计算 ----------
  // 返回 'now'（立即）或 ISO 字符串（定时）
  function computePublishTime(index) {
    const s = session.settings || {};
    if (s.publishMode === "immediate" || !s.publishMode) return "now";

    if (s.publishMode === "custom" && s.customStart) {
      // 首章 = customStart，后续每小时一章
      const base = new Date(s.customStart);
      base.setHours(base.getHours() + index);
      return base.toISOString();
    }

    if (s.publishMode === "auto") {
      // 每天 dailyChapters 章，从 startHour 起，按小时递增
      const daily = s.dailyChapters || 3;
      const [hh, mm] = (s.startHour || "10:00").split(":").map(Number);
      const day = Math.floor(index / daily);
      const slot = index % daily;
      const d = new Date();
      d.setHours(hh, mm, 0, 0);
      // 今天该时段已过，则从明天开始
      if (day === 0 && Date.now() > d.getTime()) d.setDate(d.getDate() + 1);
      else d.setDate(d.getDate() + day);
      d.setHours(d.getHours() + slot);
      return d.toISOString();
    }
    return "now";
  }

  // ---------- 同步已上传章节 ----------
  // 抓取章节管理页表格，按章节号/标题匹配，把对应任务标记为 uploaded。
  // 注意：脚手架只读当前页；多分页可扩展为隐藏 iframe 逐页抓取。
  function syncUploadedChapters() {
    const published = scrapePublishedChapters();
    if (!published.length) return 0;

    let count = 0;
    for (const task of session.tasks) {
      if (task.status === "uploaded") continue;
      const hit = published.find((p) =>
        (task.chapterNumber && p.chapterNumber === task.chapterNumber) ||
        sameTitle(p.title, task.title)
      );
      if (hit) {
        task.status = "uploaded";
        count++;
      }
    }
    console.log(`🔄 同步：页面已发布 ${published.length} 章，匹配标记 ${count} 章`);
    return count;
  }

  function scrapePublishedChapters() {
    const out = [];
    const rows = document.querySelectorAll("tbody .arco-table-tr");
    for (const row of rows) {
      const titleEl = row.querySelector(".table-title");
      const title = titleEl?.textContent?.trim();
      if (!title) continue;
      const m = title.match(/第(\d+)章/);
      out.push({ title, chapterNumber: m ? parseInt(m[1], 10) : null });
    }
    return out;
  }

  function sameTitle(a, b) {
    const norm = (s) => (s || "").replace(/^第\d+章[：:]\s*/, "").trim();
    const x = norm(a), y = norm(b);
    return !!x && (x === y || x.includes(y) || y.includes(x));
  }

  // ---------- 发布页 URL ----------
  function buildPublishUrl() {
    const link = document.querySelector('a[href*="/publish/?enter_from=newchapter"], a[href*="/publish/"]');
    if (link) {
      let href = link.getAttribute("href") || "";
      if (href && !href.startsWith("http")) href = "https://fanqienovel.com" + href;
      if (href) return href;
    }
    const m = location.href.match(/\/main\/writer\/chapter-manage\/(\d+)/);
    if (m) return `https://fanqienovel.com/main/writer/${m[1]}/publish/?enter_from=newchapter`;
    return null;
  }

  async function saveSession() {
    await chrome.storage.local.set({ upload_session: session });
  }

  // ---------- 状态浮标 ----------
  function createIndicator() {
    if (indicator) return;
    indicator = document.createElement("div");
    indicator.id = "fq-uploader-indicator";
    indicator.style.cssText = `
      position:fixed;top:20px;left:20px;z-index:99999;
      background:#3498db;color:#fff;padding:12px 16px;border-radius:8px;
      font:500 13px/1.4 system-ui;max-width:320px;display:none;
      box-shadow:0 4px 12px rgba(0,0,0,.3);transition:all .3s ease;`;
    document.body.appendChild(indicator);
  }

  function setIndicator(text, level = "info") {
    if (!indicator) return;
    const colors = { info: "#3498db", success: "#27ae60", warning: "#f39c12", error: "#e74c3c" };
    indicator.textContent = text;
    indicator.style.background = colors[level] || colors.info;
    indicator.style.display = "block";
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
