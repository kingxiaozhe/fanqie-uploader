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

  let session = null;     // { sessionId, tasks, settings, currentIndex, retries, status }
  let indicator = null;   // 右上角状态浮标
  let indicatorText = null; // 浮标里的文本区（按钮在旁边）
  let busy = false;
  let awaitingTaskId = null; // 当前正在等待结果的章节 id（防重复推进 + 看门狗用）
  let watchdog = null;       // 看门狗计时器：本章超时无响应则按失败处理
  const CHAPTER_TIMEOUT = 300000; // 单章最长等待 5 分钟（风险检测可能较久 + 慢节奏留余量）

  init();

  async function init() {
    console.log("🚀 番茄上传调度器已加载:", location.href);
    createIndicator();

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "TASK_DONE") onTaskDone(msg.taskId);
      else if (msg.type === "TASK_FAILED") onTaskFailed(msg.taskId, msg.submitted);
      else if (msg.type === "TASK_STOPPED") onTaskStopped(msg.taskId);
      else if (msg.type === "RESUME_UPLOAD") resumeUpload();
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

  let resumePrompted = false;
  async function detectAndAct() {
    if (!session || session.status === "completed") return;
    if (!/\/main\/writer\/chapter-manage\/\d+/.test(location.href)) {
      setIndicator("📚 请进入你要上传的小说『章节管理』页面", "info");
      return;
    }
    if (busy) return;

    // #5 断点续传：区分"刚点开始"和"重进页面"
    const { upload_autostart } = await chrome.storage.local.get("upload_autostart");
    if (upload_autostart) {
      await chrome.storage.local.remove("upload_autostart"); // 消费一次，本批自动跑
      startUpload();
      return;
    }
    // 没有自动开始标记 = 用户重新进了页面：若还有没发完的，询问是否续传
    const pending = session.tasks.filter((t) => t.status !== "uploaded" && t.status !== "failed").length;
    if (pending > 0 && !resumePrompted) {
      resumePrompted = true;
      setIndicator(`↩️ 上次还有 ${pending} 章未发`, "warning");
      if (confirm(`检测到上次还有 ${pending} 章未发布，是否继续上传？`)) {
        await chrome.storage.local.remove("upload_control");
        startUpload();
      } else {
        setIndicator("⏸ 已暂停。重新进入本页或点扩展可继续", "info");
      }
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

    // ② 定时模式：确定起始日期（自动接续已排期 / 指定 / 明天）
    if ((session.settings?.publishMode) === "auto") {
      session.scheduleStartDate = computeScheduleStartDate();
      console.log("📅 定时起始日期:", session.scheduleStartDate);
    }

    // ③ 一次性按"本次待发章节的序号"算好每章发布时间（跳过已上传的，序号才不会错位）
    let ord = 0;
    for (const t of session.tasks) {
      if (t.status === "uploaded") continue;
      t.publishTime = computePublishTime(ord);
      ord++;
    }
    await saveSession();

    session.status = "uploading";
    if (typeof session.runCount !== "number") session.runCount = 0; // #1 本次已发计数
    const pending = session.tasks.filter((t) => t.status !== "uploaded").length;
    await saveSession();
    setIndicator(`🚀 准备上传 ${pending} 章（共 ${session.tasks.length}）`, "info");
    await processNext();
  }

  // 起始日期：auto=已排期最晚日期的次日；fixed=指定；tomorrow=明天。返回 YYYY-MM-DD
  function computeScheduleStartDate() {
    const s = session.settings || {};
    const toYMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    if (s.startDateMode === "fixed" && s.startDate) return s.startDate;

    if (s.startDateMode === "tomorrow") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return toYMD(d);
    }

    // auto：读章节管理页里已排期的最晚日期，从次日开始；读不到则用明天
    const latest = findLatestScheduledDate();
    const d = latest || new Date();
    d.setDate(d.getDate() + 1);
    return toYMD(d);
  }

  // 扫描章节管理页表格，找出"发布时间"列里最晚的日期
  function findLatestScheduledDate() {
    let latest = null;
    for (const row of document.querySelectorAll("tbody .arco-table-tr")) {
      const m = (row.textContent || "").match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
      if (!m) continue;
      const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
      if (!latest || d > latest) latest = d;
    }
    if (latest) console.log("📅 已排期最晚日期:", latest.toLocaleString());
    return latest;
  }

  // ---------- 串行处理 ----------
  async function processNext() {
    if (!session) return;

    // 停止控制：用户在进度面板点了"停止"
    const { upload_control } = await chrome.storage.local.get("upload_control");
    if (upload_control === "stop") {
      session.status = "stopped";
      await saveSession();
      setIndicator("⏹ 已停止上传", "warning");
      busy = false;
      return;
    }

    // #1 本次发布量上限：达到就停下（番茄风控更看频率，到量自动停最稳）
    const maxBatch = session.settings?.maxPerBatch || 0;
    if (maxBatch > 0 && (session.runCount || 0) >= maxBatch) {
      session.status = "stopped";
      await saveSession();
      setIndicator(`✋ 已达本次上限 ${maxBatch} 章，自动停止（可稍后再发）`, "warning");
      chrome.runtime.sendMessage({ type: "NOTIFY", message: `已达本次上限 ${maxBatch} 章，自动停止` });
      busy = false;
      return;
    }

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
    // publishTime 已在 startUpload 里按序号一次性算好（见 ③），这里直接用
    setIndicator(`📝 第 ${i + 1}/${session.tasks.length} 章：${task.title}`, "info");
    await saveSession();

    const publishUrl = buildPublishUrl();
    if (!publishUrl) {
      setIndicator("❌ 未找到『新建章节』入口，请刷新页面重试", "error");
      busy = false;
      return;
    }

    // 开下一个发布页前的间隔：在用户设定的 [gapMin, gapMax] 秒区间内随机，避免固定节奏被识别
    const human = session.settings?.humanize !== false;
    let waitMs = 800;
    if (human) {
      let lo = Math.max(0, session.settings?.gapMin ?? 5);
      let hi = Math.max(lo, session.settings?.gapMax ?? 20);
      waitMs = Math.round((lo + Math.random() * (hi - lo)) * 1000);
      setIndicator(`⏳ 随机等待 ${Math.round(waitMs / 1000)}s 后发下一章（${lo}~${hi}s）…`, "info");
    }
    await new Promise((r) => setTimeout(r, waitMs)); // 用精确秒数，不叠加节奏倍率
    awaitingTaskId = task.id;
    chrome.runtime.sendMessage({
      type: "OPEN_PUBLISH_TAB",
      data: { url: publishUrl, task, sessionId: session.sessionId },
    });
    armWatchdog(task.id); // 本章超时无响应则兜底，避免永久卡住
  }

  function pace() { return session?.settings?.pace || 1; }

  // 看门狗：本章 CHAPTER_TIMEOUT 内没收到结果，按失败处理（onTaskFailed 内会先查重）
  function armWatchdog(taskId) {
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (taskId !== awaitingTaskId) return;
      console.warn("⏰ 本章超时无响应，按失败处理:", taskId);
      setIndicator("⏰ 本章超时，自动处理", "warning");
      onTaskFailed(taskId);
    }, CHAPTER_TIMEOUT);
  }
  function clearWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }

  // 进度面板点了"重发失败章节"：重读会话、重置状态、重新跑（同步去重仍生效）
  async function resumeUpload() {
    const { upload_session } = await chrome.storage.local.get("upload_session");
    if (upload_session) session = upload_session;
    clearWatchdog();
    awaitingTaskId = null;
    busy = false;
    setIndicator("🔁 重发失败章节…", "info");
    detectAndAct();
  }

  // 发布器在提交前响应了停止信号——本章未创建，干净停下
  async function onTaskStopped(taskId) {
    if (!session) return;
    clearWatchdog();
    awaitingTaskId = null;
    session.status = "stopped";
    await saveSession();
    setIndicator("⏹ 已停止（本章未提交，可重新开始）", "warning");
    busy = false;
  }

  async function onTaskDone(taskId) {
    if (!session || taskId !== awaitingTaskId) return; // 忽略过期/重复消息
    clearWatchdog();
    awaitingTaskId = null;
    const t = session.tasks.find((x) => x.id === taskId);
    if (t) t.status = "uploaded";
    session.runCount = (session.runCount || 0) + 1; // #1 计入本次已发
    console.log("✅ 本章完成:", taskId);
    session.currentIndex += 1;
    await saveSession();
    setTimeout(processNext, 1000 * pace());
  }

  async function onTaskFailed(taskId, submitted) {
    if (!session || taskId !== awaitingTaskId) return; // 忽略过期/重复消息
    clearWatchdog();
    awaitingTaskId = null;
    const s = session.settings || {};
    const used = session.retries[taskId] || 0;
    const task = session.tasks.find((x) => x.id === taskId);

    // 防重复关键：若发布器已点过"下一步"(submitted)，章节草稿很可能已创建——
    // 此时绝不重试（重试会再建一个=重复）。能在列表里查到的标记"已发"，查不到的标记"失败"。
    const exists = task && (await isChapterAlreadyPublished(task));
    if (submitted || exists) {
      if (task) task.status = exists ? "uploaded" : "failed";
      console.log(`⏭️ 第${session.currentIndex + 1}章不重试(submitted=${!!submitted})，避免重复:`, task?.title);
      setIndicator(`⏭️ 第 ${session.currentIndex + 1} 章已创建/已存在，跳过（防重复）`, "warning");
      session.currentIndex += 1;
      await saveSession();
      setTimeout(processNext, 1000 * pace());
      return;
    }

    if (s.autoRetry && used < (s.maxRetries || 3)) {
      session.retries[taskId] = used + 1;
      await saveSession();
      setIndicator(`🔁 第 ${session.currentIndex + 1} 章失败，重试 ${used + 1}/${s.maxRetries || 3}`, "warning");
      setTimeout(processNext, 1500 * pace()); // 不前进 index，重发当前章
      return;
    }

    const t = session.tasks.find((x) => x.id === taskId);
    if (t) t.status = "failed";
    console.warn("❌ 本章最终失败，跳过:", taskId);
    // #3 失败时桌面通知，批量跑不用一直盯着
    chrome.runtime.sendMessage({ type: "NOTIFY", message: `章节发布失败：${t?.title || taskId}（已跳过，可稍后重发）` });
    session.currentIndex += 1;
    await saveSession();
    setTimeout(processNext, 1000 * pace());
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
      // 每天 N 章，当天内从 startHour 起按 24/N 小时平均分配；日期从 scheduleStartDate 起递增
      const N = Math.max(1, s.dailyChapters || 1);
      const [hh, mm] = (s.startHour || "06:00").split(":").map(Number);
      const baseMin = hh * 60 + mm;
      const stepMin = Math.floor(1440 / N);      // 一天均分到 N 个时段
      const day = Math.floor(index / N);
      const slot = index % N;

      const start = session.scheduleStartDate
        ? new Date(session.scheduleStartDate + "T00:00:00")
        : (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d; })();

      start.setDate(start.getDate() + day);
      start.setMinutes(baseMin + slot * stepMin); // setMinutes 会自动进位到小时

      // #2 发布时间随机分钟偏移：打破整点规律，更像人工（minuteJitter 分钟内随机 ±）
      const mj = s.minuteJitter || 0;
      if (mj > 0) start.setMinutes(start.getMinutes() + Math.floor((Math.random() * 2 - 1) * mj));
      return start.toISOString();
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
      const m = title.match(/第\s*(\d+)\s*章/);
      out.push({ title, chapterNumber: m ? parseInt(m[1], 10) : null });
    }
    return out;
  }

  function sameTitle(a, b) {
    const norm = (s) => (s || "").replace(/^\s*第\s*\d+\s*章[\s：:、.．·\-]*/, "").trim();
    const x = norm(a), y = norm(b);
    return !!x && (x === y || x.includes(y) || y.includes(x));
  }

  // 防重复：检查这一章是否已存在于章节管理页（按章节号或标题匹配）
  async function isChapterAlreadyPublished(task) {
    await delay(800); // 给页面一点时间刷新出新章
    const published = scrapePublishedChapters();
    return published.some((p) =>
      (task.chapterNumber && p.chapterNumber === task.chapterNumber) ||
      sameTitle(p.title, task.title)
    );
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

  // ---------- 状态浮标（带停止按钮）----------
  function createIndicator() {
    if (indicator) return;
    indicator = document.createElement("div");
    indicator.id = "fq-uploader-indicator";
    indicator.style.cssText = `
      position:fixed;top:20px;left:20px;z-index:99999;
      background:#3498db;color:#fff;padding:10px 14px;border-radius:8px;
      font:500 13px/1.4 system-ui;max-width:360px;display:none;
      box-shadow:0 4px 12px rgba(0,0,0,.3);transition:all .3s ease;
      align-items:center;gap:10px;`;
    indicatorText = document.createElement("span");
    indicator.appendChild(indicatorText);

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "⏹ 停止";
    stopBtn.style.cssText = `
      flex:none;border:1px solid rgba(255,255,255,.7);background:rgba(0,0,0,.18);
      color:#fff;border-radius:6px;padding:3px 10px;font:600 12px/1.4 system-ui;cursor:pointer;`;
    stopBtn.addEventListener("click", async () => {
      await chrome.storage.local.set({ upload_control: "stop" });
      stopBtn.disabled = true;
      stopBtn.textContent = "⏹ 停止中…";
      setIndicator("⏹ 已请求停止：当前章若未提交会立即中止", "warning");
    });
    indicator.appendChild(stopBtn);
    document.body.appendChild(indicator);
  }

  function setIndicator(text, level = "info") {
    try { chrome.runtime.sendMessage({ type: "LOG", src: "uploader", text }); } catch (_) {} // 进运行日志
    if (!indicator) return;
    const colors = { info: "#3498db", success: "#27ae60", warning: "#f39c12", error: "#e74c3c" };
    indicatorText.textContent = text;
    indicator.style.background = colors[level] || colors.info;
    indicator.style.display = "flex";
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms * (session?.settings?.pace || 1)));
  }
})();
