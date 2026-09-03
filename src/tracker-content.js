// 投递事件检测（隔离世界，document_idle 注入）。
// 信号来源（按可靠程度排序）：
//   1. td:apply 桥事件 —— tracker-page.js 在页面世界监听投递接口的成功响应（最准）
//   2. 点击"投递/沟通"类按钮 —— DOM 兜底
//   3. 页面出现"投递成功"提示 —— DOM 兜底
//   4. popup 发来的 TD_RECORD_PAGE —— 手动记录，会向页面世界请求精确提取
// 所有信号统一走 recordAttempt()：同 URL 8 秒内只记一次，background 再做 10 分钟级去重。
(() => {
  if (window.__TD_TRACKER_LOADED__) {
    return;
  }
  window.__TD_TRACKER_LOADED__ = true;

  const APPLY_TEXT_RE = /(立即沟通|继续沟通|投递简历|立即投递|快速投递|立即申请|申请职位|发送简历|投个简历)/;
  const SUCCESS_TEXT_RE = /(投递成功|已投递|简历已发送|已发送简历|申请成功)/;
  const SIGNAL_THROTTLE_MS = 8000;
  const EXTRACT_TIMEOUT_MS = 900;

  let lastSignalAt = 0;
  let lastSignalUrl = "";
  const pendingExtracts = new Map(); // requestId -> {resolve, timer}

  // ---------- 信号 1：页面世界的网络监听结果 ----------

  window.addEventListener("td:apply", (event) => {
    let payload = {};
    try {
      payload = JSON.parse(event.detail || "{}");
    } catch {
      return;
    }
    recordAttempt(payload);
  });

  // ---------- 信号 4：popup 手动记录 ----------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "TD_RECORD_PAGE") {
      return undefined;
    }
    void (async () => {
      try {
        const extracted = await requestPageExtract();
        sendResponse({ ok: true, data: extracted });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true; // 异步响应
  });

  // 向页面世界请求最优提取（超时则返回空，由本地提取兜底）
  function requestPageExtract() {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pendingExtracts.delete(requestId);
        resolve(null);
      }, EXTRACT_TIMEOUT_MS);
      pendingExtracts.set(requestId, { resolve, timer });
      try {
        window.dispatchEvent(new CustomEvent("td:extract-request", { detail: JSON.stringify({ requestId }) }));
      } catch {
        clearTimeout(timer);
        pendingExtracts.delete(requestId);
        resolve(null);
      }
    });
  }

  window.addEventListener("td:extract-result", (event) => {
    let payload = {};
    try {
      payload = JSON.parse(event.detail || "{}");
    } catch {
      return;
    }
    const pending = pendingExtracts.get(payload.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingExtracts.delete(payload.requestId);
      pending.resolve(payload.data || null);
    }
  });

  // ---------- 站点本地提取（网络信号缺字段时兜底） ----------

  function pickText(selectors, max = 80) {
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        const text = el?.textContent?.replace(/\s+/g, " ").trim();
        if (text) {
          return text.slice(0, max);
        }
      } catch {
        // 非法选择器，跳过
      }
    }
    return "";
  }

  function extractBoss() {
    const infoLine = pickText([".job-banner .info-primary p", ".job-primary .info-primary p"]);
    return {
      jobTitle: pickText([".name h1", ".info-primary .name h1", "h1"]),
      salary: pickText([".job-banner .salary", ".info-primary .salary"]),
      company: pickText([".job-sider .company-info .name", ".company-box .company-text .name"]),
      city: (infoLine.split("·")[0] || "").trim().slice(0, 20)
    };
  }

  function parseTitleFallback(title) {
    const parts = String(title || "")
      .split(/[_\-|·｜—]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    return {
      jobTitle: parts[0] || "",
      company: parts.length >= 2 ? parts[1] : ""
    };
  }

  function extractGeneric() {
    const fromTitle = parseTitleFallback(document.title);
    return {
      jobTitle: pickText(["h1"]) || fromTitle.jobTitle,
      salary: "",
      company: pickText(['[class*="company-name"]', '[class*="companyName"]']) || fromTitle.company,
      city: ""
    };
  }

  const SITE_EXTRACTORS = [
    { host: /(^|\.)zhipin\.com$/, extract: extractBoss }
  ];

  function localExtract() {
    const config = SITE_EXTRACTORS.find((c) => c.host.test(location.hostname));
    let info = {};
    try {
      info = (config ? config.extract() : extractGeneric()) || {};
    } catch {
      info = {};
    }
    const fallback = parseTitleFallback(document.title);
    return {
      company: info.company || fallback.company || "",
      jobTitle: info.jobTitle || fallback.jobTitle || "",
      city: info.city || "",
      salary: info.salary || ""
    };
  }

  // ---------- 统一记录入口 ----------

  function isThrottled(url) {
    const now = Date.now();
    if (now - lastSignalAt < SIGNAL_THROTTLE_MS && lastSignalUrl === url) {
      return true;
    }
    lastSignalAt = now;
    lastSignalUrl = url;
    return false;
  }

  function recordAttempt(payload = {}) {
    const url = payload.url || location.href;
    if (isThrottled(url)) {
      return;
    }
    if (!payload.company || !payload.jobTitle) {
      const local = localExtract();
      payload.company = payload.company || local.company;
      payload.jobTitle = payload.jobTitle || local.jobTitle;
      payload.city = payload.city || local.city;
      payload.salary = payload.salary || local.salary;
    }
    chrome.runtime.sendMessage({ type: "TD_ADD_RECORD", payload: { ...payload, url } })
      .then((response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          return;
        }
        const record = response.data?.record || {};
        if (response.data?.duplicate) {
          showToast("本次投递之前已记录过，不用重复记啦");
        } else {
          const label = record.company || record.jobTitle || "新投递";
          showToast(`✅ 已记录投递：${label}`);
        }
      })
      .catch(() => undefined);
  }

  // ---------- 信号 2：点击监听（捕获阶段，只在按钮类元素上匹配文案） ----------

  function isButtonLike(el) {
    const tag = el.tagName;
    if (tag === "BUTTON" || tag === "A") {
      return true;
    }
    if (el.getAttribute("role") === "button") {
      return true;
    }
    return /(btn|button)/i.test(String(el.className || ""));
  }

  document.addEventListener(
    "click",
    (event) => {
      const path = event.composedPath ? event.composedPath() : [event.target];
      for (const node of path) {
        if (!(node instanceof Element) || !isButtonLike(node)) {
          continue;
        }
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (text && text.length <= 30 && APPLY_TEXT_RE.test(text)) {
          recordAttempt({ source: "dom" });
          return;
        }
      }
    },
    true
  );

  // ---------- 信号 3：成功提示监听 ----------
  // 节流由 recordAttempt 内的 isThrottled 统一处理。

  const toastObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (text && text.length <= 40 && SUCCESS_TEXT_RE.test(text)) {
          recordAttempt({ source: "toast" });
          return;
        }
      }
    }
  });

  try {
    toastObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    // 页面环境异常时静默放弃监听
  }

  // ---------- 页面右下角轻提示 ----------

  function showToast(message) {
    try {
      const toast = document.createElement("div");
      toast.textContent = message;
      Object.assign(toast.style, {
        position: "fixed",
        right: "20px",
        bottom: "24px",
        zIndex: "2147483647",
        background: "rgba(30, 35, 60, 0.92)",
        color: "#fff",
        padding: "10px 16px",
        borderRadius: "10px",
        fontSize: "13px",
        lineHeight: "1.5",
        maxWidth: "320px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.25)",
        transition: "opacity 0.4s",
        pointerEvents: "none"
      });
      document.documentElement.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 500);
      }, 2400);
    } catch {
      // 忽略样式注入失败
    }
  }
})();
