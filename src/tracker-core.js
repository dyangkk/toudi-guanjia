// 投递记录核心数据层 —— 只被 background.js 引入，所有读写集中在这里。
// 记录保存在 chrome.storage.local（本机），不上传任何服务器。

export const TD_STORAGE_KEY = "td_applications_v1";

const STATUS_LABELS = {
  applied: "已投递",
  viewed: "已查看",
  chatting: "沟通中",
  interview: "面试",
  offer: "Offer",
  rejected: "不合适"
};

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

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECORDS = 5000;

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.search = "";
    return u.origin + u.pathname;
  } catch {
    return String(raw || "").trim();
  }
}

function detectPlatform(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "manual";
  }
  if (/(^|\.)zhipin\.com$/.test(host)) return "boss";
  if (/(^|\.)liepin\.com$/.test(host)) return "liepin";
  if (/(^|\.)zhaopin\.com$/.test(host)) return "zhaopin";
  if (/(^|\.)51job\.com$/.test(host)) return "job51";
  if (/(^|\.)nowcoder\.com$/.test(host)) return "nowcoder";
  if (/(^|\.)lagou\.com$/.test(host)) return "lagou";
  return "web";
}

function cleanText(value, max = 120) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readAll() {
  const values = await chrome.storage.local.get(TD_STORAGE_KEY);
  const data = values[TD_STORAGE_KEY];
  return Array.isArray(data?.records) ? data.records : [];
}

async function writeAll(records) {
  await chrome.storage.local.set({
    [TD_STORAGE_KEY]: {
      version: 1,
      updatedAt: Date.now(),
      records
    }
  });
}

export async function listRecords() {
  return readAll();
}

export async function addRecord(payload = {}, source = "auto") {
  const url = normalizeUrl(payload.url);
  const now = Date.now();
  const records = await readAll();

  // 同一页面短时间内的多次信号（点击 + 成功提示）视为同一次投递
  const duplicate = records.find(
    (r) => url && r.url === url && now - r.appliedAt < DEDUPE_WINDOW_MS
  );
  if (duplicate) {
    duplicate.updatedAt = now;
    duplicate.hitCount = (duplicate.hitCount || 1) + 1;
    await writeAll(records);
    return { record: duplicate, duplicate: true };
  }

  const record = {
    id: makeId(),
    platform: payload.platform || detectPlatform(payload.url),
    company: cleanText(payload.company),
    jobTitle: cleanText(payload.jobTitle),
    city: cleanText(payload.city),
    salary: cleanText(payload.salary),
    url,
    rawUrl: cleanText(payload.url, 500),
    source,
    appliedAt: now,
    updatedAt: now,
    status: "applied",
    notes: "",
    hitCount: 1,
    statusHistory: [{ status: "applied", at: now, note: "" }]
  };
  records.unshift(record);
  await writeAll(records.slice(0, MAX_RECORDS));
  return { record, duplicate: false };
}

export async function updateStatus(id, status, note = "") {
  if (!STATUS_LABELS[status]) {
    throw new Error(`未知状态：${status}`);
  }
  const records = await readAll();
  const record = records.find((r) => r.id === id);
  if (!record) {
    throw new Error("记录不存在");
  }
  const now = Date.now();
  record.status = status;
  record.updatedAt = now;
  record.statusHistory.push({ status, at: now, note: cleanText(note, 200) });
  await writeAll(records);
  return record;
}

export async function updateFields(id, patch = {}) {
  const records = await readAll();
  const record = records.find((r) => r.id === id);
  if (!record) {
    throw new Error("记录不存在");
  }
  const limits = { company: 120, jobTitle: 120, city: 40, salary: 60, notes: 1000 };
  for (const key of Object.keys(limits)) {
    if (patch[key] !== undefined) {
      record[key] = cleanText(patch[key], limits[key]);
    }
  }
  record.updatedAt = Date.now();
  await writeAll(records);
  return record;
}

export async function deleteRecord(id) {
  const records = await readAll();
  const next = records.filter((r) => r.id !== id);
  await writeAll(next);
  return { removed: records.length - next.length };
}

export async function clearRecords() {
  await writeAll([]);
  return {};
}

export function summarize(records = []) {
  const byStatus = {};
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  let today = 0;
  for (const record of records) {
    byStatus[record.status] = (byStatus[record.status] || 0) + 1;
    if (record.appliedAt >= dayStart.getTime()) {
      today += 1;
    }
  }
  return { total: records.length, today, byStatus };
}

export function getStatusLabels() {
  return { ...STATUS_LABELS };
}

export function getPlatformLabels() {
  return { ...PLATFORM_LABELS };
}
