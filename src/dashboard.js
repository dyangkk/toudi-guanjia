// 投递看板：所有数据通过 background 的 TD_* 消息读写，本页不做任何网络请求。

const STATUS_TONES = {
  applied: "blue",
  viewed: "cyan",
  chatting: "purple",
  interview: "orange",
  offer: "green",
  rejected: "gray"
};

const STATUS_ORDER = ["applied", "viewed", "chatting", "interview", "offer", "rejected"];

const els = {
  statsRow: document.getElementById("statsRow"),
  statusPills: document.getElementById("statusPills"),
  platformFilter: document.getElementById("platformFilter"),
  searchInput: document.getElementById("searchInput"),
  tableBody: document.getElementById("tableBody"),
  emptyState: document.getElementById("emptyState"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  clearAllBtn: document.getElementById("clearAllBtn"),
  toast: document.getElementById("toast")
};

const state = {
  records: [],
  statusLabels: {},
  platformLabels: {},
  statusFilter: "all",
  platformFilter: "all",
  keyword: "",
  expandedId: null
};

els.exportCsvBtn.addEventListener("click", exportCsv);
els.clearAllBtn.addEventListener("click", clearAll);
els.platformFilter.addEventListener("change", () => {
  state.platformFilter = els.platformFilter.value;
  renderTable();
});
els.searchInput.addEventListener("input", () => {
  state.keyword = els.searchInput.value.trim().toLowerCase();
  renderTable();
});

void initialize();

async function initialize() {
  await reload();
}

async function reload() {
  try {
    const data = await sendRuntimeMessage({ type: "TD_LIST_RECORDS" });
    state.records = data?.records || [];
    state.statusLabels = data?.statuses || {};
    state.platformLabels = data?.platforms || {};
    renderAll();
  } catch (error) {
    showToast(`读取记录失败：${error.message}`);
  }
}

function renderAll() {
  renderStats();
  renderPills();
  renderPlatformOptions();
  renderTable();
}

function renderStats() {
  const byStatus = {};
  let today = 0;
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  for (const r of state.records) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.appliedAt >= dayStart.getTime()) {
      today += 1;
    }
  }
  const cards = [
    { label: "总投递", num: state.records.length, tone: "" },
    { label: "今日投递", num: today, tone: "" },
    ...STATUS_ORDER.map((status) => ({
      label: state.statusLabels[status] || status,
      num: byStatus[status] || 0,
      tone: STATUS_TONES[status] || ""
    }))
  ];
  els.statsRow.innerHTML = "";
  for (const card of cards) {
    const div = document.createElement("div");
    div.className = `stat-card${card.tone ? ` tone-${card.tone}` : ""}`;
    div.innerHTML = `<div class="num"></div><div class="label"></div>`;
    div.querySelector(".num").textContent = card.num;
    div.querySelector(".label").textContent = card.label;
    els.statsRow.appendChild(div);
  }
}

function renderPills() {
  const counts = { all: state.records.length };
  for (const r of state.records) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }
  const items = [
    { id: "all", label: "全部" },
    ...STATUS_ORDER.map((status) => ({ id: status, label: state.statusLabels[status] || status }))
  ];
  els.statusPills.innerHTML = "";
  for (const item of items) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = `pill${state.statusFilter === item.id ? " active" : ""}`;
    pill.textContent = `${item.label} ${counts[item.id] || 0}`;
    pill.addEventListener("click", () => {
      state.statusFilter = item.id;
      renderPills();
      renderTable();
    });
    els.statusPills.appendChild(pill);
  }
}

function renderPlatformOptions() {
  const used = new Set(state.records.map((r) => r.platform));
  const options = [
    { value: "all", label: "全部平台" },
    ...Object.entries(state.platformLabels)
      .filter(([id]) => used.has(id))
      .map(([id, label]) => ({ value: id, label }))
  ];
  const previous = state.platformFilter;
  els.platformFilter.innerHTML = "";
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    els.platformFilter.appendChild(opt);
  }
  if (options.some((o) => o.value === previous)) {
    els.platformFilter.value = previous;
  } else {
    state.platformFilter = "all";
    els.platformFilter.value = "all";
  }
}

function getVisibleRecords() {
  return state.records.filter((r) => {
    if (state.statusFilter !== "all" && r.status !== state.statusFilter) {
      return false;
    }
    if (state.platformFilter !== "all" && r.platform !== state.platformFilter) {
      return false;
    }
    if (state.keyword) {
      const haystack = `${r.company || ""} ${r.jobTitle || ""}`.toLowerCase();
      if (!haystack.includes(state.keyword)) {
        return false;
      }
    }
    return true;
  });
}

function renderTable() {
  const records = getVisibleRecords();
  els.tableBody.innerHTML = "";
  els.emptyState.classList.toggle("hidden", records.length > 0);

  for (const record of records) {
    els.tableBody.appendChild(buildRow(record));
    if (state.expandedId === record.id) {
      els.tableBody.appendChild(buildDetailRow(record));
    }
  }
}

function buildRow(record) {
  const tr = document.createElement("tr");
  tr.className = "data-row";

  const tdCompany = cell(record.company || "（未识别）", "cell-company");
  const tdTitle = cell(record.jobTitle || "—", "cell-title");

  const tdPlatform = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = "badge-platform";
  badge.textContent = state.platformLabels[record.platform] || record.platform || "—";
  tdPlatform.appendChild(badge);

  const tdCity = cell(record.city || "—");
  const tdSalary = cell(record.salary || "—");

  const tdTime = document.createElement("td");
  tdTime.className = "cell-time";
  tdTime.textContent = formatTime(record.appliedAt);

  const tdStatus = document.createElement("td");
  const select = document.createElement("select");
  select.className = `status-select status-${record.status}`;
  for (const status of STATUS_ORDER) {
    const opt = document.createElement("option");
    opt.value = status;
    opt.textContent = state.statusLabels[status] || status;
    opt.selected = status === record.status;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    void applyStatus(record, select.value);
  });
  tdStatus.appendChild(select);

  const tdActions = document.createElement("td");
  tdActions.className = "row-actions";
  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "ghost";
  detailBtn.textContent = state.expandedId === record.id ? "收起" : "详情";
  detailBtn.addEventListener("click", () => {
    state.expandedId = state.expandedId === record.id ? null : record.id;
    renderTable();
  });
  tdActions.appendChild(detailBtn);

  if (record.rawUrl) {
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "ghost";
    openBtn.textContent = "打开";
    openBtn.addEventListener("click", () => {
      void chrome.tabs.create({ url: record.rawUrl });
    });
    tdActions.appendChild(openBtn);
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "ghost danger";
  deleteBtn.textContent = "删除";
  deleteBtn.addEventListener("click", () => {
    void removeRecord(record);
  });
  tdActions.appendChild(deleteBtn);

  tr.append(tdCompany, tdTitle, tdPlatform, tdCity, tdSalary, tdTime, tdStatus, tdActions);
  return tr;
}

function buildDetailRow(record) {
  const tr = document.createElement("tr");
  tr.className = "detail-row";
  const td = document.createElement("td");
  td.colSpan = 8;

  const grid = document.createElement("div");
  grid.className = "detail-grid";

  const fields = [
    { key: "company", label: "公司名称" },
    { key: "jobTitle", label: "岗位名称" },
    { key: "city", label: "城市" },
    { key: "salary", label: "薪资" }
  ];
  for (const field of fields) {
    const wrap = document.createElement("div");
    wrap.className = "detail-field";
    const label = document.createElement("label");
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type = "text";
    input.value = record[field.key] || "";
    input.dataset.field = field.key;
    wrap.append(label, input);
    grid.appendChild(wrap);
  }

  const notesWrap = document.createElement("div");
  notesWrap.className = "detail-field detail-notes";
  const notesLabel = document.createElement("label");
  notesLabel.textContent = "备注（面试时间、联系人、进展备忘...）";
  const notesInput = document.createElement("textarea");
  notesInput.value = record.notes || "";
  notesInput.dataset.field = "notes";
  notesWrap.append(notesLabel, notesInput);
  grid.appendChild(notesWrap);

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "detail-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "保存修改";
  const hint = document.createElement("span");
  hint.className = "save-hint hidden";
  hint.textContent = "已保存 ✓";
  saveBtn.addEventListener("click", () => {
    void saveRecordFields(record, td, hint);
  });
  actionsWrap.append(saveBtn, hint);
  grid.appendChild(actionsWrap);

  // 表单填写快照（插件填写过的字段）
  if (Array.isArray(record.formFields) && record.formFields.length) {
    const fieldsWrap = document.createElement("div");
    fieldsWrap.className = "detail-field detail-notes";
    const fieldsLabel = document.createElement("label");
    fieldsLabel.textContent = `表单填写快照（${record.formFields.length} 项）`;
    const fieldsList = document.createElement("ul");
    fieldsList.style.cssText = "margin:0;padding-left:18px;font-size:12.5px;color:#4b5563;line-height:1.8;";
    for (const field of record.formFields) {
      const li = document.createElement("li");
      li.textContent = `${field.label || "（未命名字段）"}：${field.value || "（未填值）"}`;
      fieldsList.appendChild(li);
    }
    fieldsWrap.append(fieldsLabel, fieldsList);
    grid.appendChild(fieldsWrap);
  }

  const timeline = document.createElement("ul");
  timeline.className = "timeline";
  const history = Array.isArray(record.statusHistory) ? record.statusHistory : [];
  for (const item of history.slice().reverse()) {
    const li = document.createElement("li");
    li.textContent = `${formatTime(item.at)} · ${state.statusLabels[item.status] || item.status}${item.note ? ` · ${item.note}` : ""}`;
    timeline.appendChild(li);
  }
  if (!history.length) {
    const li = document.createElement("li");
    li.textContent = formatTime(record.appliedAt);
    timeline.appendChild(li);
  }
  grid.appendChild(timeline);

  td.appendChild(grid);
  tr.appendChild(td);
  return tr;
}

function cell(text, className = "") {
  const td = document.createElement("td");
  if (className) {
    td.className = className;
  }
  td.textContent = text;
  if (className) {
    td.title = text;
  }
  return td;
}

async function applyStatus(record, status) {
  try {
    await sendRuntimeMessage({
      type: "TD_UPDATE_STATUS",
      payload: { id: record.id, status }
    });
    record.status = status;
    if (Array.isArray(record.statusHistory)) {
      record.statusHistory.push({ status, at: Date.now(), note: "" });
    }
    renderStats();
    renderPills();
    renderTable();
  } catch (error) {
    showToast(`状态更新失败：${error.message}`);
  }
}

async function saveRecordFields(record, container, hint) {
  const patch = {};
  for (const input of container.querySelectorAll("[data-field]")) {
    patch[input.dataset.field] = input.value;
  }
  try {
    await sendRuntimeMessage({
      type: "TD_UPDATE_RECORD",
      payload: { id: record.id, patch }
    });
    Object.assign(record, patch);
    hint.classList.remove("hidden");
    setTimeout(() => hint.classList.add("hidden"), 1600);
    renderTable();
  } catch (error) {
    showToast(`保存失败：${error.message}`);
  }
}

async function removeRecord(record) {
  if (!window.confirm(`删除这条投递记录？\n${record.company || ""} · ${record.jobTitle || ""}`)) {
    return;
  }
  try {
    await sendRuntimeMessage({ type: "TD_DELETE_RECORD", payload: { id: record.id } });
    state.records = state.records.filter((r) => r.id !== record.id);
    if (state.expandedId === record.id) {
      state.expandedId = null;
    }
    renderAll();
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  }
}

async function clearAll() {
  if (!state.records.length) {
    return;
  }
  if (!window.confirm(`确定清空全部 ${state.records.length} 条投递记录？此操作不可恢复。`)) {
    return;
  }
  try {
    await sendRuntimeMessage({ type: "TD_CLEAR_RECORDS" });
    state.records = [];
    state.expandedId = null;
    renderAll();
    showToast("已清空全部记录");
  } catch (error) {
    showToast(`清空失败：${error.message}`);
  }
}

function exportCsv() {
  const records = getVisibleRecords();
  if (!records.length) {
    showToast("当前筛选下没有可导出的记录");
    return;
  }
  const header = ["公司", "岗位", "平台", "城市", "薪资", "投递时间", "状态", "来源", "链接", "备注"];
  const rows = records.map((r) => [
    r.company || "",
    r.jobTitle || "",
    state.platformLabels[r.platform] || r.platform || "",
    r.city || "",
    r.salary || "",
    formatTime(r.appliedAt),
    state.statusLabels[r.status] || r.status || "",
    r.source === "auto" ? "自动" : "手动",
    r.rawUrl || r.url || "",
    r.notes || ""
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\r\n");
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  link.href = url;
  link.download = `投递记录_${stamp}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp) || 0);
  if (!date.getTime()) {
    return "—";
  }
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const base = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) {
    return base;
  }
  return `${date.getFullYear()}-${base}`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  els.toast.style.opacity = "1";
  setTimeout(() => {
    els.toast.style.opacity = "0";
    setTimeout(() => els.toast.classList.add("hidden"), 400);
  }, 2000);
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
