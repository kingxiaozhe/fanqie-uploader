// ============================================================
//  background.js — Service Worker（后台编排）
//  职责：消息总线 + 开/关标签页 + 桌面通知
//  它本身不碰页面 DOM，只负责"开一个标签页、把数据喂给对应的
//  content script、收到完成信号后关掉标签页"。
// ============================================================

const FANQIE_WRITER = "https://fanqienovel.com/main/writer";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 用一个 async IIFE 包起来，统一 return true 保持消息通道开启
  (async () => {
    try {
      switch (msg.type) {
        // 1) popup 点"开始上传"：保存会话，打开/聚焦番茄作者后台
        case "START_UPLOAD":
          await handleStartUpload(msg.data, sendResponse);
          break;

        // 2) 调度器(uploader)请求为某个章节开一个发布标签页
        case "OPEN_PUBLISH_TAB":
          await handleOpenPublishTab(msg.data, sendResponse);
          break;

        // 2b) 发布页(publisher)加载好后主动来拉取自己的章节任务（规避推送竞态）
        case "REQUEST_TASK": {
          const tabId = sender.tab?.id;
          const key = "publish_task_" + tabId;
          const got = await chrome.storage.local.get(key);
          if (got[key]) {
            await chrome.storage.local.remove(key);
            sendResponse({ success: true, task: got[key].task, sessionId: got[key].sessionId });
          } else {
            sendResponse({ success: false });
          }
          break;
        }

        // 3) 发布器(publisher)发布完成，请求关闭自己的标签页
        case "CLOSE_TAB":
          if (sender.tab?.id) {
            try { await chrome.tabs.remove(sender.tab.id); } catch (_) {}
          }
          sendResponse({ success: true });
          break;

        // 4) 发布器通知"本章完成"——转发给调度器所在的标签页，驱动它处理下一章
        case "TASK_DONE":
        case "TASK_FAILED":
          await relayToUploaderTab(msg);
          sendResponse({ success: true });
          break;

        // 内容脚本转发的日志，集中打印到后台控制台（调试用）
        case "LOG":
          console.log(`[${msg.src || "cs"}]`, msg.text);
          sendResponse({ success: true });
          break;

        case "NOTIFY":
          chrome.notifications.create({
            type: "basic",
            iconUrl: "icon.png",
            title: "番茄上传器",
            message: msg.message || "",
          });
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ success: false, error: "未知消息类型: " + msg.type });
      }
    } catch (e) {
      console.error("[bg] 处理消息失败:", e);
      sendResponse({ success: false, error: String(e?.message || e) });
    }
  })();
  return true; // 异步响应
});

// ---- 开始上传：把会话存进 storage，打开番茄作者后台 ----
async function handleStartUpload(data, sendResponse) {
  const { tasks, sessionId, settings } = data;
  await chrome.storage.local.set({
    upload_session: {
      sessionId,
      tasks,
      settings: settings || { publishMode: "immediate", autoRetry: true, maxRetries: 3 },
      currentIndex: 0,
      retries: {},        // { [taskId]: 已重试次数 }
      status: "preparing",
      startTime: Date.now(),
    },
  });

  // 找一个已打开的番茄作者标签页，没有就新建
  const existing = (await chrome.tabs.query({ url: "https://fanqienovel.com/main/writer/*" }))[0];
  const tab = existing
    ? (await chrome.tabs.update(existing.id, { active: true }), existing)
    : await chrome.tabs.create({ url: FANQIE_WRITER, active: true });

  sendResponse({
    success: true,
    tabId: tab.id,
    message: "已打开番茄作者后台，请登录并进入你的小说『章节管理』页面，上传会自动开始。",
  });
}

// ---- 为某章节开一个发布标签页，加载完成后把章节数据喂给 publisher ----
async function handleOpenPublishTab(data, sendResponse) {
  const { url, task, sessionId } = data;
  const tab = await chrome.tabs.create({ url, active: false });
  // 按 tabId 把任务存好，等发布页加载完成后主动来拉取（见 REQUEST_TASK）
  if (tab.id) {
    await chrome.storage.local.set({ ["publish_task_" + tab.id]: { task, sessionId } });
  }
  sendResponse({ success: true, tabId: tab.id });
}

// ---- 把"本章完成/失败"消息转发给调度器所在的标签页 ----
async function relayToUploaderTab(msg) {
  const tabs = await chrome.tabs.query({ url: "https://fanqienovel.com/main/writer/*" });
  for (const t of tabs) {
    if (!t.id) continue;
    chrome.tabs.sendMessage(t.id, msg).catch(() => {}); // 发布页标签可能已关，忽略错误
  }
}
