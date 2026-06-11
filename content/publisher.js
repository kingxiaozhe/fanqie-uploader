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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "FILL_CHAPTER") {
      fillChapter(msg.data).then(() => sendResponse({ success: true }));
      return true; // 异步
    }
    sendResponse({ success: false, error: "未知消息类型" });
    return true;
  });

  console.log("📝 章节发布器已加载:", location.href);

  async function fillChapter({ task, sessionId }) {
    if (processing) return;
    processing = true;
    console.log("📝 开始填充章节:", task.title);

    try {
      await waitForForm();
      await fillTitle(task);
      await fillContent(task);
      await setPublishOption(task);
      const ok = await submitAndConfirm();
      if (!ok) throw new Error("未能确认发布成功");

      chrome.runtime.sendMessage({ type: "TASK_DONE", taskId: task.id, sessionId });
      setTimeout(() => chrome.runtime.sendMessage({ type: "CLOSE_TAB" }), 800);
    } catch (e) {
      console.error("❌ 发布失败:", e);
      chrome.runtime.sendMessage({ type: "TASK_FAILED", taskId: task.id, sessionId });
      setTimeout(() => chrome.runtime.sendMessage({ type: "CLOSE_TAB" }), 1500);
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
    // 去掉"第N章："前缀，只填纯标题
    const pure = task.title.replace(/^第\d+章[：:]\s*/, "");
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

  // ---------- 发布方式 ----------
  async function setPublishOption(task) {
    // 脚手架默认立即发布；task.publishTime 存在时可扩展为定时
    if (task.publishTime) {
      console.log("⏰ TODO: 设置定时发布", task.publishTime);
    }
    // 立即发布通常是默认项，无需额外操作
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
      const timer = setInterval(() => {
        n++;
        // 成功标志：跳转回章节管理页
        if (/\/main\/writer\/chapter-manage\/\d+/.test(location.href)) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        // 自动点掉确认类弹窗（错别字提示 / 二次确认等）
        const modal = document.querySelector(".arco-modal-content, .arco-modal-footer");
        if (modal) {
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

  // ---------- 工具 ----------
  function query(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
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
