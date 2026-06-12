// ============================================================
//  content/net-hook.js — 运行在页面 MAIN world，hook fetch/XHR
//  截获番茄"发布章节"接口的响应，作为发布成功与否的【权威信号】，
//  通过 window.postMessage 传给隔离世界的 publisher.js。
//  （比观察 DOM 可靠：直接看番茄接口返回的 code/message）
// ============================================================

(function () {
  "use strict";
  const TARGET = "/api/author/publish_article"; // 发布章节接口

  function emit(status, body) {
    let code = null, message = "";
    try {
      const j = JSON.parse(body);
      code = j.code ?? j.err_no ?? j.status_code ?? null;
      message = j.message || j.msg || j.err_tips || j.data?.message || "";
    } catch (_) {}
    // 字节系接口约定 code===0 为成功；解析不出 code 时退回看 HTTP 状态
    const ok = status >= 200 && status < 300 && (code === 0 || code === "0" || code == null);
    window.postMessage({ __fqNet: true, type: "publish-result", status, code, message, ok }, "*");
  }

  // hook fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      let url = "";
      try { url = typeof args[0] === "string" ? args[0] : args[0]?.url || ""; } catch (_) {}
      const p = origFetch.apply(this, args);
      if (url.includes(TARGET)) {
        p.then((res) => res.clone().text().then((t) => emit(res.status, t)).catch(() => {}))
          .catch(() => emit(0, ""));
      }
      return p;
    };
  }

  // hook XMLHttpRequest
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { this.__fqUrl = url; } catch (_) {}
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    try {
      if (typeof this.__fqUrl === "string" && this.__fqUrl.includes(TARGET)) {
        this.addEventListener("loadend", () => emit(this.status, this.responseText));
      }
    } catch (_) {}
    return send.apply(this, a);
  };

  console.log("🔌 番茄发布接口监听已挂载");
})();
