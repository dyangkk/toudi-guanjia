const els = {
  status: document.getElementById("status"),
  openOptions: document.getElementById("openOptions"),
  startAutofillBtn: document.getElementById("startAutofillBtn"),
  showProfilePanelBtn: document.getElementById("showProfilePanelBtn"),
  clearMarksBtn: document.getElementById("clearMarksBtn"),
  tdSummary: document.getElementById("tdSummary"),
  tdOpenDashboard: document.getElementById("tdOpenDashboard"),
  tdRecordPage: document.getElementById("tdRecordPage"),
  tdPickPage: document.getElementById("tdPickPage"),
  tdDiagnose: document.getElementById("tdDiagnose")
};

const DEFAULT_START_LABEL = els.startAutofillBtn.textContent;

els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.startAutofillBtn.addEventListener("click", () => {
  void startAutofill();
});
els.showProfilePanelBtn.addEventListener("click", () => {
  void showProfilePanel();
});
els.clearMarksBtn.addEventListener("click", () => {
  void clearMarks();
});
els.tdOpenDashboard.addEventListener("click", () => {
  void openDashboard();
});
els.tdRecordPage.addEventListener("click", () => {
  void recordCurrentPage();
});
els.tdPickPage.addEventListener("click", () => {
  void openPickerOnPage();
});
els.tdDiagnose.addEventListener("click", () => {
  void diagnosePage();
});

initialize();

async function initialize() {
  try {
    setStatus("点击开始填写后，右下角会实时显示当前是本地规则还是 AI；AI 不可用也能继续用本地规则填写。");
    await syncTrackerSummary();
    await syncRuntimeState();
  } catch (error) {
    setStatus(`读取页面失败：${error.message}`, true);
  }
}

async function syncRuntimeState(options = {}) {
  try {
    const response = await sendToActiveTab({ type: "OJAF_GET_RUNTIME_STATE" });
    applyRuntimeState(response?.data || {}, options);
  } catch {
    els.startAutofillBtn.disabled = false;
    els.startAutofillBtn.textContent = DEFAULT_START_LABEL;
  }
}

function applyRuntimeState(state = {}, options = {}) {
  const busy = Boolean(state.autofillInProgress);
  els.startAutofillBtn.disabled = busy;
  els.startAutofillBtn.textContent = busy ? "扫描中..." : DEFAULT_START_LABEL;

  if (options.updateStatus === false) {
    return;
  }

  if (busy) {
    const progress = state.autofillProgress || {};
    const stageLabel = progress.stepLabel || progress.stage || "处理当前页面";
    const stage = /^正在/.test(stageLabel) ? stageLabel : `正在${stageLabel}`;
    const elapsed = formatElapsedTime(progress.stageStartedAt);
    const aiNote = formatRuntimeAiNote(state.autofillAi || {}, elapsed);
    setStatus(`当前${stage}，请勿重复点击。页面右下角会显示进度。${aiNote}`);
    return;
  }

  if (state.autofillSummary) {
    const summary = state.autofillSummary;
    setStatus(`上次填写：已填写 ${summary.filled || 0} 项，待处理 ${getPendingCount(summary)} 项。${formatAiCompletionNote(summary.aiUsage || state.autofillAi || {})}`);
  }
}

async function showProfilePanel() {
  try {
    await sendToActiveTab({ type: "OJAF_SHOW_PROFILE_PANEL" });
    setStatus("已打开资料面板。");
    await syncRuntimeState({ updateStatus: false });
  } catch (error) {
    setStatus(`打开失败：${error.message}`, true);
  }
}

async function startAutofill() {
  try {
    els.startAutofillBtn.disabled = true;
    els.startAutofillBtn.textContent = "扫描中...";
    setStatus("正在开始填写；右下角会显示当前是本地规则还是 AI。");
    const response = await sendToActiveTab({ type: "OJAF_START_AUTOFILL" });
    const data = response?.data || {};
    if (data.ok) {
      if (data.filled != null) {
        setStatus(`已完成一键填写：已填写 ${data.filled || 0} 项，待处理 ${getPendingCount(data)} 项。${formatAiCompletionNote(data.aiUsage || {})}`);
      } else {
        setStatus("已完成扫描处理。页面上的橙色标记需要手动处理，也可以打开资料面板查看和复制资料。");
      }
    } else if (data.reason === "cancelled") {
      setStatus("已取消填写。");
    } else if (data.reason === "no candidates") {
      setStatus(`没有找到可自动填写的字段。橙色标记需要手动处理，也可以打开资料面板查看和复制资料。${formatAiCompletionNote(data.aiUsage || {})}`);
    } else if (data.reason === "busy") {
      setStatus("当前已有扫描任务在运行，请稍候。", true);
    } else if (data.reason) {
      setStatus(`开始填写未完成：${data.reason}`, true);
    } else {
      setStatus("已开始处理一键填写。");
    }
    await syncRuntimeState({ updateStatus: false });
  } catch (error) {
    setStatus(`开始填写失败：${error.message}`, true);
    await syncRuntimeState({ updateStatus: false });
  }
}

async function clearMarks() {
  try {
    await sendToActiveTab({ type: "OJAF_CLEAR_MARKS" });
    setStatus("已清除颜色标记，不会修改表单内容。");
    await syncRuntimeState({ updateStatus: false });
  } catch (error) {
    setStatus(`清除失败：${error.message}`, true);
  }
}

async function syncTrackerSummary() {
  try {
    const summary = await sendRuntimeMessage({ type: "TD_GET_SUMMARY" });
    renderTrackerSummary(summary || {});
  } catch (error) {
    els.tdSummary.textContent = `读取投递记录失败：${error.message}`;
  }
}

function renderTrackerSummary(summary = {}) {
  const total = Number(summary.total || 0);
  const today = Number(summary.today || 0);
  const byStatus = summary.byStatus || {};
  const interview = Number(byStatus.interview || 0);
  const offer = Number(byStatus.offer || 0);
  if (!total) {
    els.tdSummary.textContent = "还没有投递记录。用插件填写过的表单页，点提交/投递后会自动记录；Boss直聘沟通也会自动记录；其他情况用下面的按钮补记。";
    return;
  }
  els.tdSummary.textContent = `共 ${total} 条投递，今日 ${today} 条，面试 ${interview}，Offer ${offer}。`;
}

async function openDashboard() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard.html") });
  window.close();
}

async function recordCurrentPage() {
  els.tdRecordPage.disabled = true;
  els.tdRecordPage.textContent = "记录中...";
  try {
    const [tab] = await queryTabs({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }
    // 优先让页面里的追踪脚本做精确提取（Boss 卡片 Vue 数据等）
    let payload = null;
    try {
      const response = await sendTabMessage(tab.id, { type: "TD_RECORD_PAGE" });
      const data = response?.data;
      if (data && (data.company || data.jobTitle)) {
        payload = data;
      }
    } catch {
      // 该网站没有注入追踪脚本，走标题兜底
    }
    if (!payload) {
      const guess = parseTitleGuess(tab.title);
      payload = { company: guess.company, jobTitle: guess.jobTitle };
    }
    const result = await sendRuntimeMessage({
      type: "TD_ADD_RECORD",
      payload: { ...payload, url: tab.url, source: payload.source || "manual" }
    });
    if (result?.duplicate) {
      setStatus("这一页已经记录过啦，可以在看板里查看。");
    } else {
      setStatus("已记录本页投递。公司 / 岗位名如有偏差，可在看板里修改。");
    }
    await syncTrackerSummary();
  } catch (error) {
    setStatus(`记录失败：${error.message}`, true);
  } finally {
    els.tdRecordPage.disabled = false;
    els.tdRecordPage.textContent = "记录本页投递";
  }
}

function parseTitleGuess(title) {
  const parts = String(title || "")
    .split(/[_\-|·｜—]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    jobTitle: parts[0] || "",
    company: parts.length >= 2 ? parts[1] : ""
  };
}

async function ensureTrackerInTab(tabId) {
  try {
    await sendTabMessage(tabId, { type: "TD_PING" });
    return true;
  } catch {
    // 页面在插件重载前就已打开（脚本未注入），尝试按需补注入
    try {
      await executeScript(tabId, "src/tracker-content.js");
      return true;
    } catch {
      return false;
    }
  }
}

async function openPickerOnPage() {
  try {
    const [tab] = await queryTabs({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }
    const ready = await ensureTrackerInTab(tab.id);
    if (!ready) {
      setStatus("当前页面无法注入脚本。请刷新该页面（F5）后再试。", true);
      return;
    }
    await sendTabMessage(tab.id, { type: "TD_OPEN_PICKER" });
    window.close();
  } catch (error) {
    setStatus(`请先打开招聘网站（Boss直聘/猎聘/智联等）的职位页面再使用补记。${error.message ? `（${error.message}）` : ""}`, true);
  }
}

async function diagnosePage() {
  els.tdDiagnose.disabled = true;
  try {
    const [tab] = await queryTabs({ active: true, currentWindow: true });
    const report = { pageUrl: tab?.url || "", contentLoaded: false, mainWorld: null };
    if (tab?.id) {
      try {
        const response = await sendTabMessage(tab.id, { type: "TD_DIAGNOSE" });
        if (response?.ok && response.data) {
          Object.assign(report, response.data);
        }
      } catch {
        // 该页面没有注入追踪脚本
      }
    }
    await chrome.storage.session.set({ tdDiagnoseReport: report });
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/diagnose.html") });
    window.close();
  } finally {
    els.tdDiagnose.disabled = false;
  }
}

function formatRuntimeAiNote(aiUsage = {}, elapsed = "") {
  const status = aiUsage.status || "";
  if (status === "trying") {
    return ` 正在用 AI 辅助识别字段，资料值不会发送${elapsed ? `，已等待 ${elapsed}` : ""}。`;
  }
  if (aiUsage.used && aiUsage.fallback) {
    return " AI 辅助识别了部分字段，其余已用本地规则继续。";
  }
  if (aiUsage.used) {
    return " AI 已辅助识别字段，具体填写仍在本机完成。";
  }
  if (aiUsage.fallback) {
    return " AI 不可用，已使用本地规则继续。";
  }
  if (status === "no-result" || aiUsage.attempted) {
    return " AI 没有提供可用建议，继续使用本地规则。";
  }
  return " 如果配置了 AI，会辅助识别字段；否则使用本地规则。";
}

function formatAiCompletionNote(aiUsage = {}) {
  if (aiUsage.used && aiUsage.fallback) {
    return "本次 AI 辅助识别了部分字段，其余使用本地规则完成。";
  }
  if (aiUsage.used) {
    return "本次 AI 辅助识别字段，具体填写在本机完成。";
  }
  if (aiUsage.fallback) {
    return "本次使用本地规则完成；AI 不可用。";
  }
  if (aiUsage.status === "no-result" || aiUsage.attempted) {
    return "本次 AI 没有提供可用建议，实际使用本地规则。";
  }
  return "本次使用本地规则。";
}

function getPendingCount(summary = {}) {
  return Number(summary.pending ?? Number(summary.skipped || 0) + Number(summary.failed || 0));
}

function formatElapsedTime(startedAt) {
  const start = Number(startedAt || 0);
  if (!start) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (seconds < 1) {
    return "";
  }
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

async function sendToActiveTab(message) {
  const [tab] = await queryTabs({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  await executeScript(tab.id, "src/content.js");

  try {
    return await sendTabMessage(tab.id, message);
  } catch (firstError) {
    try {
      await executeScript(tab.id, "src/content.js");
      return await sendTabMessage(tab.id, message);
    } catch {
      throw firstError;
    }
  }
}

function queryTabs(query) {
  return new Promise((resolve) => {
    chrome.tabs.query(query, resolve);
  });
}

function executeScript(tabId, file) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: [file] }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve();
      }
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Tab message failed."));
        return;
      }
      resolve(response);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Runtime message failed."));
        return;
      }
      resolve(response.data);
    });
  });
}
