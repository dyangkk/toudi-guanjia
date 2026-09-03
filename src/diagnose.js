// 诊断报告页：读取 popup 存入 session storage 的报告并渲染。

const PLATFORM_LABELS = {
  boss: "Boss直聘",
  liepin: "猎聘",
  zhaopin: "智联招聘",
  job51: "前程无忧",
  nowcoder: "牛客",
  lagou: "拉勾",
  web: "网申官网",
  manual: "手动记录"
};

let report = {};

document.getElementById("copyBtn").addEventListener("click", copyJson);

void initialize();

async function initialize() {
  try {
    const values = await chrome.storage.session.get("tdDiagnoseReport");
    report = values?.tdDiagnoseReport || {};
  } catch {
    report = {};
  }
  renderBasic();
  renderStatus();
  renderLogs();
}

function renderBasic() {
  const main = report.mainWorld || {};
  const rows = [
    ["页面地址", report.pageUrl || "—"],
    ["识别的平台", PLATFORM_LABELS[main.platform] || main.platform || "—"],
    ["浏览器标识", String(report.ua || "—").slice(0, 110)],
    ["追踪脚本（隔离世界）", report.contentLoaded ? span("已加载", true) : span("未加载（不是招聘站点或未刷新页面）", false)]
  ];
  fillTable("basicTable", rows);
}

function renderStatus() {
  const main = report.mainWorld || {};
  const hint = document.getElementById("statusHint");
  if (!report.contentLoaded || !main || main.reachable === false) {
    const rows = [["页面世界脚本", span("不可达", false)]];
    fillTable("statusTable", rows);
    hint.textContent = "页面世界脚本没有运行：请确认当前页是六大支持站点之一，并且重新加载过插件；仍不行请截图反馈。";
    return;
  }

  const vue = main.vueSample || {};
  const rows = [
    ["页面世界脚本", span("已运行", true)],
    ["fetch 监听", main.fetchWrapped ? span("已挂载", true) : span("未挂载", false)],
    ["XHR 监听", main.xhrWrapped ? span("已挂载", true) : span("未挂载", false)],
    ["页面岗位卡片数", String(main.cardCount ?? 0)],
    [
      "卡片数据读取（Vue）",
      vue.ok
        ? span(`正常（样本：${vue.jobName || "?"} / ${vue.brandName || "?"}）`, true)
        : span("不可用（将回落 DOM 文本提取）", false)
    ]
  ];
  fillTable("statusTable", rows);

  if (!main.fetchWrapped && !main.xhrWrapped) {
    hint.textContent = "网络监听没有挂上：多发生在浏览器版本过旧（需 Chrome/Edge 111+），或站点安全策略拦截。请截图反馈。";
  } else if ((main.cardCount ?? 0) === 0) {
    hint.textContent = "没找到岗位卡片：当前可能不在职位列表/详情页，或站点页面结构变化。请截图反馈。";
  } else {
    hint.textContent = "组件状态正常。请在页面上点一次投递，再回来重新诊断，观察下方信号日志。";
  }
}

function renderLogs() {
  const table = document.getElementById("logTable");
  const logs = report.mainWorld?.signalLog || [];
  table.innerHTML = "";
  if (!logs.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "muted";
    td.textContent = "暂无信号。去招聘页面点一次投递，然后回来重新诊断。";
    tr.appendChild(td);
    table.appendChild(tr);
    return;
  }
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>时间</th><th>类型</th><th>详情</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const entry of logs.slice().reverse()) {
    const tr = document.createElement("tr");
    const time = document.createElement("td");
    time.className = "muted";
    time.style.whiteSpace = "nowrap";
    time.textContent = entry.time || "";
    const kind = document.createElement("td");
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = entry.kind || "";
    kind.appendChild(tag);
    const info = document.createElement("td");
    info.textContent = entry.info || "";
    tr.append(time, kind, info);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function fillTable(id, rows) {
  const table = document.getElementById(id);
  table.innerHTML = "";
  for (const [key, value] of rows) {
    const tr = document.createElement("tr");
    const k = document.createElement("td");
    k.textContent = key;
    const v = document.createElement("td");
    if (typeof value === "string") {
      v.textContent = value;
    } else {
      v.appendChild(value);
    }
    tr.append(k, v);
    table.appendChild(tr);
  }
}

function span(text, ok) {
  const el = document.createElement("span");
  el.className = ok ? "ok" : "bad";
  el.textContent = text;
  return el;
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    showToast("已复制，可直接粘贴给开发者");
  } catch {
    showToast("复制失败，请手动截图");
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2000);
}
