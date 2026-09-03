// 投递事件检测（隔离世界，document_idle 注入）。
// 检测哲学：只在高置信场景记录，宁可漏记也不误记。
//   1. 表单提交流：本页被插件填写过（content.js 发布 __TD_AUTOFILL_STATE__）
//      + 用户点了提交/投递 → 记录，并从已填字段提取岗位/城市等信息
//   2. Boss直聘：后台 webRequest / 页面世界监听已核实的沟通接口
//   3. 其余场景：popup 手动记录 / 本页同步补记
// 所有信号统一走 recordAttempt()：同 URL 8 秒内只记一次，background 再做 10 分钟级去重。
(() => {
  if (window.__TD_TRACKER_LOADED__) {
    return;
  }
  window.__TD_TRACKER_LOADED__ = true;

  const APPLY_TEXT_RE = /(立即沟通|继续沟通|投递简历|立即投递|快速投递|立即申请|申请职位|发送简历|投个简历)/;
  const SIGNAL_THROTTLE_MS = 8000;
  const BRIDGE_TIMEOUT_MS = 900;
  const BRIDGE_SLOW_TIMEOUT_MS = 1500;
  const AUTOFILL_STATE_TTL_MS = 45 * 60 * 1000;
  const SUBMIT_ACTION_RE = /(提交|投递|立即申请|发送申请|完成申请)/;
  const SUBMIT_EXCLUDE_RE = /(下一步|上一步|保存草稿|暂存|登录|注册|验证|取消|预览)/;
  const JOB_CARD_SELECTOR =
    '.job-card-wrapper,.job-card-wrap,.job-card-box,[class*="job-card"],[class*="job-item"],[class*="position-item"],[class*="job-list-item"]';

  let lastSignalAt = 0;
  let lastSignalUrl = "";
  let lastClickCard = null;
  let lastDomClickAt = 0;
  const pendingBridge = new Map(); // requestId -> {resolve, timer}

  // ---------- 与页面世界的桥 ----------

  function bridgeRequest(kind, timeoutMs = BRIDGE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pendingBridge.delete(requestId);
        resolve(null);
      }, timeoutMs);
      pendingBridge.set(requestId, { resolve, timer });
      try {
        window.dispatchEvent(
          new CustomEvent(`td:${kind}-request`, { detail: JSON.stringify({ requestId }) })
        );
      } catch {
        clearTimeout(timer);
        pendingBridge.delete(requestId);
        resolve(null);
      }
    });
  }

  function handleBridgeResult(event) {
    let payload = {};
    try {
      payload = JSON.parse(event.detail || "{}");
    } catch {
      return;
    }
    const pending = pendingBridge.get(payload.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingBridge.delete(payload.requestId);
      pending.resolve(payload.data ?? null);
    }
  }

  for (const kind of ["extract", "collect-cards", "diagnose"]) {
    window.addEventListener(`td:${kind}-result`, handleBridgeResult);
  }

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

  function sendAddRecord(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "TD_ADD_RECORD", payload }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          resolve(null);
          return;
        }
        resolve(response.data || {});
      });
    });
  }

  // ---------- 浏览器级网络信号（background webRequest 转发） ----------
  // 不依赖页面世界脚本：投递请求的 URL 里自带 jobId，用它在页面里反查对应卡片。

  function handleNetApply(payload = {}) {
    const verified = Boolean(payload.verified);
    const recentClick = Date.now() - lastDomClickAt < 15000;
    if (!verified && !recentClick) {
      return; // 通用端点必须配合用户点击才认定
    }
    const params = { jobId: "", securityId: "", lid: "" };
    try {
      const u = new URL(payload.url || "");
      for (const key of Object.keys(params)) {
        params[key] = u.searchParams.get(key) || "";
      }
    } catch {
      // URL 解析失败，参数留空
    }
    const jobId = params.jobId;
    let card = null;
    if (jobId) {
      for (const node of document.querySelectorAll(JOB_CARD_SELECTOR)) {
        const link = node.querySelector?.("a[href]");
        if (link && (link.href || "").includes(jobId)) {
          card = node;
          break;
        }
      }
    }
    if (!card) {
      card = lastClickCard;
    }
    const info = card ? extractCardDom(card) : localExtract();
    let recordUrl = location.href;
    if (jobId) {
      const query = [];
      if (params.securityId) query.push(`securityId=${encodeURIComponent(params.securityId)}`);
      if (params.lid) query.push(`lid=${encodeURIComponent(params.lid)}`);
      recordUrl = `https://www.zhipin.com/job_detail/${jobId}.html${query.length ? `?${query.join("&")}` : ""}`;
    }
    recordAttempt({ ...info, url: recordUrl, jobId, source: "webrequest" });
  }

  function extractCardDom(card) {
    return {
      jobTitle: pickFrom(card, ['[class*="job-name"]', '[class*="job-title"]', ".job-name", ".job-title"]),
      company: pickFrom(card, ['[class*="company-name"]', ".company-name", '[class*="company"]']),
      salary: pickFrom(card, ['[class*="salary"]', ".salary"]),
      city: ""
    };
  }

  // ---------- 点击监听（仅做卡片定位，不直接触发记录） ----------
  // 记录 Boss 网络信号反查卡片失败时的兜底卡片；误触发源头已移除。

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
          lastClickCard = node.closest(JOB_CARD_SELECTOR);
          lastDomClickAt = Date.now();
          return;
        }
      }
    },
    true
  );

  // ---------- 核心检测：本页被插件填写过 + 用户提交/投递 ----------

  function getFreshFillState() {
    const state = window.__TD_AUTOFILL_STATE__;
    if (!state || !state.at || Date.now() - state.at > AUTOFILL_STATE_TTL_MS) {
      return null;
    }
    try {
      if (new URL(state.url).hostname !== location.hostname) {
        return null;
      }
    } catch {
      // URL 异常时宽松通过
    }
    return state;
  }

  function detectLocalPlatform() {
    const host = location.hostname;
    if (/(^|\.)zhipin\.com$/.test(host)) return "boss";
    if (/(^|\.)liepin\.com$/.test(host)) return "liepin";
    if (/(^|\.)zhaopin\.com$/.test(host)) return "zhaopin";
    if (/(^|\.)51job\.com$/.test(host)) return "job51";
    if (/(^|\.)nowcoder\.com$/.test(host)) return "nowcoder";
    if (/(^|\.)lagou\.com$/.test(host)) return "lagou";
    return "web";
  }

  function localAssessConfidence(info = {}) {
    if (getFreshFillState()) {
      return "high";
    }
    const title = String(info.jobTitle || "").trim();
    if (!title || /^(首页|登录|注册|消息|聊天|我的|个人中心|搜索|官网|首页.+)$/.test(title)) {
      return "low";
    }
    if (/\/(job_detail|job|position|vacancy|career|apply)/i.test(location.pathname)) {
      return "high";
    }
    if (document.querySelector(JOB_CARD_SELECTOR)) {
      return "high";
    }
    if (info.company) {
      return "medium";
    }
    return "low";
  }

  function buildFormSubmitPayload(state, trigger) {
    const fields = Array.isArray(state.fields) ? state.fields : [];
    const findByLabel = (re) => {
      for (const field of fields) {
        if (field?.label && re.test(field.label) && field.value) {
          return field.value;
        }
      }
      return "";
    };
    const titleFallback = parseTitleFallback(state.title || document.title);
    return {
      platform: detectLocalPlatform(),
      url: state.url || location.href,
      jobTitle:
        findByLabel(/(应聘|申请).{0,6}(岗位|职位)|岗位名称|职位名称|意向岗位|应聘职位/) ||
        findByLabel(/岗位|职位/) ||
        pickText(["h1"]) ||
        titleFallback.jobTitle,
      company:
        findByLabel(/公司|单位|企业/) ||
        titleFallback.company ||
        pickText(['[class*="company-name"]', '[class*="companyName"]']),
      city: findByLabel(/工作城市|期望城市|工作地点|工作地|城市/),
      salary: "",
      source: `autofill-${trigger}`,
      formFields: fields.slice(0, 30)
    };
  }

  function maybeRecordFormSubmit(trigger) {
    const state = getFreshFillState();
    if (!state) {
      return;
    }
    recordAttempt(buildFormSubmitPayload(state, trigger));
  }

  // 原生表单提交
  document.addEventListener(
    "submit",
    (event) => {
      try {
        if (event.target && event.target.tagName === "FORM") {
          maybeRecordFormSubmit("form");
        }
      } catch {
        // 忽略异常
      }
    },
    true
  );

  // SPA 常见的按钮式提交（仅在本页被填写过时生效）
  document.addEventListener(
    "click",
    (event) => {
      if (!getFreshFillState()) {
        return;
      }
      const path = event.composedPath ? event.composedPath() : [event.target];
      for (const node of path) {
        if (!(node instanceof Element) || !isButtonLike(node)) {
          continue;
        }
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (text && text.length <= 20 && SUBMIT_ACTION_RE.test(text) && !SUBMIT_EXCLUDE_RE.test(text)) {
          maybeRecordFormSubmit("button");
          return;
        }
      }
    },
    true
  );

  // ---------- 投递记录/沟通页：自动提示同步 ----------
  // Boss 的"沟通"页等记录页 URL 特征匹配后，右下角出现同步入口

  let hintShownFor = "";
  function maybeShowSyncHint() {
    const RECORD_PAGE_RE = /\/(web\/geek\/chat|deliver|applied|apply[-_]?record|my[-_]?apply|chat)/i;
    const key = location.pathname;
    if (!RECORD_PAGE_RE.test(key) || hintShownFor === key || document.getElementById("__td_sync_hint__")) {
      return;
    }
    hintShownFor = key;
    const wrap = document.createElement("div");
    wrap.id = "__td_sync_hint__";
    Object.assign(wrap.style, {
      position: "fixed",
      right: "20px",
      bottom: "90px",
      zIndex: "2147483646",
      display: "flex",
      alignItems: "center",
      gap: "10px",
      background: "rgba(30, 35, 60, 0.92)",
      color: "#fff",
      padding: "10px 14px",
      borderRadius: "12px",
      fontSize: "13px",
      boxShadow: "0 6px 24px rgba(0,0,0,0.25)"
    });
    const btn = document.createElement("span");
    btn.textContent = "📥 同步本页投递记录";
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => {
      wrap.remove();
      void openPicker();
    });
    const close = document.createElement("span");
    close.textContent = "×";
    close.style.cssText = "cursor:pointer;opacity:.6;font-size:16px;padding:0 2px;";
    close.addEventListener("click", () => wrap.remove());
    wrap.append(btn, close);
    document.documentElement.appendChild(wrap);
  }

  setInterval(maybeShowSyncHint, 2500);
  setTimeout(maybeShowSyncHint, 1500);

  // ---------- popup 消息：手动记录 / 批量补记 / 诊断 ----------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TD_PING") {
      sendResponse({ ok: true, data: {} });
      return false;
    }

    if (message?.type === "TD_NET_APPLY") {
      try {
        handleNetApply(message.payload || {});
      } catch {
        // 任何异常不影响页面
      }
      sendResponse({ ok: true, data: {} });
      return false;
    }

    if (message?.type === "TD_RECORD_PAGE") {
      void (async () => {
        try {
          let extracted = await bridgeRequest("extract");
          if (!extracted) {
            // 页面世界不可达时用本地提取 + 本地置信度评估
            const local = localExtract();
            extracted = { ...local, url: location.href, source: "manual", confidence: localAssessConfidence(local) };
          }
          // 本页被插件填写过 → 置信度直接拉满
          if (getFreshFillState()) {
            extracted.confidence = "high";
          }
          sendResponse({ ok: true, data: extracted });
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }

    if (message?.type === "TD_COLLECT_CARDS") {
      void (async () => {
        const result = (await bridgeRequest("collect-cards", BRIDGE_SLOW_TIMEOUT_MS)) || fallbackCollectCards();
        sendResponse({ ok: true, data: result });
      })();
      return true;
    }

    if (message?.type === "TD_DIAGNOSE") {
      void (async () => {
        const main = await bridgeRequest("diagnose", BRIDGE_SLOW_TIMEOUT_MS);
        sendResponse({
          ok: true,
          data: {
            contentLoaded: true,
            pageUrl: location.href,
            ua: navigator.userAgent,
            mainWorld: main || { reachable: false }
          }
        });
      })();
      return true;
    }

    if (message?.type === "TD_OPEN_PICKER") {
      void openPicker();
      sendResponse({ ok: true, data: {} });
      return false;
    }

    return undefined;
  });

  // DOM 兜底收集（页面世界脚本不可用时）
  function fallbackCollectCards() {
    const cards = [];
    try {
      const nodes = document.querySelectorAll(JOB_CARD_SELECTOR);
      for (const node of Array.from(nodes).slice(0, 60)) {
        const jobTitle = pickFrom(node, ['[class*="job-name"]', '[class*="job-title"]', ".job-name", ".job-title"]);
        const company = pickFrom(node, ['[class*="company-name"]', ".company-name", '[class*="company"]']);
        if (!jobTitle && !company) {
          continue;
        }
        let url = location.href;
        const link = node.querySelector?.('a[href]');
        if (link) {
          try {
            url = new URL(link.getAttribute("href"), location.origin).href;
          } catch {
            // 保持默认
          }
        }
        cards.push({
          company,
          jobTitle,
          salary: pickFrom(node, ['[class*="salary"]', ".salary"]),
          city: "",
          url,
          jobId: ""
        });
      }
    } catch {
      // 返回已收集部分
    }
    return { platform: "web", total: cards.length, cards };
  }

  function pickFrom(root, selectors, max = 60) {
    for (const selector of selectors) {
      try {
        const el = root.querySelector(selector);
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

  // ---------- 通用条目扫描：投递记录页 / 沟通页的岗位条目识别 ----------
  // 不依赖站点专属选择器：找页面上"像岗位条目"的列表项（含薪资样式或公司后缀）

  function collectGenericEntries() {
    const SALARY_RE = /\d+\s*[-~～]\s*\d+\s*[Kk万]/;
    const COMPANY_RE = /(有限公司|有限责任公司|集团|事务所|研究院|科技公司|网络公司)/;
    const out = [];
    const seen = new Set();
    let nodes = Array.from(document.querySelectorAll('li, [class*="item"], [class*="card"]'));
    if (nodes.length > 400) {
      nodes = nodes.slice(0, 400);
    }
    for (const node of nodes) {
      if (!(node instanceof Element)) {
        continue;
      }
      // 跳过容器级元素，只取条目级
      if (node.querySelectorAll("li").length > 2) {
        continue;
      }
      const text = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 8 || text.length > 220) {
        continue;
      }
      const salary = (text.match(SALARY_RE) || [""])[0];
      let company = "";
      for (const token of text.split(" ")) {
        if (token.length >= 4 && token.length <= 30 && COMPANY_RE.test(token)) {
          company = token;
          break;
        }
      }
      if (!salary && !company) {
        continue;
      }
      const link = node.querySelector("a[href]");
      let jobTitle = (link?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40);
      if (!jobTitle) {
        jobTitle = (text.split(" ")[0] || "").slice(0, 40);
      }
      if (!jobTitle) {
        continue;
      }
      const key = `${jobTitle}|${company}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      let url = location.href;
      if (link) {
        try {
          url = new URL(link.getAttribute("href"), location.origin).href;
        } catch {
          // 保持默认地址
        }
      }
      out.push({ company, jobTitle, salary, city: "", url, jobId: "" });
      if (out.length >= 80) {
        break;
      }
    }
    return out;
  }

  // ---------- 本页批量补记浮层 ----------

  async function openPicker() {
    if (document.getElementById("__td_picker__")) {
      return;
    }
    const result = (await bridgeRequest("collect-cards", BRIDGE_SLOW_TIMEOUT_MS)) || fallbackCollectCards();
    let cards = result?.cards || [];
    // 合并通用条目扫描（覆盖投递记录页/沟通页等非标准列表）
    const seenKeys = new Set(cards.map((c) => `${c.jobTitle}|${c.company}`));
    for (const entry of collectGenericEntries()) {
      const key = `${entry.jobTitle}|${entry.company}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        cards.push(entry);
      }
    }
    cards = cards.slice(0, 100);
    if (!cards.length) {
      showToast("没在本页找到岗位卡片");
      return;
    }

    const panel = document.createElement("div");
    panel.id = "__td_picker__";
    Object.assign(panel.style, {
      position: "fixed",
      right: "16px",
      top: "76px",
      width: "380px",
      maxHeight: "70vh",
      zIndex: "2147483647",
      background: "#fff",
      borderRadius: "14px",
      boxShadow: "0 18px 50px rgba(15,23,42,0.28)",
      fontFamily: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
      overflow: "hidden",
      display: "flex",
      flexDirection: "column"
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      background: "linear-gradient(120deg,#2b5cff,#7a4dff)",
      color: "#fff",
      padding: "12px 14px",
      fontSize: "14px",
      fontWeight: "600"
    });
    header.textContent = `选择要补记的投递（本页共 ${cards.length} 个岗位）`;

    const list = document.createElement("div");
    Object.assign(list.style, { overflowY: "auto", padding: "8px 10px", flex: "1" });

    const checkboxes = [];
    cards.forEach((card, index) => {
      const row = document.createElement("label");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        padding: "8px 6px",
        borderRadius: "8px",
        cursor: "pointer",
        fontSize: "13px",
        lineHeight: "1.5",
        borderBottom: "1px solid #f0f2f7"
      });
      const box = document.createElement("input");
      box.type = "checkbox";
      box.style.marginTop = "3px";
      box.dataset.index = String(index);
      checkboxes.push(box);
      const text = document.createElement("div");
      text.innerHTML = "";
      const title = document.createElement("div");
      title.style.fontWeight = "600";
      title.textContent = card.jobTitle || "（未识别岗位）";
      const meta = document.createElement("div");
      meta.style.color = "#6b7280";
      meta.style.fontSize = "12px";
      meta.textContent = [card.company || "（未识别公司）", card.salary].filter(Boolean).join(" · ");
      text.append(title, meta);
      row.append(box, text);
      list.appendChild(row);
    });

    const footer = document.createElement("div");
    Object.assign(footer.style, {
      display: "flex",
      gap: "8px",
      padding: "10px 12px",
      borderTop: "1px solid #eef0f5",
      background: "#fafbfd"
    });

    function makeButton(label, primary) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      Object.assign(btn.style, {
        flex: primary ? "1" : "0 0 auto",
        border: "none",
        borderRadius: "8px",
        padding: "8px 12px",
        fontSize: "13px",
        cursor: "pointer",
        background: primary ? "linear-gradient(120deg,#2b5cff,#7a4dff)" : "#eef0f5",
        color: primary ? "#fff" : "#4b5563",
        fontWeight: "500"
      });
      return btn;
    }

    const allBtn = makeButton("全选", false);
    const recordBtn = makeButton(`记录选中（0）`, true);
    const closeBtn = makeButton("关闭", false);

    function refreshCount() {
      const count = checkboxes.filter((b) => b.checked).length;
      recordBtn.textContent = `记录选中（${count}）`;
    }
    list.addEventListener("change", refreshCount);

    allBtn.addEventListener("click", () => {
      const target = !checkboxes.every((b) => b.checked);
      checkboxes.forEach((b) => {
        b.checked = target;
      });
      refreshCount();
    });

    closeBtn.addEventListener("click", () => panel.remove());

    recordBtn.addEventListener("click", () => {
      void (async () => {
        const selected = checkboxes
          .filter((b) => b.checked)
          .map((b) => cards[Number(b.dataset.index)])
          .filter(Boolean);
        if (!selected.length) {
          showToast("请先勾选要补记的岗位");
          return;
        }
        recordBtn.disabled = true;
        recordBtn.textContent = "记录中...";
        let added = 0;
        let duplicated = 0;
        for (const card of selected) {
          const result2 = await sendAddRecord({ ...card, source: "manual" });
          if (!result2) {
            continue;
          }
          if (result2.duplicate) {
            duplicated += 1;
          } else {
            added += 1;
          }
        }
        panel.remove();
        showToast(`补记完成：新增 ${added} 条${duplicated ? `，${duplicated} 条已存在` : ""}`);
      })();
    });

    footer.append(allBtn, recordBtn, closeBtn);
    panel.append(header, list, footer);
    document.documentElement.appendChild(panel);
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
