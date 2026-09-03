// 投递事件检测：常驻各大招聘网站（由 manifest content_scripts 声明注入）。
// 只做两件事：识别用户点击了"投递/沟通"类按钮（或页面出现投递成功提示），
// 把当前岗位信息发给 background 记录。不修改页面、不上传数据。
(() => {
  if (window.__TD_TRACKER_LOADED__) {
    return;
  }
  window.__TD_TRACKER_LOADED__ = true;

  const APPLY_TEXT_RE = /(立即沟通|继续沟通|投递简历|立即投递|快速投递|立即申请|申请职位|发送简历|投个简历)/;
  const SUCCESS_TEXT_RE = /(投递成功|已投递|简历已发送|已发送简历|申请成功)/;
  const SIGNAL_THROTTLE_MS = 8000;

  let lastSignalAt = 0;
  let lastSignalUrl = "";

  // ---------- 站点信息提取（尽力而为，失败就走通用兜底，用户可在看板里改） ----------

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
    const infoLine = pickText([
      ".job-banner .info-primary p",
      ".job-primary .info-primary p"
    ]);
    return {
      jobTitle: pickText([".name h1", ".info-primary .name h1", "h1"]),
      salary: pickText([".job-banner .salary", ".info-primary .salary"]),
      company: pickText([
        ".job-sider .company-info .name",
        ".company-box .company-text .name",
        "[ka='job-detail_company']"
      ]),
      city: (infoLine.split("·")[0] || "").trim().slice(0, 20)
    };
  }

  function extractLiepin() {
    return {
      jobTitle: pickText([".job-apply-container .job-title-text", "h1"]),
      salary: pickText([".job-apply-container .job-salary", ".salary"]),
      company: pickText([".company-name", ".job-company-info .company-name"]),
      city: ""
    };
  }

  function extractZhaoPin() {
    return {
      jobTitle: pickText([".job-name", ".position-head .job-name", "h1"]),
      salary: pickText([".job-salary", ".salary"]),
      company: pickText([".company-title", "[class*='companyName']"]),
      city: ""
    };
  }

  function extract51Job() {
    return {
      jobTitle: pickText([".job_title", ".tH_jb", "h1"]),
      salary: pickText([".job_salary", ".salary"]),
      company: pickText([".company", ".cname"]),
      city: pickText([".job_misc", ".info"])
    };
  }

  function extractGeneric() {
    const fromTitle = parseTitleFallback(document.title);
    return {
      jobTitle: pickText(["h1"]) || fromTitle.jobTitle,
      salary: "",
      company: fromTitle.company,
      city: ""
    };
  }

  // 从页面标题猜测岗位和公司，例如 "高级前端工程师_字节跳动_牛客网"
  function parseTitleFallback(title) {
    const parts = String(title || "")
      .split(/[_\-|·｜—]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      return { jobTitle: parts[0], company: parts[1] };
    }
    return { jobTitle: parts[0] || "", company: "" };
  }

  const SITE_CONFIGS = [
    { host: /(^|\.)zhipin\.com$/, platform: "boss", extract: extractBoss },
    { host: /(^|\.)liepin\.com$/, platform: "liepin", extract: extractLiepin },
    { host: /(^|\.)zhaopin\.com$/, platform: "zhaopin", extract: extractZhaoPin },
    { host: /(^|\.)51job\.com$/, platform: "job51", extract: extract51Job },
    { host: /(^|\.)nowcoder\.com$/, platform: "nowcoder", extract: extractGeneric },
    { host: /(^|\.)lagou\.com$/, platform: "lagou", extract: extractGeneric }
  ];

  function getSiteConfig() {
    return (
      SITE_CONFIGS.find((c) => c.host.test(location.hostname)) || {
        platform: "web",
        extract: extractGeneric
      }
    );
  }

  // ---------- 投递信号处理 ----------

  function isThrottled() {
    const now = Date.now();
    if (now - lastSignalAt < SIGNAL_THROTTLE_MS && lastSignalUrl === location.href) {
      return true;
    }
    lastSignalAt = now;
    lastSignalUrl = location.href;
    return false;
  }

  function handleApplySignal() {
    if (isThrottled()) {
      return;
    }
    const config = getSiteConfig();
    let info = {};
    try {
      info = config.extract() || {};
    } catch {
      info = {};
    }
    const fallback = parseTitleFallback(document.title);
    const payload = {
      platform: config.platform,
      url: location.href,
      company: info.company || fallback.company || "",
      jobTitle: info.jobTitle || fallback.jobTitle || "",
      city: info.city || "",
      salary: info.salary || "",
      source: "auto"
    };
    chrome.runtime.sendMessage({ type: "TD_ADD_RECORD", payload })
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

  // ---------- 点击监听（捕获阶段，只在按钮类元素上匹配文案） ----------

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
          handleApplySignal();
          return;
        }
      }
    },
    true
  );

  // ---------- 成功提示监听（兜底：有些站点投递按钮不触发上面的文案匹配） ----------
  // 节流由 handleApplySignal 内的 isThrottled 统一处理。

  const toastObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (text && text.length <= 40 && SUCCESS_TEXT_RE.test(text)) {
          handleApplySignal();
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
