// 页面世界脚本（manifest 声明 "world": "MAIN"，document_start 注入）。
// 职责：
//   1) 包装 fetch / XMLHttpRequest，识别"投递/打招呼"类接口的成功响应 —— 最可靠的投递信号
//   2) 捕获用户点击的"投递类按钮"所在的岗位卡片
//   3) 从 Boss直聘卡片挂载的 Vue 组件数据中提取精确的公司/岗位/薪资（比 DOM 文本可靠）
// 与隔离世界脚本（tracker-content.js）通过 CustomEvent + JSON 字符串通信，不使用 chrome API。
// Boss 直聘接口与卡片取数思路参考开源项目 muyuniao/boss-auto-apply（MIT）。
(() => {
  if (window.__TD_PAGE_BRIDGE__) {
    return;
  }
  window.__TD_PAGE_BRIDGE__ = true;

  // 已核实的投递端点（Boss直聘：立即沟通/打招呼）。
  // 只监听已核实端点，通用启发式已移除（避免误触发）。
  const VERIFIED_APPLY_ENDPOINTS = [/\/wapi\/zpgeek\/friend\/add(\.json)?/i];
  const APPLY_TEXT_RE = /(立即沟通|继续沟通|投递简历|立即投递|快速投递|立即申请|申请职位|发送简历|投个简历)/;
  const JOB_CARD_SELECTOR =
    '.job-card-wrapper,.job-card-wrap,.job-card-box,[class*="job-card"],[class*="job-item"],[class*="position-item"],[class*="job-list-item"]';

  let lastApplyClick = null; // { card: Element | null, at: number }
  const signalLog = []; // 诊断日志：记录所有捕获到的信号，最多保留 40 条
  const SIGNAL_LOG_MAX = 40;

  function logSignal(kind, info) {
    signalLog.push({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), kind, info });
    if (signalLog.length > SIGNAL_LOG_MAX) {
      signalLog.splice(0, signalLog.length - SIGNAL_LOG_MAX);
    }
  }

  // ---------- 事件桥（跨世界传 JSON 字符串，避免对象隔离问题） ----------

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail || {}) }));
    } catch {
      // 页面环境异常时放弃
    }
  }

  // ---------- 点击捕获：记住投递类按钮对应的卡片 ----------

  document.addEventListener(
    "click",
    (event) => {
      const path = event.composedPath ? event.composedPath() : [event.target];
      for (const node of path) {
        if (!(node instanceof Element)) {
          continue;
        }
        const tag = node.tagName;
        const buttonLike =
          tag === "BUTTON" ||
          tag === "A" ||
          node.getAttribute("role") === "button" ||
          /(btn|button)/i.test(String(node.className || ""));
        if (!buttonLike) {
          continue;
        }
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (text && text.length <= 30 && APPLY_TEXT_RE.test(text)) {
          lastApplyClick = { card: node.closest(JOB_CARD_SELECTOR), at: Date.now() };
          logSignal("click", `按钮「${text.slice(0, 16)}」，卡片：${lastApplyClick.card ? "已定位" : "未定位"}`);
          return;
        }
      }
    },
    true
  );

  // ---------- 网络监听：fetch ----------

  if (typeof window.fetch === "function") {
    const rawFetch = window.fetch.bind(window);
    window.fetch = function patchedFetch(input, init) {
      return rawFetch(input, init).then((response) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (isWatchableUrl(url)) {
          void handleNetworkSignal(url, response.status, () => response.clone().text());
        }
        return response;
      });
    };
  }

  // ---------- 网络监听：XMLHttpRequest（axios 等库走这里） ----------

  const XHR = window.XMLHttpRequest;
  if (XHR?.prototype) {
    const rawOpen = XHR.prototype.open;
    const rawSend = XHR.prototype.send;
    XHR.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__tdUrl = String(url || "");
      return rawOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function patchedSend(body) {
      if (isWatchableUrl(this.__tdUrl)) {
        this.addEventListener("load", () => {
          try {
            void handleNetworkSignal(this.__tdUrl, this.status, async () => this.responseText);
          } catch {
            // 忽略读取失败
          }
        });
      }
      return rawSend.call(this, body);
    };
  }

  function resolveUrl(raw) {
    try {
      return new URL(String(raw), location.origin);
    } catch {
      return null;
    }
  }

  function isWatchableUrl(raw) {
    const url = resolveUrl(raw);
    if (!url) {
      return false;
    }
    return VERIFIED_APPLY_ENDPOINTS.some((re) => re.test(url.pathname));
  }

  async function handleNetworkSignal(rawUrl, status, readBody) {
    try {
      if (status < 200 || status >= 400) {
        return;
      }
      const url = resolveUrl(rawUrl);
      if (!url) {
        return;
      }
      if (!VERIFIED_APPLY_ENDPOINTS.some((re) => re.test(url.pathname))) {
        return;
      }
      logSignal("endpoint", `已核实端点：${url.pathname}`);

      let body = null;
      try {
        body = JSON.parse(await readBody());
      } catch {
        body = null;
      }
      if (body && !isSuccessResponse(body)) {
        logSignal("endpoint", `响应未判定为成功（code=${body.code ?? "无"}），忽略`);
        return;
      }

      const payload = buildPayload(url, body);
      logSignal("emit", `已发投递信号：${payload.company || "?"} · ${payload.jobTitle || "?"}`);
      emit("td:apply", payload);
    } catch {
      // 任何异常都不影响页面自身逻辑
    }
  }

  function isSuccessResponse(body) {
    if (body == null || typeof body !== "object") {
      return true; // 非 JSON 响应无法判断，交给上层去重兜底
    }
    if (body.code === 0 || body.code === "0" || body.success === true) {
      return true;
    }
    return body.code === undefined && body.status === undefined;
  }

  function detectPlatform() {
    const host = location.hostname;
    if (/(^|\.)zhipin\.com$/.test(host)) return "boss";
    if (/(^|\.)liepin\.com$/.test(host)) return "liepin";
    if (/(^|\.)zhaopin\.com$/.test(host)) return "zhaopin";
    if (/(^|\.)51job\.com$/.test(host)) return "job51";
    if (/(^|\.)nowcoder\.com$/.test(host)) return "nowcoder";
    if (/(^|\.)lagou\.com$/.test(host)) return "lagou";
    return "web";
  }

  // ---------- 岗位信息提取 ----------

  function buildPayload(url, body) {
    const platform = detectPlatform();
    const params = {};
    for (const key of ["securityId", "jobId", "encryptJobId", "lid"]) {
      params[key] = url.searchParams.get(key) || "";
    }
    const card = lastApplyClick?.card || null;

    let info = {};
    if (platform === "boss") {
      info = extractBossCard(card, params) || {};
    }
    if (!info.jobTitle && !info.company) {
      info = extractFromCardDom(card);
    }
    if (!info.jobTitle && !info.company) {
      info = extractDetailPage();
    }

    return {
      platform,
      url: info.url || location.href,
      company: info.company || "",
      jobTitle: info.jobTitle || "",
      city: info.city || "",
      salary: info.salary || "",
      jobId: info.jobId || params.jobId || params.encryptJobId || "",
      source: "network"
    };
  }

  function pickText(root, selectors, max = 80) {
    if (!root) {
      return "";
    }
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

  // Boss：优先读卡片 Vue 数据（精确），其次按接口参数反查卡片，最后 DOM 文本
  function extractBossCard(card, params) {
    let data = readVueJobData(card);
    if (!data && (params.securityId || params.jobId || params.lid)) {
      data = findCardDataByApi(params);
    }
    const scope = data?.__el || card;
    const info = {
      company: firstString(data, ["brandName", "companyName", "brandFullName"]) ||
        pickText(scope, [".company-name", ".company-text .name", ".company-info .name"]),
      jobTitle: firstString(data, ["jobName", "jobTitle", "title", "positionName"]) ||
        pickText(scope, [".job-name", ".job-title"]),
      salary: firstString(data, ["salaryDesc", "salary", "salaryName"]) ||
        pickText(scope, [".salary", ".job-salary", ".salary-desc"])
    };
    const city = firstString(data, ["cityName"]);
    const district = firstString(data, ["areaDistrict"]);
    info.city = [city, district].filter(Boolean).join("·");
    const jobId = firstString(data, ["encryptJobId", "jobId"]) || params.jobId || params.encryptJobId;
    const securityId = firstString(data, ["securityId"]) || params.securityId;
    const lid = firstString(data, ["lid"]) || params.lid;
    if (jobId) {
      const query = [];
      if (securityId) query.push(`securityId=${encodeURIComponent(securityId)}`);
      if (lid) query.push(`lid=${encodeURIComponent(lid)}`);
      info.url = `https://www.zhipin.com/job_detail/${jobId}.html${query.length ? `?${query.join("&")}` : ""}`;
      info.jobId = jobId;
    }
    return info.jobTitle || info.company ? info : null;
  }

  function readVueJobData(card) {
    if (!card) {
      return null;
    }
    const seeds = [];
    const vue2 = card.__vue__;
    if (vue2) {
      seeds.push(vue2._props, vue2.$props, vue2._data, vue2.data);
    }
    const vue3 = card.__vueParentComponent;
    if (vue3) {
      seeds.push(vue3.props, vue3.setupState, vue3.proxy, vue3.ctx);
    }
    for (const seed of seeds) {
      const found = findJobLikeObject(seed);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function findCardDataByApi(params) {
    try {
      for (const card of document.querySelectorAll(JOB_CARD_SELECTOR)) {
        const data = readVueJobData(card);
        if (!data) {
          continue;
        }
        const securityId = firstString(data, ["securityId"]);
        const jobId = firstString(data, ["encryptJobId", "jobId"]);
        const lid = firstString(data, ["lid"]);
        if (
          (params.securityId && securityId === params.securityId) ||
          (params.jobId && jobId === params.jobId) ||
          (params.lid && lid === params.lid)
        ) {
          return data;
        }
      }
    } catch {
      // 忽略遍历异常
    }
    return null;
  }

  // 在组件树附近找"长得像岗位数据"的对象（有岗位名/公司名 + 投递标识）
  function findJobLikeObject(root) {
    if (!root || typeof root !== "object") {
      return null;
    }
    const queue = [{ value: root, depth: 0 }];
    const seen = new WeakSet();
    while (queue.length) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value)) {
        continue;
      }
      seen.add(value);
      if (looksLikeJobData(value)) {
        return value;
      }
      if (depth >= 4) {
        continue;
      }
      for (const child of Object.values(value).slice(0, 60)) {
        if (child && typeof child === "object") {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    return null;
  }

  function looksLikeJobData(obj) {
    const hasName = Boolean(
      obj.jobName || obj.jobTitle || obj.title || obj.positionName ||
      obj.brandName || obj.companyName
    );
    const hasApplyKey = Boolean(obj.securityId || obj.encryptJobId || obj.lid);
    return hasName && (hasApplyKey || Boolean(obj.salaryDesc || obj.brandName));
  }

  function firstString(obj, keys) {
    for (const key of keys) {
      const value = obj?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return String(value).trim();
      }
    }
    return "";
  }

  // 通用卡片 DOM 提取（猎聘/智联等，尽力而为）
  function extractFromCardDom(card) {
    if (!card) {
      return {};
    }
    return {
      jobTitle: pickText(card, ['[class*="job-name"]', '[class*="job-title"]', ".job-name", ".job-title", "a[title]"]),
      company: pickText(card, ['[class*="company-name"]', ".company-name", ".company", '[class*="company"]']),
      salary: pickText(card, ['[class*="salary"]', ".salary"]),
      url: pickText(card, []) || findCardLink(card)
    };
  }

  function findCardLink(card) {
    const link = card.querySelector?.('a[href*="job"], a[href*="position"], a[href]');
    if (link) {
      try {
        return new URL(link.getAttribute("href"), location.origin).href;
      } catch {
        return "";
      }
    }
    return "";
  }

  // 岗位详情页兜底提取
  function extractDetailPage() {
    const info = {
      jobTitle: pickText(document, ["h1"]),
      company: pickText(document, [
        ".job-sider .company-info .name",
        '[class*="company-name"]',
        '[class*="companyName"]'
      ]),
      salary: pickText(document, ['.salary', '[class*="salary"]']),
      city: ""
    };
    if (!info.jobTitle) {
      const parts = String(document.title || "")
        .split(/[_\-|·｜—]+/)
        .map((p) => p.trim())
        .filter(Boolean);
      info.jobTitle = parts[0] || "";
      if (!info.company && parts.length >= 2) {
        info.company = parts[1];
      }
    }
    return info;
  }

  // ---------- 手动记录支持：隔离世界发请求，这里做最优提取 ----------

  window.addEventListener("td:extract-request", (event) => {
    let requestId = "";
    try {
      requestId = JSON.parse(event.detail || "{}").requestId || "";
    } catch {
      // 解析失败按空处理
    }
    const data = bestEffortPageExtract();
    emit("td:extract-result", { requestId, data });
  });

  // ---------- 批量补记：收集当前页所有岗位卡片 ----------

  window.addEventListener("td:collect-cards-request", (event) => {
    let requestId = "";
    try {
      requestId = JSON.parse(event.detail || "{}").requestId || "";
    } catch {
      // 解析失败按空处理
    }
    emit("td:collect-cards-result", { requestId, data: collectPageCards() });
  });

  function collectPageCards() {
    const platform = detectPlatform();
    const cards = [];
    try {
      const nodes = document.querySelectorAll(JOB_CARD_SELECTOR);
      const limit = Math.min(nodes.length, 60);
      for (let i = 0; i < limit; i += 1) {
        const node = nodes[i];
        let info = null;
        if (platform === "boss") {
          info = extractBossCard(node, {});
        }
        if (!info) {
          const dom = extractFromCardDom(node);
          info = {
            company: dom.company,
            jobTitle: dom.jobTitle,
            salary: dom.salary,
            url: dom.url
          };
        }
        if (info && (info.company || info.jobTitle)) {
          cards.push({
            company: info.company || "",
            jobTitle: info.jobTitle || "",
            salary: info.salary || "",
            city: info.city || "",
            url: info.url || location.href,
            jobId: info.jobId || ""
          });
        }
      }
    } catch {
      // 收集失败返回已收集部分
    }
    return { platform, total: cards.length, cards };
  }

  // ---------- 诊断：自检 + 信号日志 ----------

  window.addEventListener("td:diagnose-request", (event) => {
    let requestId = "";
    try {
      requestId = JSON.parse(event.detail || "{}").requestId || "";
    } catch {
      // 解析失败按空处理
    }
    let fetchWrapped = false;
    try {
      fetchWrapped = window.fetch.toString().includes("patchedFetch");
    } catch {
      fetchWrapped = false;
    }
    let xhrWrapped = false;
    try {
      xhrWrapped = String(XMLHttpRequest.prototype.open).includes("patchedOpen");
    } catch {
      xhrWrapped = false;
    }
    let cardCount = 0;
    try {
      cardCount = document.querySelectorAll(JOB_CARD_SELECTOR).length;
    } catch {
      cardCount = 0;
    }
    const vueSample = (() => {
      try {
        const first = document.querySelector(".job-card-wrapper") || document.querySelector(JOB_CARD_SELECTOR);
        const data = readVueJobData(first);
        return data ? { ok: true, jobName: firstString(data, ["jobName"]), brandName: firstString(data, ["brandName"]) } : { ok: false };
      } catch {
        return { ok: false };
      }
    })();
    emit("td:diagnose-result", {
      requestId,
      data: {
        platform: detectPlatform(),
        url: location.href,
        fetchWrapped,
        xhrWrapped,
        cardCount,
        vueSample,
        signalLog: signalLog.slice()
      }
    });
  });

  function bestEffortPageExtract() {
    const platform = detectPlatform();
    if (platform === "boss") {
      const card =
        document.querySelector(".job-card-wrapper.selected, .job-card-wrapper.active") ||
        lastApplyClick?.card ||
        document.querySelector(".job-card-wrapper");
      const info = extractBossCard(card, {}) || {};
      if (info.jobTitle || info.company) {
        return {
          platform,
          ...info,
          url: info.url || location.href,
          source: "manual",
          confidence: assessConfidence(info)
        };
      }
    }
    const generic = extractDetailPage();
    return {
      platform,
      ...generic,
      url: location.href,
      source: "manual",
      confidence: assessConfidence(generic)
    };
  }

  // 置信度评估：手动记录前的验证，避免把无关页面记成投递
  function assessConfidence(info = {}) {
    const title = String(info.jobTitle || "").trim();
    // 明显的导航页标题直接判低
    if (!title || /^(首页|登录|注册|消息|聊天|我的|个人中心|搜索|官网|首页.+)$/.test(title)) {
      return "low";
    }
    // URL 是岗位详情页
    if (/\/(job_detail|job|position|vacancy|career|apply)/i.test(location.pathname)) {
      return "high";
    }
    // 页面上有岗位卡片
    if (document.querySelectorAll(JOB_CARD_SELECTOR).length > 0) {
      return "high";
    }
    // 同时有岗位名和公司线索
    if (info.company) {
      return "medium";
    }
    return "low";
  }
})();
