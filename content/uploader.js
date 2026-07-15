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
  let rateBackoff = 1;       // #1.2 自适应限流降速倍率：触发 -1010 时放大章间间隔，平稳后回落（1~4）

  init();

  async function init() {
    console.log("🚀 番茄上传调度器已加载:", location.href);
    createIndicator();

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // popup 请求"本书已发布章节"（用于在列表里移除已发章）→ 异步返回 [{title, chapterNumber}]
      if (msg.type === "GET_PUBLISHED") {
        getPublishedChapters().then((list) => sendResponse(list || [])).catch(() => sendResponse([]));
        return true; // 异步响应，保持通道开启
      }
      if (msg.type === "TASK_DONE") onTaskDone(msg.taskId, msg.rateLimited);
      else if (msg.type === "TASK_FAILED") onTaskFailed(msg.taskId, msg.submitted, msg.reason, msg.detail, msg.rateLimited);
      else if (msg.type === "TASK_STOPPED") onTaskStopped(msg.taskId);
      else if (msg.type === "PAUSE_BATCH") onBatchPaused(msg.reason);
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

    // 标签页从后台切到前台时补判一次：若用户在后台打开了章节管理页（此时 visibilityState=hidden，
    // 续传询问被跳过），切回来变可见时再触发一次询问。busy/resumePrompted 会防止重复或干扰在跑的批次。
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") detectAndAct();
    });

    detectAndAct();
  }

  let resumePrompted = false;
  async function detectAndAct() {
    if (!session || session.status === "completed") return;
    // 发布页归 publisher 管：uploader 在这里保持静默，不刷"请进入章节管理页"提示
    //（发布页也匹配 writer/* 注入了本脚本，SPA 变更会反复触发本函数 → 日志噪音）
    if (/\/publish(\/|\?|$)/.test(location.href)) return;
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
    // 没有自动开始标记 = 用户重新进了页面：若还有没发完的，询问是否续传。
    // ⚠️ 仅在标签页【可见】时询问：发布用的后台标签页(active:false)成功后会被番茄
    // 跳回章节管理页，那里的 uploader 实例不应弹询问（后台 confirm 会被秒判取消，
    // 刷出误导性的"已暂停"日志）。真正的章节管理页是用户当前在看的，才需要续传询问。
    if (document.visibilityState !== "visible") return;
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
    const synced = await syncUploadedChapters();
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

    // ③ 计算每章发布时间
    if (session.rescheduleMode === "retry") {
      // 重发失败章：把"待发"章放回【合适的时段】——原定时间仍在未来就沿用，
      // 已过去/为立即则顺延到"现在之后最近的一个空闲发布档位"，绝不甩到队尾。
      assignRetryTimes();
      delete session.rescheduleMode;
    } else {
      // 正常批次：按"本次待发章节的序号"一次性排好（跳过已上传的，序号才不会错位）
      let ord = 0;
      for (const t of session.tasks) {
        if (t.status === "uploaded") continue;
        t.publishTime = computePublishTime(ord);
        ord++;
      }
    }
    await saveSession();

    session.status = "uploading";
    if (typeof session.runCount !== "number") session.runCount = 0; // #1 本次已发计数
    const pending = session.tasks.filter((t) => t.status !== "uploaded").length;
    await saveSession();
    setIndicator(`🚀 准备上传 ${pending} 章（共 ${session.tasks.length}）`, "info");
    await processNext();
  }

  function toYMD(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // 起始日期：auto=已排期最晚日期的次日；fixed=指定；tomorrow=明天。返回 YYYY-MM-DD
  function computeScheduleStartDate() {
    const s = session.settings || {};

    if (s.startDateMode === "fixed" && s.startDate) return s.startDate;

    if (s.startDateMode === "tomorrow") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return toYMD(d);
    }

    // auto：优先用章节列表接口的【全量·跨分页】排期时间（同步时已缓存）——
    // DOM 表格只有当前分页，最晚排期落在其他分页会读漏，接续起始日偏早、
    // 撞上已排满的日期（-1020 每日上限）。接口没给时间字段时才回退 DOM 扫描。
    const apiLatest = latestScheduledFromList(lastPublishedList);
    const latest = apiLatest || findLatestScheduledDate();
    try {
      chrome.runtime.sendMessage({ type: "LOG", src: "uploader",
        text: `📅 排期接续：最晚已排期=${latest ? toYMD(latest) : "未读到"}（来源:${apiLatest ? "接口全量" : "DOM当前页,可能漏读其他分页"}）` });
    } catch (_) {}
    const d = latest ? new Date(latest) : new Date();
    d.setDate(d.getDate() + 1);
    return toYMD(d);
  }

  // 从接口全量列表里取最晚发布/排期时间；条目都没有时间字段时返回 null（让上层回退 DOM）
  function latestScheduledFromList(list) {
    let latest = null;
    for (const p of list || []) {
      const ms = p && typeof p.publishMs === "number" ? p.publishMs : null;
      if (ms && (!latest || ms > latest)) latest = ms;
    }
    return latest ? new Date(latest) : null;
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
    // #1.2 自适应降速：番茄触发过限流(-1010)时放大间隔，平稳后自动回落
    if (rateBackoff > 1.05) {
      waitMs = Math.round(waitMs * rateBackoff);
      setIndicator(`🐢 检测到限流，降速中（×${rateBackoff.toFixed(1)}）等待 ${Math.round(waitMs / 1000)}s…`, "warning");
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
      // 让后台关掉卡住的发布页：被 Chrome 节流的隐藏标签页脚本可能还在残留点击（僵尸页）。
      // 试填模式除外——那个页面是留给用户人工检查的
      if (!session?.settings?.dryRun) {
        try { chrome.runtime.sendMessage({ type: "CLOSE_PUBLISH_TAB" }); } catch (_) {}
      }
      onTaskFailed(taskId, false, "超时未确认", "看门狗：单章 5 分钟无响应", false);
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

  // #2.1 发布器检测到风控（验证码/账号异常）→ 暂停整批并桌面告警，绝不硬闯
  async function onBatchPaused(reason) {
    if (!session) return;
    clearWatchdog();
    awaitingTaskId = null;
    busy = false;
    session.status = "stopped";
    await chrome.storage.local.set({ upload_control: "stop" }); // 让在途的 processNext 也停下
    await saveSession();
    rateBackoff = 1; // 重置降速，下次重新开始干净起步
    setIndicator(`🛑 检测到风控（${reason || "安全验证"}），已自动暂停。处理完可重新开始/续传`, "error");
    chrome.runtime.sendMessage({ type: "NOTIFY", message: `检测到风控（${reason || "安全验证"}），已自动暂停上传，请人工处理后再继续` });
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

  // #1.2 自适应限流降速：触发过 -1010 就放大章间间隔（×1.6，上限 4），平稳一章回落（×0.8，下限 1）
  function noteRateSignal(rateLimited) {
    if (rateLimited) rateBackoff = Math.min(4, rateBackoff * 1.6);
    else rateBackoff = Math.max(1, rateBackoff * 0.8);
  }

  async function onTaskDone(taskId, rateLimited) {
    if (!session || taskId !== awaitingTaskId) return; // 忽略过期/重复消息
    clearWatchdog();
    awaitingTaskId = null;
    noteRateSignal(rateLimited);
    const t = session.tasks.find((x) => x.id === taskId);
    if (t) { t.status = "uploaded"; delete t.failReason; delete t.failDetail; }
    session.runCount = (session.runCount || 0) + 1; // #1 计入本次已发
    console.log("✅ 本章完成:", taskId);
    session.currentIndex += 1;
    await saveSession();
    setTimeout(processNext, 1000 * pace());
  }

  async function onTaskFailed(taskId, submitted, reason, detail, rateLimited) {
    if (!session || taskId !== awaitingTaskId) return; // 忽略过期/重复消息
    clearWatchdog();
    awaitingTaskId = null;
    noteRateSignal(rateLimited);
    const s = session.settings || {};
    const used = session.retries[taskId] || 0;
    const task = session.tasks.find((x) => x.id === taskId);

    // -1020 每日上限：该排期日已满——后续待发章整体顺延一天重算，不再逐章硬试同一天
    //（硬试必被拒：每章白烧一次内容检测额度，还多留一个未排期的孤儿草稿）
    if (s.publishMode === "auto" && isDailyLimitRejection(reason, detail) && rescheduleAfterDailyLimit(taskId)) {
      setIndicator(`📅 该日排期已满（每日上限），后续章节顺延到 ${session.scheduleStartDate} 起重排`, "warning");
      await saveSession();
    }

    // 防重复关键：若发布器已点过"下一步"(submitted)，章节草稿很可能已创建——
    // 此时绝不重试（重试会再建一个=重复）。能在列表里查到的标记"已发"，查不到的标记"失败"。
    const exists = task && (await isChapterAlreadyPublished(task));
    if (submitted || exists) {
      if (task) {
        task.status = exists ? "uploaded" : "failed";
        if (exists) { delete task.failReason; delete task.failDetail; }
        else { task.failReason = reason || "其它"; task.failDetail = detail || ""; }
      }
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
    if (t) { t.status = "failed"; t.failReason = reason || "其它"; t.failDetail = detail || ""; }
    console.warn("❌ 本章最终失败，跳过:", taskId, reason || "");
    // #3 失败时桌面通知，批量跑不用一直盯着（带上失败原因）
    chrome.runtime.sendMessage({ type: "NOTIFY", message: `章节发布失败：${t?.title || taskId}（${reason || "原因未知"}，可稍后重发）` });
    session.currentIndex += 1;
    await saveSession();
    setTimeout(processNext, 1000 * pace());
  }

  // 发布被拒是否为"每日上限"（接口 code=-1020，msg 如"更新作品数超出每日上限"）
  function isDailyLimitRejection(reason, detail) {
    return reason === "发布被拒" && /每日上限|超出每日|code=-1020\b/.test(detail || "");
  }

  // 失败章的排期日期 +1 天作为新起始日；时间无效回退"明天"
  function bumpStartDate(publishTime) {
    const ms = Date.parse(publishTime);
    const d = isNaN(ms) ? new Date() : new Date(ms);
    d.setDate(d.getDate() + 1);
    return toYMD(d);
  }

  // 每日上限命中后：起始日改为失败章日期+1，后续待发章按新起始日整体重算。
  // 返回是否真的顺延了（同一天连续多章 -1020 只顺延一次，不叠加）
  function rescheduleAfterDailyLimit(failedTaskId) {
    const failed = session.tasks.find((x) => x.id === failedTaskId);
    if (!failed || !failed.publishTime || failed.publishTime === "now") return false;
    const newStart = bumpStartDate(failed.publishTime);
    if (session.scheduleStartDate && newStart <= session.scheduleStartDate) return false; // 已顺延过
    session.scheduleStartDate = newStart;
    let ord = 0;
    for (const t of session.tasks) {
      if (t.id === failedTaskId || t.status === "uploaded" || t.status === "failed") continue;
      t.publishTime = computePublishTime(ord);
      ord++;
    }
    console.log("📅 每日上限：排期起始日顺延至", newStart);
    return true;
  }

  // #2.3 夜间避让：判断某时刻是否落在"不发布"时段（默认 23:00~07:00，跨午夜）
  function isNightTime(ms) {
    const s = session.settings || {};
    if (!s.nightAvoid) return false;
    const toMin = (t) => { const [h, m] = (t || "00:00").split(":").map(Number); return h * 60 + m; };
    const ns = toMin(s.nightStart || "23:00");
    const ne = toMin(s.nightEnd || "07:00");
    const d = new Date(ms); const cur = d.getHours() * 60 + d.getMinutes();
    return ns < ne ? (cur >= ns && cur < ne) : (cur >= ns || cur < ne);
  }

  // ---------- 发布时间计算 ----------
  // 返回 'now'（立即）或 ISO 字符串（定时）。开启夜间避让时，跳过夜间档位顺延到下一个白天档，
  // 而不是堆到早上某一刻（避免撞档 + 章序保持）。
  function computePublishTime(index) {
    const s = session.settings || {};
    if (s.publishMode === "immediate" || !s.publishMode) return "now";

    if (s.publishMode === "custom" && s.customStart) {
      // 首章 = customStart，后续每小时一章；夜间档跳过
      const base = new Date(s.customStart);
      let count = 0;
      for (let i = 0; i < 24 * 3650; i++) {
        const d = new Date(base); d.setHours(d.getHours() + i);
        if (isNightTime(d.getTime())) continue;
        if (count === index) return d.toISOString();
        count++;
      }
      return "now";
    }

    if (s.publishMode === "auto") {
      // 每天 N 章，当天内从 startHour 起按 24/N 小时平均分配；日期从 scheduleStartDate 起递增。
      // 枚举 cadence 档位、跳过夜间档，取第 index 个允许档位（未开夜间避让时与原 1:1 映射等价）。
      const N = Math.max(1, s.dailyChapters || 1);
      const [hh, mm] = (s.startHour || "06:00").split(":").map(Number);
      const baseMin = hh * 60 + mm;
      const stepMin = Math.floor(1440 / N);
      const base = session.scheduleStartDate
        ? new Date(session.scheduleStartDate + "T00:00:00")
        : (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d; })();

      let count = 0;
      for (let day = 0; day < 3650; day++) {
        for (let slot = 0; slot < N; slot++) {
          const d = new Date(base); d.setDate(d.getDate() + day); d.setMinutes(baseMin + slot * stepMin);
          if (isNightTime(d.getTime())) continue; // 跳过夜间档
          if (count === index) {
            // #2 随机分钟偏移：打破整点规律，更像人工
            const mj = s.minuteJitter || 0;
            if (mj > 0) d.setMinutes(d.getMinutes() + Math.floor((Math.random() * 2 - 1) * mj));
            return d.toISOString();
          }
          count++;
        }
      }
      return "now";
    }
    return "now";
  }

  // ---------- 重发失败章：合适时段排期 ----------
  // 规则：待发章的原定时间仍在未来 → 沿用（它的"坑"还留着）；
  //       已过去/为立即 → 顺延到"现在之后最近的一个【空闲】发布档位"（按 cadence），不甩队尾。
  // 已发布章节占用的档位会被避开，待发章按章节顺序依次拿靠前的空档，保持章序与时间一致。
  function assignRetryTimes() {
    const s = session.settings || {};
    // 立即模式：本来就不排期，全部立即
    if (s.publishMode === "immediate" || !s.publishMode) {
      for (const t of session.tasks) if (t.status !== "uploaded") t.publishTime = "now";
      return;
    }
    const nowMs = Date.now() + 60 * 1000; // 留 1 分钟缓冲，避开"刚好现在"
    const minKey = (ms) => Math.floor(ms / 60000); // 分钟级去重，防撞档
    const taken = new Set();
    // 先把已发布章节占用的时段记下
    for (const t of session.tasks) {
      if (t.status === "uploaded" && t.publishTime && t.publishTime !== "now") {
        const ms = Date.parse(t.publishTime);
        if (!isNaN(ms)) taken.add(minKey(ms));
      }
    }
    // 按章节顺序为待发章分配（靠前的章拿靠前的档位）
    for (const t of session.tasks) {
      if (t.status === "uploaded") continue;
      const origMs = t.publishTime && t.publishTime !== "now" ? Date.parse(t.publishTime) : NaN;
      if (!isNaN(origMs) && origMs > nowMs && !taken.has(minKey(origMs))) {
        taken.add(minKey(origMs)); // 原定时间仍在未来且没被占 → 沿用
        continue;
      }
      const slotMs = nextFreeCadenceSlot(nowMs, taken, minKey);
      t.publishTime = slotMs ? new Date(slotMs).toISOString() : "now";
      if (slotMs) taken.add(minKey(slotMs));
    }
  }

  // 在 cadence（auto=每日 N 档按 24/N 平均；custom=每小时一档）里，
  // 找"晚于 afterMs 且未被 taken 占用"的最早档位，返回毫秒；找不到返回 null。
  function nextFreeCadenceSlot(afterMs, taken, minKey) {
    const s = session.settings || {};
    if (s.publishMode === "custom" && s.customStart) {
      const base = new Date(s.customStart);
      for (let i = 0; i < 24 * 90; i++) { // 最多往后 90 天的每小时档
        const d = new Date(base); d.setHours(d.getHours() + i);
        const ms = d.getTime();
        if (ms > afterMs && !isNightTime(ms) && !taken.has(minKey(ms))) return ms;
      }
      return null;
    }
    // auto
    const N = Math.max(1, s.dailyChapters || 1);
    const [hh, mm] = (s.startHour || "06:00").split(":").map(Number);
    const baseMin = hh * 60 + mm;
    const stepMin = Math.floor(1440 / N);
    const start = new Date(afterMs); start.setHours(0, 0, 0, 0);
    for (let day = 0; day < 365; day++) {
      for (let slot = 0; slot < N; slot++) {
        const d = new Date(start); d.setDate(d.getDate() + day); d.setMinutes(baseMin + slot * stepMin);
        const ms = d.getTime();
        if (ms > afterMs && !isNightTime(ms) && !taken.has(minKey(ms))) return ms;
      }
    }
    return null;
  }

  // ---------- 同步已上传章节 ----------
  // 取【全量】已创建章节（含定时未发），按章节号/标题匹配，把对应任务标记为 uploaded，避免重复发。
  async function syncUploadedChapters() {
    const published = await getPublishedChapters();
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
    console.log(`🔄 同步：已存在 ${published.length} 章，匹配标记 ${count} 章`);
    return count;
  }

  // #1.1 已创建章节的统一来源：优先调番茄"章节列表"接口拿【全量·跨分页】，失败回退 DOM 抓当前页。
  // 解决"章节多到翻页后，防重复只看当前页 → 漏判/重发"的问题。
  async function getPublishedChapters() {
    const api = await fetchPublishedViaApi();
    const useApi = !!(api && api.length);
    // 来源变化时记一条运行日志（首次成功 / 后续回退），方便导出日志核对，不刷屏
    const src = useApi ? "api" : "dom";
    if (src !== lastPubSource) {
      lastPubSource = src;
      const text = useApi
        ? `📡 章节列表接口可用：全量同步 ${api.length} 章（跨分页）`
        : "↩️ 章节列表接口不可用，回退 DOM 抓取（仅当前页，多分页可能漏判）";
      try { chrome.runtime.sendMessage({ type: "LOG", src: "uploader", text }); } catch (_) {}
    }
    const result = useApi ? api : scrapePublishedChapters();
    lastPublishedList = result; // 缓存给排期接续用（computeScheduleStartDate 是同步函数）
    return result;
  }
  let lastPubSource = null;
  let lastPublishedList = null;

  // 从章节列表接口条目提取发布/排期时间，返回毫秒。字段名多版本探测；
  // 兼容 秒/毫秒时间戳 与 "YYYY-MM-DD HH:mm:ss" 字符串；都拿不到返回 null（上层回退 DOM）
  function pickScheduleMs(it) {
    if (!it) return null;
    for (const k of ["publish_time", "publish_timestamp", "online_time", "pub_time", "first_publish_time"]) {
      const v = it[k];
      if (v == null || v === "" || v === 0 || v === "0") continue;
      if (typeof v === "number" || /^\d+$/.test(String(v))) {
        const n = Number(v);
        if (n > 1e12) return n;        // 毫秒级
        if (n > 1e9) return n * 1000;  // 秒级
        continue;                       // 数值太小，不是时间戳
      }
      const ms = Date.parse(String(v).replace(/-/g, "/")); // 斜杠格式确保按本地时区解析
      if (!isNaN(ms)) return ms;
    }
    return null;
  }

  // 直接同源调用 chapter_list 接口，翻完所有页返回 [{title, chapterNumber}]。
  // 任何异常/非 0 返回都返回 null，让上层回退 DOM。不带 msToken/a_bogus（读接口同源 + 会话 cookie 通常即可）。
  async function fetchPublishedViaApi() {
    const m = location.href.match(/\/main\/writer\/chapter-manage\/(\d+)/);
    if (!m) return null;
    const bookId = m[1];
    const out = [];
    const PAGE = 50;
    try {
      for (let page = 0; page < 60; page++) { // 上限 60×50=3000 章，足够任何长篇
        const url = "https://fanqienovel.com/api/author/chapter/chapter_list/v1" +
          `?aid=2503&app_name=muye_novel&book_id=${bookId}` +
          `&page_index=${page}&page_count=${PAGE}&status=0` +
          "&must_have_correction_feedback=0&need_correction_feedback_num=1&sort=";
        const resp = await fetch(url, { credentials: "include", headers: { accept: "application/json, text/plain, */*" } });
        if (!resp.ok) return out.length ? out : null;
        const j = await resp.json();
        if (!j || j.code !== 0 || !j.data) return out.length ? out : null;
        const items = j.data.item_list || [];
        for (const it of items) {
          const title = (it.title || "").trim();
          if (!title) continue;
          const cm = title.match(/第\s*(\d+)\s*章/);
          out.push({ title, chapterNumber: cm ? parseInt(cm[1], 10) : null, publishMs: pickScheduleMs(it) });
        }
        const total = j.data.total_count || 0;
        if (!items.length || out.length >= total) break; // 翻完
      }
      if (out.length) console.log(`📡 接口同步：已创建 ${out.length} 章（全量·跨分页）`);
      return out.length ? out : [];
    } catch (e) {
      console.warn("章节列表接口异常：", e?.message || e);
      return out.length ? out : null;
    }
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

  // 防重复：检查这一章是否已存在（按章节号或标题匹配，全量·跨分页）
  async function isChapterAlreadyPublished(task) {
    await delay(800); // 给页面/接口一点时间刷新出新章
    const published = await getPublishedChapters();
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
