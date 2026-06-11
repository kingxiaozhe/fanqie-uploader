// ============================================================
//  content/uploader.js — 调度器（注入到番茄作者后台所有 writer 页面）
//  职责：在"章节管理页"找到【新建章节】入口，按顺序为每个待发布
//  章节开一个发布标签页，等它发布完成后再处理下一章（串行）。
//  这是整套流程的"大脑"。
// ============================================================

(function () {
  "use strict";

  let session = null;       // { sessionId, tasks, currentIndex, status }
  let indicator = null;     // 右上角状态浮标
  let busy = false;         // 防止重复触发串行流程

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

    // 读取已存在的会话
    const { upload_session } = await chrome.storage.local.get("upload_session");
    session = upload_session || null;

    // 监听 SPA 路由变化（番茄是单页应用，跳转不刷新页面）
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(detectAndAct, 800);
      }
    }).observe(document, { subtree: true, childList: true });

    detectAndAct();
  }

  // 当前在哪个页面？只在"章节管理页"才启动上传
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
    setIndicator(`🚀 准备上传 ${session.tasks.length} 章`, "info");
    await processNext();
  }

  // 处理 currentIndex 指向的章节
  async function processNext() {
    if (!session) return;
    const i = session.currentIndex;
    if (i >= session.tasks.length) {
      session.status = "completed";
      await saveSession();
      setIndicator("✅ 全部章节上传完成！", "success");
      chrome.runtime.sendMessage({ type: "NOTIFY", message: `已完成 ${session.tasks.length} 章上传` });
      busy = false;
      return;
    }

    const task = session.tasks[i];
    setIndicator(`📝 正在上传第 ${i + 1}/${session.tasks.length} 章：${task.title}`, "info");

    const publishUrl = buildPublishUrl();
    if (!publishUrl) {
      setIndicator("❌ 未找到『新建章节』入口，请刷新页面重试", "error");
      busy = false;
      return;
    }

    // 请后台开一个发布标签页；完成信号会通过 onTaskDone 回来
    chrome.runtime.sendMessage({
      type: "OPEN_PUBLISH_TAB",
      data: { url: publishUrl, task, sessionId: session.sessionId },
    });
  }

  async function onTaskDone(taskId) {
    if (!session) return;
    console.log("✅ 收到本章完成:", taskId);
    session.currentIndex += 1;
    await saveSession();
    setTimeout(processNext, 1000); // 略等标签页关闭、页面稳定
  }

  async function onTaskFailed(taskId) {
    if (!session) return;
    console.warn("❌ 本章失败，跳过:", taskId);
    session.currentIndex += 1;
    await saveSession();
    setTimeout(processNext, 1000);
  }

  // 根据当前小说 ID 拼出发布页 URL；优先直接用页面上的【新建章节】链接
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
})();
