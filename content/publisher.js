// ============================================================
//  content/publisher.js — 发布器（注入到章节发布页 /publish*）
//  职责：把一章的【章节号/标题/正文】填进番茄的编辑器，设置
//  发布方式（立即/定时），点发布并自动处理各种确认弹窗，
//  成功后通知调度器并关闭本标签页。这是整套流程的"手"。
//
//  ⚠️ 番茄前端用 React + Arco Design + ProseMirror 富文本。
//     直接改 input.value 不会被 React 接管 —— 必须派发 input 事件；
//     正文要按段落塞 <p> 进 ProseMirror。下方选择器为示意，
//     番茄改版后需要对照实际 DOM 调整。
// ============================================================

(function () {
  "use strict";

  let processing = false;
  let currentTask = null;     // 当前正在发布的章节（含 publishTime）
  let currentSessionId = null; // 当前会话 id（风控暂停信号要用）
  let currentSettings = {};   // 本次会话的设置（dryRun / detectionMode 等）
  let dialogHandled = false;  // 发布设置对话框是否已处理（防重复）
  let submitted = false;      // 是否已点"下一步"创建了章节（失败后据此决定能否重试，防重复发布）
  let batchPaused = false;    // #2.1 检测到风控(验证码/账号异常)：暂停整批，保留本页供人工处理
  let paceFactor = 1;         // 操作节奏倍率（>1 更慢，降低出错率），来自设置
  let humanize = true;        // 拟人随机延迟（降低被识别为工具的概率）

  // 随机整数 [min,max]
  function rand(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
  // 拟人抖动：在基准毫秒上叠加 ±40% 随机（关闭则原样返回）
  function jitter(ms) { return humanize ? ms * (0.8 + Math.random() * 0.6) : ms; }
  let statusEl = null;        // 页面顶部状态横幅
  const DEBUG = false;        // 调试模式：true=失败保留标签页不重试；正式批量请保持 false

  // ============================================================
  //  番茄页面选择器集中配置 —— 番茄改版时，只改这里
  // ============================================================
  const SEL = {
    titleInput: ['input[placeholder="请输入标题"]', "input.serial-editor-input-hint-area", 'input[placeholder*="标题"]', 'input[name="title"]'],
    chapterNumberInput: [".serial-editor-title-left input", ".left-input input"],
    contentArea: ['.ProseMirror[contenteditable="true"]', ".ProseMirror", '[contenteditable="true"]', 'textarea[name="content"]'],
    submitButton: ['button[data-apm-action="core_chain_long_story_next_confirm"]', "button.auto-editor-next", "button.publish-button"],
    submitText: ["下一步", "发布", "提交"],
    modal: ".arco-modal-content, .arco-modal",
    modalPrimary: ".arco-modal-footer button.arco-btn-primary",
    publishDialog: ".arco-modal.publish-confirm-container-new",
    scheduleSwitchOff: '.arco-switch[aria-checked="false"]',
    scheduleSwitchOn: '.arco-switch[aria-checked="true"]',
    pickerInput: ".arco-picker input, input.arco-picker-input, .arco-picker-start-time",
    calPanel: ".arco-picker-container",
    calHeaderValue: ".arco-picker-header-value",
    calHeaderIcon: ".arco-picker-header-icon",
    calCell: ".arco-picker-cell.arco-picker-cell-in-view:not(.arco-picker-cell-disabled)",
    calCellValue: ".arco-picker-date-value",
    timePanel: ".arco-timepicker-container",      // 时间面板容器
    timeCol: ".arco-timepicker-list",             // 时间面板的"时/分"列（两列）
    timeCell: ".arco-timepicker-cell",            // 时间面板里的每个数字格
    timeCellInner: ".arco-timepicker-cell-inner", // 数字格里的文本
    successToast: ".arco-message-success, .arco-notification-success",
    errorToast: ".arco-message-error, .arco-notification-error",
    radio: ".arco-radio",
  };

  // 用户是否已请求停止（进度面板/浮标/popup 的停止按钮写入 upload_control=stop）
  async function stopRequested() {
    try {
      const { upload_control } = await chrome.storage.local.get("upload_control");
      return upload_control === "stop";
    } catch (_) { return false; }
  }

  // 轮询等待条件成立（替代写死的 delay，更稳更快）。返回是否在超时前成立。
  async function waitFor(fn, { timeout = 8000, interval = 200 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (fn()) return true; } catch (_) {}
      await delay(interval);
    }
    return false;
  }

  // 顶部状态横幅 + 转发日志到后台（调试用，单看一处即可）
  function setStatus(text, level = "info") {
    console.log("[publisher]", text);
    try { chrome.runtime.sendMessage({ type: "LOG", src: "publisher", text }); } catch (_) {}
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:999999;padding:10px 16px;" +
        "text-align:center;font:600 14px/1.4 system-ui;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);";
      document.body.appendChild(statusEl);
    }
    statusEl.style.background = { info: "#3498db", success: "#27ae60", error: "#e74c3c" }[level] || "#3498db";
    statusEl.textContent = text;
  }

  // 诊断日志：只进运行日志（不弹横幅），用于记录每一步的细节，让一份日志就能定位问题
  function dlog(text) {
    console.log("[publisher·d]", text);
    try { chrome.runtime.sendMessage({ type: "LOG", src: "publisher", text: "· " + text }); } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "FILL_CHAPTER") {
      fillChapter(msg.data).then(() => sendResponse({ success: true }));
      return true; // 异步
    }
    sendResponse({ success: false, error: "未知消息类型" });
    return true;
  });

  console.log("📝 章节发布器已加载:", location.href);

  // 接收 net-hook 截获的"发布接口"权威结果（成功与否以番茄接口返回为准）
  let netPublishResult = null;
  let sawRateLimit = false; // 本章是否出现过限流(-1010)——用于自适应降速 + 失败归类
  // 暂时性限流（-1010 操作太频繁 / 稍后再试）：番茄前端会自动重发到成功，
  // 不能当成终局失败——否则轮询恰好先抓到这一条就会把已成功的章节误判为失败。
  const isTransientFail = (r) =>
    r && !r.ok && (
      r.code === -1010 || r.code === "-1010" ||
      /频繁|稍后再试|稍后重试|请重试|too frequent|try again|rate ?limit/i.test(r.message || "")
    );
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__fqNet && e.data.type === "publish-result") {
      const transient = isTransientFail(e.data);
      if (transient) sawRateLimit = true;
      if (!transient) netPublishResult = e.data; // 只采信终局结果；限流条目仅记录、继续等真正的返回
      dlog(`🔌 发布接口返回 ok=${e.data.ok} code=${e.data.code} status=${e.data.status} msg=${e.data.message || ""}${transient ? " ⏳(限流·忽略,等番茄自动重试)" : ""}`);
    }
  });

  // 失败原因归类：给调度器/进度面板/导出报告一个可读的分类 + 细节
  function classifyFailure(e) {
    const msg = ((e && (e.message || e)) || "") + "";
    const r = netPublishResult; // 终局 API 失败（非限流）
    if (r && r.ok === false) {
      const m = r.message || "";
      if (/违禁|敏感|风险|违规|涉黄|涉政|色情|暴力/.test(m)) return { reason: "违禁内容", detail: m };
      if (/字数|过短|过长|不能为空|为空|格式|校验|不合法|标题|重复/.test(m)) return { reason: "校验不通过", detail: m };
      return { reason: "发布被拒", detail: m || ("code=" + r.code) };
    }
    if (sawRateLimit) return { reason: "限流", detail: "操作太频繁，番茄多次返回 -1010" };
    if (/版本冲突/.test(msg)) return { reason: "版本冲突", detail: msg };
    if (/正文/.test(msg)) return { reason: "正文未填入", detail: msg };
    if (/未找到|找不到/.test(msg)) return { reason: "页面元素缺失", detail: msg };
    if (/超时|未跳转|未确认/.test(msg)) return { reason: "超时未确认", detail: msg };
    if (/校验|检测/.test(msg)) return { reason: "校验不通过", detail: msg };
    return { reason: "其它", detail: msg };
  }

  // #2.1 风控信号检测：验证码/滑块、账号或登录异常。命中返回原因字符串，否则 null。
  // 保守判定（误报会停掉整批，代价高）：优先认专用验证码容器，文案匹配收紧。
  function detectRiskControl() {
    if (document.querySelector(
      ".captcha_verify_container, #captcha-verify-image, .secsdk-captcha-drag-icon, .vc-captcha, iframe[src*='captcha']"
    )) return "验证码/滑块验证";
    const body = document.body ? document.body.textContent || "" : "";
    if (/请完成(安全)?验证|拖动滑块完成|完成拼图验证|向右滑动完成验证/.test(body)) return "需要安全验证";
    if (/登录已失效|登录状态已过期|请重新登录|账号存在安全风险|账号异常，请/.test(body)) return "账号/登录异常";
    return null;
  }

  // 命中风控：通知调度器暂停整批，保留本页供用户处理，不上报失败、不关页
  function signalRiskPause(reason) {
    if (batchPaused) return;
    batchPaused = true;
    dlog("🛑 风控暂停：" + reason);
    setStatus("🛑 检测到「" + reason + "」：已暂停全部上传，请在本页完成处理后再重新开始", "error");
    try { chrome.runtime.sendMessage({ type: "PAUSE_BATCH", sessionId: currentSessionId, reason }); } catch (_) {}
  }

  // 主动向后台拉取本标签页要发布的章节（规避 background 推送的竞态）
  requestTaskWithRetry();

  function requestTaskWithRetry(attempt = 0) {
    chrome.runtime.sendMessage({ type: "REQUEST_TASK" }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.success && resp.task) {
        setStatus("📥 已拉取章节：" + resp.task.title);
        fillChapter({ task: resp.task, sessionId: resp.sessionId });
      } else if (attempt < 6) {
        setTimeout(() => requestTaskWithRetry(attempt + 1), 500); // 任务可能还没存好，重试
      } else {
        // 正常情况：本页不是自动上传打开的（如草稿创建后重载的二次注入、或人工手动编辑页）
        dlog("本页无待发任务，发布器待命（非自动上传页面，正常）");
      }
    });
  }

  async function fillChapter({ task, sessionId }) {
    if (processing) return;
    processing = true;
    currentTask = task;
    currentSessionId = sessionId;
    dialogHandled = false;
    submitted = false;

    // #2.1 进页就先查风控：若已弹验证码/账号异常，立刻暂停整批，别再操作
    const earlyRisk = detectRiskControl();
    if (earlyRisk) { signalRiskPause(earlyRisk); processing = false; return; }
    dlog(`▼ 开始：第${task.chapterNumber}章「${task.title}」 正文${(task.content || "").length}字 发布时间=${task.publishTime || "now"}`);

    try {
      // 读取本次会话设置（dryRun / detectionMode / pace 等）
      const { upload_session } = await chrome.storage.local.get("upload_session");
      currentSettings = upload_session?.settings || {};
      paceFactor = currentSettings.pace || 1; // 操作节奏：放慢所有 delay
      humanize = currentSettings.humanize !== false; // 拟人随机延迟，默认开

      if (await stopRequested()) return abortByStop(task, sessionId);
      setStatus("⏳ 等待编辑器加载…");
      await waitForForm();
      if (await stopRequested()) return abortByStop(task, sessionId);
      setStatus("✏️ 填写章节号 / 标题…");
      await fillTitle(task);
      setStatus("📄 填写正文…");
      await fillContent(task);
      await delay(1500); // 等番茄注册正文并自动保存，避免"下一步"因内容未就绪而无效

      // 点下一步前校验正文真的填进去了（番茄富文本偶发不注册，或被草稿弹窗打断）。
      // 先补填一次；仍为空则在"创建章节之前"失败——既不会发空章，也安全可重试。
      if (task.content && (findContentArea()?.textContent || "").trim().length < 5) {
        setStatus("📄 正文未注册，补填一次…");
        dismissDraftPrompt();
        dismissVersionConflict();
        await delay(800);
        await fillContent(task);
        await delay(1500);
        if ((findContentArea()?.textContent || "").trim().length < 5) {
          throw new Error("正文未成功填入，已中止（可安全重试）");
        }
      }

      // 草稿/冲突弹窗可能打断过填写——标题/章节号空了就补填
      const titleEl = findTitleInput();
      if (titleEl && !(titleEl.value || "").trim()) {
        setStatus("✏️ 标题为空，补填章节号/标题…");
        await fillTitle(task);
        await delay(500);
      }

      // 🧪 试填模式：填完就停，不提交、不关页，让用户检查
      if (currentSettings.dryRun) {
        setStatus("🧪 试填模式：已填好，未点发布，请人工检查", "success");
        processing = false;
        return; // 不发送 TASK_DONE，调度器会停在这一章（符合预期）
      }

      // ⏹ 最后一道闸：点"下一步"前响应停止——此刻章节还没创建，停下零副作用
      if (await stopRequested()) return abortByStop(task, sessionId);

      setStatus("🚀 点击下一步 / 发布，处理弹窗…");
      const ok = await submitAndConfirm();
      if (!ok) throw new Error("未能确认发布成功（超时或未跳转回章节管理页）");

      setStatus("🎉 发布成功，本页即将关闭", "success");
      // 通知调度器本章完成；rateLimited 让调度器自适应降速（这章虽成功但触发过限流）
      chrome.runtime.sendMessage({ type: "TASK_DONE", taskId: task.id, sessionId, rateLimited: sawRateLimit });
    } catch (e) {
      // 风控已暂停整批：保留本页供用户处理，不上报失败、不关页（PAUSE_BATCH 已发出）
      if (batchPaused) { return; } // finally 仍会把 processing 置回
      // 已点过下一步(submitted)的失败由调度器防重复兜底处理，属可控情况 → 用 warn 不刷红
      (submitted ? console.warn : console.error)("本章未确认成功:", e.message || e);
      const { reason, detail } = classifyFailure(e);
      setStatus("⚠️ 本章未确认成功：" + (e.message || e), "error");
      dlog(`失败归类：[${reason}] ${detail}`);
      if (!DEBUG) {
        // 带上 submitted（防重复）+ reason/detail（失败归类）+ rateLimited（自适应降速）
        chrome.runtime.sendMessage({ type: "TASK_FAILED", taskId: task.id, sessionId, submitted, reason, detail, rateLimited: sawRateLimit });
        setTimeout(() => chrome.runtime.sendMessage({ type: "CLOSE_TAB" }), 1500);
      }
      // DEBUG=true：不关页、不上报失败，停在原地让你看横幅卡在哪一步
    } finally {
      processing = false;
    }
  }

  // 响应停止信号：本章未提交，干净中止并通知调度器
  function abortByStop(task, sessionId) {
    setStatus("⏹ 已停止（本章未提交）", "warning");
    chrome.runtime.sendMessage({ type: "TASK_STOPPED", taskId: task.id, sessionId });
    processing = false;
  }

  // ---------- 等表单就绪 ----------
  async function waitForForm() {
    const ready = await waitFor(() => {
      dismissDraftPrompt();      // 草稿提示 → 继续编辑
      dismissVersionConflict();  // 版本冲突 → 继续编辑本地
      return findTitleInput() && findContentArea();
    }, { timeout: 15000, interval: 500 });
    if (!ready) throw new Error("表单加载超时");
  }

  // ---------- 元素查找（多重选择器兜底，全部走 SEL 配置）----------
  function findTitleInput() { return query(SEL.titleInput); }
  function findChapterNumberInput() { return query(SEL.chapterNumberInput); }
  function findContentArea() { return query(SEL.contentArea); }

  // ---------- 填标题 / 章节号 ----------
  async function fillTitle(task) {
    const numInput = findChapterNumberInput();
    if (numInput) {
      const num = String(task.chapterNumber || extractNumber(task.title) || "");
      if (num) await typeInto(numInput, num);
    }
    const titleInput = findTitleInput();
    if (!titleInput) throw new Error("未找到标题输入框");
    // 去掉"第N章"前缀（章节号已单独填入）。兼容"第 56 章"这种带空格的写法，及冒号/顿号等分隔符
    const pure = task.title.replace(/^\s*第\s*\d+\s*章[\s：:、.．·\-]*/, "").trim() || task.title;
    dlog(`填标题：章节号框${numInput ? "✓" : "✗"} 标题="${pure}"`);
    await typeInto(titleInput, pure);
  }

  // 受控组件：逐字符写入并派发 input/change 事件
  async function typeInto(el, text) {
    el.focus();
    setNativeValue(el, "");
    for (const ch of text) {
      setNativeValue(el, el.value + ch);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      // 逐字输入随机间隔：开启拟人时 30~120ms 不等，模拟真人手速；偶尔"停顿"
      await new Promise((r) => setTimeout(r, (humanize ? rand(30, 120) : 20) * paceFactor));
      if (humanize && Math.random() < 0.05) await new Promise((r) => setTimeout(r, rand(250, 600)));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // 绕过 React 对 value 的劫持：用原生 setter 写值
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
  }

  // ---------- 填正文 ----------
  async function fillContent(task) {
    if (!task.content) return;
    const area = findContentArea();
    if (!area) throw new Error("未找到正文编辑区");
    area.focus();
    await delay(300);

    if (area.classList.contains("ProseMirror") || area.getAttribute("contenteditable") === "true") {
      // 富文本：按段落塞 <p>
      const paras = task.content.split("\n").map((s) => s.trim()).filter(Boolean);
      area.innerHTML = "";
      for (const p of paras) {
        const el = document.createElement("p");
        el.textContent = p;
        area.appendChild(el);
      }
      area.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (area.tagName === "TEXTAREA") {
      setNativeValue(area, task.content);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    }
    dlog(`填正文：编辑器=${area.classList.contains("ProseMirror") ? "ProseMirror" : area.tagName} 写入后${(area.textContent || "").trim().length}字`);
  }

  // ---------- 提交 + 处理弹窗 + 判断成功 ----------
  async function submitAndConfirm() {
    // 优先专用 class，再按精确文本找，避免误点"发布设置/发布记录"等
    const clickSubmit = () => {
      const btn = query(SEL.submitButton) || findButtonByText(SEL.submitText);
      if (btn) { dlog(`点下一步：按钮文字="${(btn.textContent || "").trim()}"`); realClick(btn); return true; }
      return false;
    };
    if (!clickSubmit()) throw new Error("未找到提交按钮");

    return new Promise((resolve, reject) => {
      let n = 0;
      let detectTicks = 0;
      let conflictCount = 0; // 版本冲突被处理的次数——反复出现说明清不掉，快速失败去重试
      const timer = setInterval(async () => {
        n++;
        // #2.1 风控优先：提交后若弹出验证码/账号异常，立即停整批，不再点任何按钮
        const risk = detectRiskControl();
        if (risk) { clearInterval(timer); signalRiskPause(risk); resolve(false); return; }
        // 成功标志：跳转回章节管理页
        if (/\/main\/writer\/chapter-manage\/\d+/.test(location.href)) {
          clearInterval(timer);
          resolve(true);
          return;
        }

        // 番茄"正在为你检测风险内容"阶段可能较久——耐心等（要多久等多久）：
        // 冻结超时计数、不重点下一步，等检测结束弹出"发布设置"再继续
        if ((document.body.textContent || "").includes("正在为你检测风险内容")) {
          n--; // 冻结超时
          detectTicks++;
          if (detectTicks % 5 === 1) setStatus("🛡️ 番茄正在检测风险内容，耐心等待…（" + detectTicks + "s）");
          return;
        }

        // 草稿提示拦截了"下一步"——清掉后重新点一次继续
        if (dismissDraftPrompt()) {
          setTimeout(clickSubmit, 700);
          return;
        }
        // 版本冲突：选「继续编辑本地」后重点下一步。但若反复出现（清不掉），
        // 别空等 5 分钟看门狗——到阈值就快速失败，交给调度器立即重试（实测重试即成功）。
        if (dismissVersionConflict()) {
          if (++conflictCount >= 6) {
            clearInterval(timer);
            reject(new Error("版本冲突反复出现，已中止本章（将自动重试）"));
            return;
          }
          setTimeout(clickSubmit, 1200); // 拉长间隔，避免每秒猛点
          return;
        }

        // ⓪ 内容检测方式弹窗：默认点「仅基础检测」(不限次)，避免烧光全面检测额度
        const detectBtn = findDetectionButton();
        if (detectBtn) {
          submitted = true; // 走到检测说明"下一步"已生效、章节草稿已创建
          realClick(detectBtn);
          setStatus("🔍 内容检测：已选「" + (detectBtn.textContent?.trim()) + "」，等待…");
          return; // 点完等下一轮
        }

        // ① 发布设置对话框（含定时开关 + 日期/时间选择器）——只处理一次
        const publishDialog = document.querySelector(SEL.publishDialog);
        if (publishDialog) submitted = true; // 到发布弹窗，章节草稿必已创建
        if (publishDialog && !dialogHandled) {
          dialogHandled = true;
          clearInterval(timer);
          try {
            await handlePublishDialog();        // 设 AI/定时 + 点确认发布
            resolve(await waitForPublishResult()); // 判断是否真的发布成功
          } catch (e) {
            dlog("处理发布对话框失败：" + (e.message || e));
            resolve(false);
          }
          return;
        }

        // ② 其它确认类弹窗（错别字提示 / 二次确认等）——直接点确认
        const genericModal = document.querySelector(".arco-modal-content");
        if (genericModal && !publishDialog) {
          const confirm = document.querySelector(SEL.modalPrimary);
          if (confirm) realClick(confirm);
        }

        // 补救：若一直没出现任何弹窗（说明"下一步"那下没生效），每 4 秒重点一次
        if (n % 4 === 0 && !document.querySelector(".arco-modal")) {
          clickSubmit();
          setStatus("🔁 未见弹窗，重试点击下一步…");
        }

        if (n >= 60) {
          clearInterval(timer);
          resolve(false);
        }
      }, 1000);
    });
  }

  // 点完「确认发布」后判断结果：发布弹窗消失 / 出现成功提示 / 跳回章节管理页 = 成功；
  // 出现错误提示 = 失败。（番茄发定时章节不会跳页，所以不能只看 URL）
  function waitForPublishResult() {
    return new Promise((resolve) => {
      let n = 0;
      // 可见性判断：用 getBoundingClientRect（对 position:fixed 的弹窗/toast 也正确；offsetParent 对 fixed 恒为 null 会误判）
      const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
      const timer = setInterval(() => {
        n++;

        // ★ 权威信号：番茄发布接口的返回（net-hook 截获）。有结果就以它为准，最可靠。
        if (netPublishResult) {
          const r = netPublishResult;
          clearInterval(timer);
          if (r.ok) { setStatus("✅ 发布接口确认成功", "success"); resolve(true); }
          else { setStatus("❌ 发布接口失败：" + (r.message || ("code=" + r.code)), "error"); resolve(false); }
          return;
        }

        const onManage = /\/main\/writer\/chapter-manage\/\d+/.test(location.href);
        const leftPublish = !/\/publish/.test(location.href); // 已离开发布页 = 提交成功
        const successToast = visible(document.querySelector(SEL.successToast));
        const dialogClosed = !visible(document.querySelector(SEL.publishDialog));
        const errToast = document.querySelector(SEL.errorToast);

        // 错误提示：仅当发布弹窗还开着、且不是良性提示(错别字/忽略替换等)时才判失败。
        // 页面上无关的报错气泡（番茄自家统计等）不能把已成功的发布误判成失败。
        if (errToast && visible(errToast) && !dialogClosed) {
          const t = (errToast.textContent || "").trim();
          const benign = ["错别字", "忽略", "替换"].some((k) => t.includes(k));
          if (!benign && t.length > 3) {
            setStatus("❌ 发布报错：" + t, "error");
            clearInterval(timer);
            resolve(false);
            return;
          }
        }

        // 确认发布后可能弹"二次确认"小窗（超7天/夜间发文等）——点掉可见小窗的主按钮继续
        let secondaryHandled = false;
        for (const m of document.querySelectorAll(".arco-modal")) {
          if (m.classList.contains("publish-confirm-container-new")) continue;
          if (!visible(m)) continue;
          const p = m.querySelector("button.arco-btn-primary");
          if (p) { realClick(p); setStatus("↪️ 处理二次确认弹窗"); secondaryHandled = true; break; }
        }
        if (secondaryHandled) return; // 刚点了二次确认，等下一轮再判结果

        // 内联校验错误：弹窗里 .card-error-line 有文字 = 番茄拒绝了（如时间不合规），暴露真实原因
        if (!dialogClosed) {
          const dlg = document.querySelector(SEL.publishDialog);
          const errLine = dlg && [...dlg.querySelectorAll(".card-error-line")]
            .map((e) => (e.textContent || "").trim()).find((t) => t.length > 1);
          if (errLine) {
            setStatus("❌ 发布弹窗校验不通过：" + errLine, "error");
            clearInterval(timer);
            resolve(false);
            return;
          }
        }

        // 自愈：发布弹窗还开着且等了较久——大概率"确认发布"那下没生效，自动重点（更频繁）
        if (!dialogClosed && n > 4 && n % 5 === 0) {
          const footer = document.querySelector(SEL.publishDialog + " .arco-modal-footer");
          const again = footer && [...footer.querySelectorAll("button.arco-btn-primary")]
            .find((b) => (b.textContent || "").includes("确认发布"));
          if (again) {
            closePickerDropdowns();          // 先关掉可能挡住的日期/时间浮层
            realClick(again);                // 单击即可，避免重复提交触发 -1010
            setStatus("🔁 弹窗未关，重点「确认发布」(" + n + ")…");
            return;
          }
        }

        // ⚠️ "弹窗关闭"判成功必须同时满足：页面上没有任何可见弹窗 + 持续一段时间。
        // 否则"发布弹窗关→二次确认弹出"的空档会被误判成功，提前开下一章的 tab。
        const anyModalVisible = [...document.querySelectorAll(".arco-modal")].some(visible);
        if (onManage || leftPublish || successToast || (dialogClosed && !anyModalVisible && n >= 4)) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (n >= 40) {
          // 超时前最后兜底：已离开发布页 或 弹窗已不可见 = 其实成功了
          const ok2 = onManage || leftPublish || dialogClosed;
          if (!ok2) {
            // 诊断现场：把 URL 和当前可见弹窗记下来，便于定位是哪个弹窗挡住了
            const mods = [...document.querySelectorAll(".arco-modal")].filter(visible)
              .map((m) => m.className.split(" ").slice(0, 2).join("."));
            setStatus("⌛ 超时 url=" + location.pathname.slice(-30) + " 可见弹窗=" + (mods.join("|") || "无"), "error");
          } else {
            setStatus("✅ 超时兜底判定为成功", "success");
          }
          clearInterval(timer);
          resolve(ok2);
        }
      }, 800);
    });
  }

  // ---------- 发布设置对话框：设定时/立即 + 点确认发布 ----------
  async function handlePublishDialog() {
    setStatus("⚙️ 发布设置弹窗：处理 AI / 定时…");
    await delay(800);
    await setAIChoice();                       // 先处理「是否使用AI」
    const pt = currentTask?.publishTime;
    if (pt && pt !== "now") await setScheduledInDialog(pt);
    else await setImmediateInDialog();
    await clickConfirmPublish();
  }

  // 设置「是否使用AI」单选（默认否）
  async function setAIChoice() {
    const want = currentSettings.useAI === "yes" ? "是" : "否";
    const dialog = document.querySelector(SEL.publishDialog) || document;
    // label.arco-radio 里 .arco-radio-text 是"是"/"否"；番茄默认选"是"，需用完整鼠标序列点选并校验
    for (const r of dialog.querySelectorAll(SEL.radio)) {
      if ((r.textContent || "").trim() !== want) continue;
      const input = r.querySelector('input[type="radio"]');
      realClick(input || r);   // 直接点 input（label 转发对合成事件不可靠）
      await delay(200);
      if (!r.classList.contains("arco-radio-checked")) { realClick(r); await delay(200); }
      const ok = r.classList.contains("arco-radio-checked");
      setStatus("🤖 是否使用AI：已选「" + want + "」" + (ok ? "" : "（未确认选中）"));
      return;
    }
    console.warn("⚠️ 未找到『是否使用AI』选项，跳过");
  }

  async function setScheduledInDialog(iso) {
    const d = new Date(iso);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setStatus("⏰ 设置定时发布：" + date + " " + time);

    // 打开"定时发布"开关（当前关闭时）
    const off = document.querySelector(SEL.scheduleSwitchOff);
    if (off) { realClick(off); await delay(800); }

    // 找日期/时间输入框（按当前值的格式区分）
    const pickers = document.querySelectorAll(SEL.pickerInput);
    let dateInput = null, timeInput = null;
    for (const el of pickers) {
      const v = el.value || el.getAttribute("value") || "";
      if (/\d{4}-\d{2}-\d{2}/.test(v)) dateInput = el;
      else if (/^\d{1,2}:\d{2}/.test(v)) timeInput = el;
    }

    if (!dateInput) {
      setStatus("⚠️ 没找到日期框，定时用了番茄默认值", "error");
      return;
    }

    const dok = await pickArcoDate(dateInput, d);

    // 时间：若与目标不同则尝试用时间选择器设置（多更错开时刻需要）
    let tok = true;
    if (timeInput && timeInput.value && timeInput.value.slice(0, 5) !== time) {
      tok = await pickArcoTime(timeInput, d);
    }

    if (dok) setStatus("⏰ 已设定时 " + date + " " + time + "（日期✓ 时间" + (tok ? "✓" : "✗") + "）");
    else setStatus("⚠️ 日历没点中 " + date + "（需校准DOM）", "error");
  }

  // 派发完整鼠标事件序列（Arco 日历靠 mousedown 选中，单纯 .click() 不生效）
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // 模拟点击 Arco 日历选日期：打开面板→翻到目标月→点中那一天
  async function pickArcoDate(input, target) {
    // 打开日历面板（聚焦 + 真实点击输入框/外层包裹）
    const wrapper = input.closest(".arco-picker") || input;
    input.focus();
    realClick(wrapper);

    await waitFor(() => document.querySelector(SEL.calPanel), { timeout: 2500 });
    const panel = document.querySelector(SEL.calPanel);
    if (!panel) { console.warn("⚠️ 日历面板未出现"); return false; }

    // 翻到目标年月（头部如「2026年6月」）
    const targetYM = target.getFullYear() * 12 + target.getMonth();
    for (let i = 0; i < 24; i++) {
      const val = panel.querySelector(SEL.calHeaderValue);
      const ym = parseYearMonth(val?.textContent || "");
      if (ym === null || ym === targetYM) break;
      const icons = panel.querySelectorAll(SEL.calHeaderIcon); // [双左,左,右,双右]
      const icon = ym < targetYM ? icons[2] : icons[1];        // 下月 / 上月
      if (!icon) break;
      realClick(icon);
      await delay(300);
    }

    // 点目标日（本月内、未禁用的格子）
    for (const cell of panel.querySelectorAll(SEL.calCell)) {
      const v = cell.querySelector(SEL.calCellValue);
      if (v && v.textContent.trim() === String(target.getDate())) {
        realClick(cell);
        await delay(400);
        return true;
      }
    }
    return false;
  }

  // 模拟点击 Arco 时间选择器选时:分（多更错开时刻用）。返回是否成功。
  async function pickArcoTime(input, target) {
    realClick(input.closest(".arco-picker") || input);
    const ok = await waitFor(() => document.querySelector(SEL.timePanel), { timeout: 2500 });
    if (!ok) { console.warn("⚠️ 时间面板未出现"); return false; }

    const cols = document.querySelectorAll(SEL.timeCol); // [时, 分]
    const want = [pad(target.getHours()), pad(target.getMinutes())];
    let done = 0;
    for (let c = 0; c < Math.min(2, cols.length); c++) {
      for (const cell of cols[c].querySelectorAll(SEL.timeCell)) {
        const inner = cell.querySelector(SEL.timeCellInner) || cell;
        if ((inner.textContent || "").trim() === want[c]) {
          cell.scrollIntoView({ block: "center" });
          await delay(100);
          realClick(cell); // 点 li 容器（与日历一致，已验证可用）
          await delay(200);
          done++;
          break;
        }
      }
    }
    // 点面板底部「确定」应用并关闭（关键：不点确定时间不生效、浮层也不关）
    const confirm = [...document.querySelectorAll(SEL.timePanel + " button")]
      .find((b) => (b.textContent || "").trim() === "确定");
    if (confirm) { realClick(confirm); await delay(300); }
    return done >= 2;
  }

  // 解析日历头部 "2026年6月" / "2026-06" / "2026 / 06" → year*12 + (month-1)
  function parseYearMonth(text) {
    const m = (text || "").match(/(\d{4})\D+(\d{1,2})/);
    if (!m) return null;
    return (+m[1]) * 12 + (+m[2] - 1);
  }

  async function setImmediateInDialog() {
    // 若定时开关是开启状态，关掉它 = 立即发布
    const on = document.querySelector(SEL.scheduleSwitchOn);
    if (on) { realClick(on); await delay(400); }
  }

  // 关掉可能打开的日期/时间下拉浮层：在弹窗标题处触发 mousedown，触发 Arco"点击外部关闭"
  // 否则下拉开着时，点"确认发布"那一下只会关浮层、不会真正提交，导致卡住超时。
  function closePickerDropdowns() {
    const dlg = document.querySelector(SEL.publishDialog);
    const spot = dlg?.querySelector(".arco-modal-header, .arco-modal-title") || dlg;
    if (spot) {
      spot.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      spot.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    }
  }

  async function clickConfirmPublish() {
    await delay(400);
    closePickerDropdowns(); // 先关下拉浮层，确保"确认发布"是真正提交而非只关浮层
    await delay(400);
    // ⚠️ 只在弹窗【底部 footer】找主按钮！弹窗里还藏着时间选择器的"确定"按钮，
    //    若全局搜会误点那个隐藏的"确定"（它在 DOM 里排在前面），导致发布点不动。
    const dialog = document.querySelector(SEL.publishDialog) || document;
    const footer = dialog.querySelector(".arco-modal-footer") || dialog;
    const primaries = [...footer.querySelectorAll("button.arco-btn-primary")];
    let btn = primaries.find((b) => (b.textContent || "").trim().includes("确认发布")) || primaries[0];
    if (!btn) throw new Error("未找到『确认发布』按钮");
    netPublishResult = null; // 清空，只采信本次确认发布触发的接口结果
    // ⚠️ 只点【一次】：realClick 的完整鼠标序列(mousedown+mouseup+click)足以触发番茄的提交。
    //    早期"三管齐下"(再点 span + 原生 click)会让 React onClick 触发 2~3 次，
    //    同一秒内重复打发布接口 → 番茄回 -1010「操作太频繁」。这是限流的根因，已去除。
    //    万一这一次没生效，waitForPublishResult 里的"弹窗未关就重点"自愈会兜底重发。
    realClick(btn);
    setStatus("✅ 已点击确认发布，等待跳转…");
    await delay(1200);
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  // ---------- 工具 ----------
  function query(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  // 「有刚刚更新的草稿，是否继续编辑？」提示：点「继续编辑」
  // ⚠️ 不依赖弹窗类名（这个"提示"弹窗可能不是标准 Arco modal）——
  //    只要页面上出现提示文字，就全局找文字精确为「继续编辑」的按钮点掉。
  //    必须点继续编辑：点"放弃"会把我们刚填好的标题/正文一起清空。
  function dismissDraftPrompt() {
    if (!(document.body.textContent || "").includes("有刚刚更新的草稿")) return false;
    const b = [...document.querySelectorAll("button")]
      .find((x) => (x.textContent || "").trim() === "继续编辑");
    if (!b) return false;
    realClick(b);
    try { b.click(); } catch (_) {}
    setStatus("📝 草稿提示 → 继续编辑（保留已填内容）");
    return true;
  }

  // 「版本冲突提示」：点「继续编辑本地」(保留我们刚填的内容，而不是云端旧版本)
  function dismissVersionConflict() {
    if (!(document.body.textContent || "").includes("版本冲突")) return false;
    const b = [...document.querySelectorAll("button")]
      .find((x) => (x.textContent || "").trim() === "继续编辑本地");
    if (!b) return false;
    realClick(b);
    try { b.click(); } catch (_) {}
    setStatus("🔀 版本冲突：已选「继续编辑本地」");
    return true;
  }

  // 「请选择内容检测方式」弹窗：返回应点击的按钮（默认仅基础检测）
  function findDetectionButton() {
    const modals = document.querySelectorAll(SEL.modal);
    for (const m of modals) {
      if (!m.textContent?.includes("内容检测方式")) continue;
      // 默认全面检测（每章 2 次额度）；仅当显式设为 basic 时才用基础检测
      const wantFull = currentSettings.detectionMode !== "basic";
      const buttons = [...m.querySelectorAll("button")];
      const find = (pred) => buttons.find(pred);
      const isDisabled = (b) =>
        b.disabled || b.classList.contains("arco-btn-disabled") ||
        b.getAttribute("aria-disabled") === "true";

      const fullBtn = find((b) => (b.textContent || "").trim() === "全面检测");
      const basicBtn = find((b) => (b.textContent || "").includes("仅基础检测"));

      if (wantFull && fullBtn && !isDisabled(fullBtn)) return fullBtn;
      if (wantFull && (!fullBtn || isDisabled(fullBtn)) && basicBtn) {
        console.log("ℹ️ 全面检测次数已用完，回退到仅基础检测");
        return basicBtn;
      }
      if (!wantFull && basicBtn) return basicBtn;
    }
    return null;
  }

  function findButtonByText(texts) {
    const btns = [...document.querySelectorAll("button")];
    // 先按 texts 顺序精确匹配（"下一步" 优先于 "发布"），再退化到包含匹配
    for (const x of texts) {
      const exact = btns.find((b) => (b.textContent || "").trim() === x);
      if (exact) return exact;
    }
    for (const b of btns) {
      if (texts.some((x) => (b.textContent || "").includes(x))) return b;
    }
    return null;
  }

  function extractNumber(title) {
    const m = (title || "").match(/第\s*(\d+)\s*章/);
    return m ? parseInt(m[1], 10) : null;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, jitter(ms) * paceFactor));
  }
})();
