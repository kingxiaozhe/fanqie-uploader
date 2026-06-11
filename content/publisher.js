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
  let currentSettings = {};   // 本次会话的设置（dryRun / detectionMode 等）
  let dialogHandled = false;  // 发布设置对话框是否已处理（防重复）
  let statusEl = null;        // 页面顶部状态横幅
  const DEBUG = false;        // 调试模式：true=失败保留标签页不重试；正式批量请保持 false

  // ============================================================
  //  番茄页面选择器集中配置 —— 番茄改版时，只改这里
  // ============================================================
  const SEL = {
    titleInput: ['input[placeholder="请输入标题"]', "input.serial-editor-input-hint-area", 'input[placeholder*="标题"]', 'input[name="title"]'],
    chapterNumberInput: [".serial-editor-title-left input", ".left-input input"],
    contentArea: ['.ProseMirror[contenteditable="true"]', ".ProseMirror", '[contenteditable="true"]', 'textarea[name="content"]'],
    submitButton: ["button.auto-editor-next", "button.publish-button"],
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
    timeCol: ".arco-timepicker-column",          // 时间面板的"时/分"列
    timeCell: ".arco-timepicker-cell",            // 时间面板里的每个数字格
    successToast: ".arco-message-success, .arco-notification-success",
    errorToast: ".arco-message-error, .arco-notification-error",
    radio: ".arco-radio",
  };

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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "FILL_CHAPTER") {
      fillChapter(msg.data).then(() => sendResponse({ success: true }));
      return true; // 异步
    }
    sendResponse({ success: false, error: "未知消息类型" });
    return true;
  });

  console.log("📝 章节发布器已加载:", location.href);

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
        // 此时 publisher 不做任何事，静默即可，避免在 Errors 面板里显示成"错误"
        console.log("ℹ️ 本页无待发任务，发布器待命（非自动上传页面，正常）");
      }
    });
  }

  async function fillChapter({ task, sessionId }) {
    if (processing) return;
    processing = true;
    currentTask = task;
    dialogHandled = false;
    console.log("📝 开始填充章节:", task.title, "| 发布时间:", task.publishTime || "now");

    // 读取本次会话设置（dryRun / detectionMode 等）
    const { upload_session } = await chrome.storage.local.get("upload_session");
    currentSettings = upload_session?.settings || {};

    try {
      setStatus("⏳ 等待编辑器加载…");
      await waitForForm();
      setStatus("✏️ 填写章节号 / 标题…");
      await fillTitle(task);
      setStatus("📄 填写正文…");
      await fillContent(task);

      // 🧪 试填模式：填完就停，不提交、不关页，让用户检查
      if (currentSettings.dryRun) {
        setStatus("🧪 试填模式：已填好，未点发布，请人工检查", "success");
        processing = false;
        return; // 不发送 TASK_DONE，调度器会停在这一章（符合预期）
      }

      setStatus("🚀 点击下一步 / 发布，处理弹窗…");
      const ok = await submitAndConfirm();
      if (!ok) throw new Error("未能确认发布成功（超时或未跳转回章节管理页）");

      setStatus("🎉 发布成功，本页即将关闭", "success");
      // 通知调度器本章完成；发布 tab 由后台收到 TASK_DONE 后统一关闭（更可靠）
      chrome.runtime.sendMessage({ type: "TASK_DONE", taskId: task.id, sessionId });
    } catch (e) {
      console.error("❌ 发布失败:", e);
      setStatus("❌ 卡住了：" + (e.message || e) + "（调试模式，页面保留）", "error");
      if (!DEBUG) {
        chrome.runtime.sendMessage({ type: "TASK_FAILED", taskId: task.id, sessionId });
        setTimeout(() => chrome.runtime.sendMessage({ type: "CLOSE_TAB" }), 1500);
      }
      // DEBUG=true：不关页、不上报失败，停在原地让你看横幅卡在哪一步
    } finally {
      processing = false;
    }
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
    // 去掉"第N章"前缀（章节号已单独填入），兼容冒号/空格/顿号等分隔符
    const pure = task.title.replace(/^第\d+章[\s：:、.\-]*/, "").trim() || task.title;
    await typeInto(titleInput, pure);
  }

  // 受控组件：逐字符写入并派发 input/change 事件
  async function typeInto(el, text) {
    el.focus();
    setNativeValue(el, "");
    for (const ch of text) {
      setNativeValue(el, el.value + ch);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await delay(20);
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
    console.log("✅ 正文填充完成");
  }

  // ---------- 提交 + 处理弹窗 + 判断成功 ----------
  async function submitAndConfirm() {
    // 优先专用 class，再按精确文本找，避免误点"发布设置/发布记录"等
    const clickSubmit = () => {
      const btn = query(SEL.submitButton) || findButtonByText(SEL.submitText);
      if (btn) { btn.click(); return true; }
      return false;
    };
    if (!clickSubmit()) throw new Error("未找到提交按钮");
    console.log("🚀 已点击提交");

    return new Promise((resolve) => {
      let n = 0;
      const timer = setInterval(async () => {
        n++;
        // 成功标志：跳转回章节管理页
        if (/\/main\/writer\/chapter-manage\/\d+/.test(location.href)) {
          clearInterval(timer);
          resolve(true);
          return;
        }

        // 草稿提示 / 版本冲突拦截了"下一步"——清掉后重新点一次"下一步"继续
        if (dismissDraftPrompt() || dismissVersionConflict()) {
          setTimeout(clickSubmit, 700);
          return;
        }

        // ⓪ 内容检测方式弹窗：默认点「仅基础检测」(不限次)，避免烧光全面检测额度
        const detectBtn = findDetectionButton();
        if (detectBtn) {
          detectBtn.click();
          setStatus("🔍 内容检测：已选「" + (detectBtn.textContent?.trim()) + "」，等待…");
          return; // 点完等下一轮
        }

        // ① 发布设置对话框（含定时开关 + 日期/时间选择器）——只处理一次
        const publishDialog = document.querySelector(SEL.publishDialog);
        if (publishDialog && !dialogHandled) {
          dialogHandled = true;
          clearInterval(timer);
          try {
            await handlePublishDialog();        // 设 AI/定时 + 点确认发布
            resolve(await waitForPublishResult()); // 判断是否真的发布成功
          } catch (e) {
            console.error("❌ 处理发布对话框失败:", e);
            resolve(false);
          }
          return;
        }

        // ② 其它确认类弹窗（错别字提示 / 二次确认等）——直接点确认
        const genericModal = document.querySelector(".arco-modal-content");
        if (genericModal && !publishDialog) {
          const confirm = document.querySelector(SEL.modalPrimary);
          if (confirm) confirm.click();
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
      const timer = setInterval(() => {
        n++;
        const onManage = /\/main\/writer\/chapter-manage\/\d+/.test(location.href);
        const successToast = document.querySelector(SEL.successToast);
        const errToast = document.querySelector(SEL.errorToast);
        const dialogGone = !document.querySelector(SEL.publishDialog);

        if (errToast && (errToast.textContent || "").trim().length > 3) {
          setStatus("❌ 发布报错：" + errToast.textContent.trim(), "error");
          clearInterval(timer);
          resolve(false);
          return;
        }
        if (onManage || successToast || (dialogGone && n >= 2)) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (n >= 25) { clearInterval(timer); resolve(false); }
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
    // 只在含「是否使用AI」字样的那一行附近找单选项
    const radios = dialog.querySelectorAll(SEL.radio);
    for (const r of radios) {
      if ((r.textContent || "").trim() === want) {
        const input = r.querySelector('input[type="radio"]');
        (input || r).click();
        r.click();
        await delay(300);
        setStatus("🤖 是否使用AI：已选「" + want + "」");
        return;
      }
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
    if (off) { off.click(); await delay(800); }

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
    const ok = await waitFor(() => document.querySelector(SEL.timeCol), { timeout: 2500 });
    if (!ok) { console.warn("⚠️ 时间面板未出现"); return false; }
    const cols = document.querySelectorAll(SEL.timeCol); // 通常 [时, 分]（可能含秒）
    const want = [target.getHours(), target.getMinutes()];
    let done = 0;
    for (let c = 0; c < Math.min(2, cols.length); c++) {
      const target2 = String(want[c]).padStart(2, "0");
      for (const cell of cols[c].querySelectorAll(SEL.timeCell)) {
        const t = (cell.textContent || "").trim();
        if (t === target2 || t === String(want[c])) {
          realClick(cell);
          await delay(250);
          done++;
          break;
        }
      }
    }
    return done >= 1;
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
    if (on) { on.click(); await delay(400); }
  }

  async function clickConfirmPublish() {
    await delay(600);
    // 限定在发布设置弹窗内找，并校验按钮文字，避免误点别的弹窗按钮
    const dialog = document.querySelector(SEL.publishDialog) || document;
    const primaries = [...dialog.querySelectorAll(SEL.modalPrimary + ", button.arco-btn-primary")];
    let btn = primaries.find((b) => {
      const t = (b.textContent || "").trim();
      return t.includes("确认发布") || t === "确定" || t === "发布";
    }) || primaries[0];
    if (!btn) throw new Error("未找到『确认发布』按钮");
    btn.click();
    setStatus("✅ 已点击确认发布，等待跳转…");
    await delay(1500);
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
  // ⚠️ 必须点继续编辑——点"放弃"会把我们刚填好的标题/正文一起清空（正文字数变 0）。
  function dismissDraftPrompt() {
    for (const m of document.querySelectorAll(SEL.modal)) {
      const t = m.textContent || "";
      if (!t.includes("草稿") || !t.includes("继续编辑")) continue;
      for (const b of m.querySelectorAll("button")) {
        if ((b.textContent || "").trim() === "继续编辑") {
          realClick(b);
          setStatus("📝 草稿提示 → 继续编辑（保留已填内容）");
          return true;
        }
      }
    }
    return false;
  }

  // 「版本冲突提示」：点「继续编辑本地」(保留我们刚填的内容，而不是云端旧版本)
  function dismissVersionConflict() {
    for (const m of document.querySelectorAll(SEL.modal)) {
      if (!(m.textContent || "").includes("版本冲突")) continue;
      for (const b of m.querySelectorAll("button")) {
        if ((b.textContent || "").trim() === "继续编辑本地") {
          realClick(b);
          setStatus("🔀 版本冲突：已选「继续编辑本地」");
          return true;
        }
      }
    }
    return false;
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
    const m = (title || "").match(/第(\d+)章/);
    return m ? parseInt(m[1], 10) : null;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
