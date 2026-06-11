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
  const DEBUG = true;         // 调试模式：失败时保留标签页+红色横幅，不自动关闭/重试

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
        console.warn("⚠️ 未拉取到章节任务（可能不是自动上传打开的页面）");
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

      setStatus("🎉 发布成功，即将跳转", "success");
      chrome.runtime.sendMessage({ type: "TASK_DONE", taskId: task.id, sessionId });
      setTimeout(() => chrome.runtime.sendMessage({ type: "CLOSE_TAB" }), 800);
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
  function waitForForm() {
    return new Promise((resolve, reject) => {
      let n = 0;
      const timer = setInterval(() => {
        n++;
        if (findTitleInput() && findContentArea()) {
          clearInterval(timer);
          resolve();
        } else if (n >= 30) {
          clearInterval(timer);
          reject(new Error("表单加载超时"));
        }
      }, 500);
    });
  }

  // ---------- 元素查找（多重选择器兜底）----------
  function findTitleInput() {
    return query([
      'input[placeholder="请输入标题"]',
      "input.serial-editor-input-hint-area",
      'input[placeholder*="标题"]',
      'input[name="title"]',
    ]);
  }

  function findChapterNumberInput() {
    return query([
      ".serial-editor-title-left input",
      ".left-input input",
    ]);
  }

  function findContentArea() {
    return query([
      '.ProseMirror[contenteditable="true"]',
      ".ProseMirror",
      '[contenteditable="true"]',
      'textarea[name="content"]',
    ]);
  }

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
    const btn = findButtonByText(["下一步", "发布", "提交"]) ||
      query(["button.publish-button", 'button[type="submit"]']);
    if (!btn) throw new Error("未找到提交按钮");
    btn.click();
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

        // ⓪ 内容检测方式弹窗：默认点「仅基础检测」(不限次)，避免烧光全面检测额度
        const detectBtn = findDetectionButton();
        if (detectBtn) {
          detectBtn.click();
          setStatus("🔍 内容检测：已选「" + (detectBtn.textContent?.trim()) + "」，等待…");
          return; // 点完等下一轮
        }

        // ① 发布设置对话框（含定时开关 + 日期/时间选择器）——只处理一次
        const publishDialog = document.querySelector(".arco-modal.publish-confirm-container-new");
        if (publishDialog && !dialogHandled) {
          dialogHandled = true;
          clearInterval(timer);
          try {
            await handlePublishDialog();
            // 处理完继续轮询等待跳转
            resumePolling(resolve);
          } catch (e) {
            console.error("❌ 处理发布对话框失败:", e);
            resolve(false);
          }
          return;
        }

        // ② 其它确认类弹窗（错别字提示 / 二次确认等）——直接点确认
        const genericModal = document.querySelector(".arco-modal-content");
        if (genericModal && !publishDialog) {
          const confirm = document.querySelector(".arco-modal-footer button.arco-btn-primary");
          if (confirm) confirm.click();
        }

        if (n >= 60) {
          clearInterval(timer);
          resolve(false);
        }
      }, 1000);
    });
  }

  // 处理完发布对话框后，继续轮询等待页面跳转
  function resumePolling(resolve) {
    let n = 0;
    const timer = setInterval(() => {
      n++;
      if (/\/main\/writer\/chapter-manage\/\d+/.test(location.href)) {
        clearInterval(timer);
        resolve(true);
      } else if (n >= 30) {
        clearInterval(timer);
        resolve(false);
      }
    }, 1000);
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
    const dialog = document.querySelector(".arco-modal.publish-confirm-container-new") || document;
    // 只在含「是否使用AI」字样的那一行附近找单选项
    const radios = dialog.querySelectorAll(".arco-radio");
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
    const off = document.querySelector('.arco-switch[aria-checked="false"]');
    if (off) { off.click(); await delay(800); }

    // 填日期/时间选择器（番茄用 .arco-picker-start-time，按内容区分日期框/时间框）
    const pickers = document.querySelectorAll(".arco-picker-start-time, .arco-picker input");
    let dateInput = null, timeInput = null;
    for (const el of pickers) {
      const v = el.value || "";
      if (/\d{4}-\d{2}/.test(v)) dateInput = el;
      else if (/\d{1,2}:\d{2}/.test(v)) timeInput = el;
    }
    if (dateInput) await setPicker(dateInput, date);
    if (timeInput) await setPicker(timeInput, time);
    if (!dateInput && !timeInput) console.warn("⚠️ 未找到日期/时间输入框，定时可能未生效");
  }

  async function setPicker(el, value) {
    el.focus();
    setNativeValue(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    await delay(400);
  }

  async function setImmediateInDialog() {
    // 若定时开关是开启状态，关掉它 = 立即发布
    const on = document.querySelector('.arco-switch[aria-checked="true"]');
    if (on) { on.click(); await delay(400); }
  }

  async function clickConfirmPublish() {
    await delay(600);
    const span = document.querySelector(".arco-modal-footer button.arco-btn-primary span");
    const btn = span?.parentElement || query([".arco-modal-footer button.arco-btn-primary"]);
    if (!btn) throw new Error("未找到『确认发布』按钮");
    btn.click();
    setStatus("✅ 已点击确认发布，等待跳转…");
    await delay(1500);
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  // 试填模式横幅：醒目提示"已填好但未发布"
  function showDryRunBanner() {
    const bar = document.createElement("div");
    bar.textContent = "🧪 试填模式：标题与正文已自动填入，未点击发布。请人工检查无误后手动操作。";
    bar.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:999999;
      background:#f39c12;color:#fff;padding:12px 16px;text-align:center;
      font:600 14px/1.4 system-ui;box-shadow:0 2px 8px rgba(0,0,0,.3);`;
    document.body.appendChild(bar);
  }

  // ---------- 工具 ----------
  function query(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  // 「请选择内容检测方式」弹窗：返回应点击的按钮（默认仅基础检测）
  function findDetectionButton() {
    const modals = document.querySelectorAll(".arco-modal-content, .arco-modal");
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
    for (const btn of document.querySelectorAll("button")) {
      const t = btn.textContent || "";
      if (texts.some((x) => t.includes(x))) return btn;
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
