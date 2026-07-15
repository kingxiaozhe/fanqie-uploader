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

        // 3b) 调度器看门狗超时：关掉当前发布标签页——被 Chrome 节流的隐藏发布页
        //     脚本可能仍在残留点击（僵尸页），不能指望它自己收口
        case "CLOSE_PUBLISH_TAB": {
          const { last_publish_tab_id } = await chrome.storage.local.get("last_publish_tab_id");
          if (last_publish_tab_id) {
            try { await chrome.tabs.remove(last_publish_tab_id); } catch (_) {}
            await chrome.storage.local.remove("last_publish_tab_id");
          }
          sendResponse({ success: true });
          break;
        }

        // 4) 发布器通知"本章完成/失败"——转发给调度器标签页驱动下一章；
        //    完成后由后台直接关闭发布 tab（不依赖发布页脚本是否还活着，更可靠）
        case "TASK_DONE":
        case "TASK_FAILED":
        case "TASK_STOPPED":
        case "RESUME_UPLOAD":
        case "PAUSE_BATCH": // 风控信号：转发给调度器暂停整批；不关发布页，留给用户完成验证
          await relayToUploaderTab(msg, sender.tab?.id);
          if (msg.type === "TASK_DONE" && sender.tab?.id) {
            setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 600);
          }
          sendResponse({ success: true });
          break;

        // 内容脚本转发的日志：打印到后台控制台 + 落盘到 storage（供一键导出排查）
        case "LOG": {
          console.log(`[${msg.src || "cs"}]`, msg.text);
          await appendLog(msg.src || "cs", msg.text);
          sendResponse({ success: true });
          break;
        }

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

// ---- 运行日志：落盘到 storage（最多 1500 条），供进度面板一键导出 ----
async function appendLog(src, text) {
  try {
    const { fq_logs = [] } = await chrome.storage.local.get("fq_logs");
    fq_logs.push({ t: Date.now(), src, text });
    if (fq_logs.length > 1500) fq_logs.splice(0, fq_logs.length - 1500);
    await chrome.storage.local.set({ fq_logs });
  } catch (_) {}
}

// ---- 开始上传：把会话存进 storage，打开番茄作者后台 ----
async function handleStartUpload(data, sendResponse) {
  const { tasks, sessionId, settings, folderName } = data;
  await chrome.storage.local.remove("upload_control"); // 清除上次的"停止"标记
  await appendLog("system", `▶▶ 新批次开始：${tasks?.length || 0} 章 | 设置 ${JSON.stringify(settings || {})}`);
  await chrome.storage.local.set({ upload_autostart: true }); // 标记"刚点开始"，让调度器自动跑而非询问续传
  await chrome.storage.local.set({
    upload_session: {
      sessionId,
      tasks,
      folderName: folderName || "",  // 书名：进度面板标题 + CSV 报告文件名用
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
    await chrome.storage.local.set({ last_publish_tab_id: tab.id }); // 看门狗关僵尸页用
  }
  sendResponse({ success: true, tabId: tab.id });
}

// ---- 把"本章完成/失败"消息转发给调度器所在的标签页（排除发布页自身）----
async function relayToUploaderTab(msg, excludeTabId) {
  const tabs = await chrome.tabs.query({ url: "https://fanqienovel.com/main/writer/*" });
  for (const t of tabs) {
    if (!t.id || t.id === excludeTabId) continue;
    chrome.tabs.sendMessage(t.id, msg).catch(() => {}); // 发布页标签可能已关，忽略错误
  }
}
