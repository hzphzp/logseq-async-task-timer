import "@logseq/libs";

const PRESET_MINUTES = [3, 5, 10, 15, 30, 1440, 4320];
const STORAGE_KEY = "logseq-async-task-timer-data";

let timers = new Map();
let timerIdCounter = 0;
let _pendingBlock = null;
let _lang = "en";

// ─── i18n ───

const I18N = {
  en: {
    noContent: "(no content)",
    setReminder: "⏱️ Set Async Task Reminder",
    custom: "Custom",
    minutes: "min",
    start: "Start",
    cancel: "Cancel",
    expired: "⏰ Task Timer Expired",
    expiredCount: (n) => ` (${n} items)`,
    expiredHint: "Countdown finished. Please check if the following tasks are done.",
    markDone: "✅ Done, mark DONE",
    snoozeWait: "Wait ",
    snoozeCustom: "Wait",
    dismiss: "Dismiss",
    timerSet: (label) => `⏱️ Reminder set for ${label}`,
    seconds: (n) => `${n}s`,
    day: (n) => `${n}d`,
    hour: (n) => `${n}h`,
    min: (n) => `${n}min`,
    expiredMsg: (label) => `⏰ Task expired!\n\n"${label}"\n\nCountdown finished, please check progress!`,
    expiredNotifTitle: "⏰ Task Timer Expired",
    expiredNotifBody: (label) => `"${label}" countdown finished, please check progress!`,
    restoreExpired: (n) => `⏰ ${n} task(s) expired while you were away!`,
    taskDone: "✅ Task marked as done!",
    snoozeMsg: (label) => `⏱️ Wait ${label} more`,
    noTimers: "No active timers",
    currentTimers: "⏱️ Active timers:\n",
    timerExpired: "⏰ Expired!",
    toolbarTitle: "Async Task Timer",
    ctxMenuItem: "⏱️ Set Async Reminder",
    panelTitle: "⏱️ Active Timers",
    panelEmpty: "No active timers",
    panelClickHint: "Click to jump to block",
  },
  zh: {
    noContent: "(无内容)",
    setReminder: "⏱️ 设置异步任务提醒",
    custom: "自定义",
    minutes: "分钟",
    start: "开始",
    cancel: "取消",
    expired: "⏰ 异步任务到期",
    expiredCount: (n) => ` (${n} 项)`,
    expiredHint: "倒计时已结束，请检查以下任务是否已完成",
    markDone: "✅ 已完成，标记 DONE",
    snoozeWait: "再等",
    snoozeCustom: "再等",
    dismiss: "暂时忽略",
    timerSet: (label) => `⏱️ 已设置 ${label} 后提醒`,
    seconds: (n) => `${n}秒`,
    day: (n) => `${n}天`,
    hour: (n) => `${n}小时`,
    min: (n) => `${n}分钟`,
    expiredMsg: (label) => `⏰ 异步任务到期！\n\n「${label}」\n\n倒计时已结束，请检查任务进度！`,
    expiredNotifTitle: "⏰ 异步任务到期",
    expiredNotifBody: (label) => `「${label}」倒计时已结束，请检查任务进度！`,
    restoreExpired: (n) => `⏰ 有 ${n} 个异步任务在你离开期间已到期！`,
    taskDone: "✅ 任务已标记完成!",
    snoozeMsg: (label) => `⏱️ 再等 ${label}`,
    noTimers: "暂无进行中的计时任务",
    currentTimers: "⏱️ 当前计时任务：\n",
    timerExpired: "⏰ 已到期!",
    toolbarTitle: "异步任务计时器",
    ctxMenuItem: "⏱️ 设置异步提醒",
    panelTitle: "⏱️ 当前计时任务",
    panelEmpty: "暂无进行中的计时任务",
    panelClickHint: "点击跳转到对应 block",
  },
};

function t(key, ...args) {
  const str = (I18N[_lang] || I18N.en)[key] || I18N.en[key];
  return typeof str === "function" ? str(...args) : str;
}

function formatMinutes(m) {
  if (m >= 1440 && m % 1440 === 0) return t("day", m / 1440);
  if (m >= 60 && m % 60 === 0) return t("hour", m / 60);
  return t("min", m);
}

// ─── Persistence ───

const LEGACY_DATA_PAGE = "logseq-async-task-timer-data";
const TIMER_PROP_EXPIRES_AT = "async-timer-expires-at";
const TIMER_PROP_TOTAL_SECONDS = "async-timer-total-seconds";
let _persistTimerPromise = Promise.resolve();
let _syncFromGraphTimer = null;
let _isRestoringTimers = false;

function decodeData(str) {
  const bytes = Uint8Array.from(atob(str), (c) => c.codePointAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function serializeTimers() {
  const data = [];
  for (const [, ti] of timers) {
    data.push({
      id: ti.id,
      blockUuid: ti.blockUuid,
      blockContent: ti.blockContent,
      totalSeconds: ti.totalSeconds,
      status: ti.status,
      expiresAt: ti.expiresAt,
    });
  }
  return data;
}

function saveTimers() {
  const data = serializeTimers();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
  return Promise.resolve();
}

function getTimerByBlockUuid(blockUuid) {
  for (const [, ti] of timers) {
    if (ti.blockUuid === blockUuid) return ti;
  }
  return null;
}

function normalizeQueryBlocks(result) {
  if (!Array.isArray(result)) return [];
  const blocks = [];
  for (const item of result) {
    if (Array.isArray(item)) {
      for (const inner of item) {
        if (inner && typeof inner === "object" && inner.uuid) blocks.push(inner);
      }
    } else if (item && typeof item === "object" && item.uuid) {
      blocks.push(item);
    }
  }
  return blocks;
}

function getBlockPropertyValue(block, key) {
  const candidates = [
    key,
    key.toLowerCase(),
    key.replace(/-/g, "_"),
    key.toLowerCase().replace(/-/g, "_"),
  ];
  for (const source of [block?.properties, block?.meta?.properties]) {
    if (!source || typeof source !== "object") continue;
    for (const candidate of candidates) {
      if (candidate in source) return source[candidate];
    }
  }
  return null;
}

function getTimerMetaFromBlock(block) {
  const expiresAtRaw = getBlockPropertyValue(block, TIMER_PROP_EXPIRES_AT);
  if (expiresAtRaw == null || expiresAtRaw === "") return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) return null;
  const totalSecondsRaw = getBlockPropertyValue(block, TIMER_PROP_TOTAL_SECONDS);
  const totalSeconds = Number.isFinite(Number(totalSecondsRaw))
    ? Number(totalSecondsRaw)
    : 0;
  return { expiresAt, totalSeconds: Math.max(0, totalSeconds) };
}

function hasClockMarker(block) {
  return typeof block?.content === "string" && /\s*⏰\s*$/.test(block.content);
}

function flattenBlocks(blocks) {
  const result = [];
  for (const block of blocks || []) {
    result.push(block);
    if (block?.children?.length) {
      result.push(...flattenBlocks(block.children));
    }
  }
  return result;
}

function parseLegacyDataLine(line) {
  const text = line.trim().replace(/^- /, "");
  if (!text || text.startsWith("<<<<<<<") || text.startsWith("=======") || text.startsWith(">>>>>>>")) {
    return null;
  }
  try {
    const data = decodeData(text);
    return Array.isArray(data) ? data : null;
  } catch (_) {
    return null;
  }
}

async function loadLegacyTimerData() {
  const byUuid = new Map();

  try {
    const blocks = await logseq.Editor.getPageBlocksTree(LEGACY_DATA_PAGE);
    for (const block of flattenBlocks(blocks)) {
      for (const line of String(block.content || "").split("\n")) {
        const data = parseLegacyDataLine(line);
        if (!data) continue;
        for (const item of data) {
          if (!item?.blockUuid || !item?.expiresAt) continue;
          const prev = byUuid.get(item.blockUuid);
          if (!prev || Number(item.expiresAt) > Number(prev.expiresAt)) {
            byUuid.set(item.blockUuid, item);
          }
        }
      }
    }
  } catch (_) {}

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item?.blockUuid || !item?.expiresAt) continue;
          const prev = byUuid.get(item.blockUuid);
          if (!prev || Number(item.expiresAt) > Number(prev.expiresAt)) {
            byUuid.set(item.blockUuid, item);
          }
        }
      }
    }
  } catch (_) {}

  return [...byUuid.values()];
}

function queueTimerPersistence(task) {
  _persistTimerPromise = _persistTimerPromise
    .catch(() => {})
    .then(task);
  return _persistTimerPromise;
}

function persistTimerToBlock(timer) {
  return queueTimerPersistence(async () => {
    await logseq.Editor.upsertBlockProperty(timer.blockUuid, TIMER_PROP_EXPIRES_AT, String(timer.expiresAt));
    await logseq.Editor.upsertBlockProperty(timer.blockUuid, TIMER_PROP_TOTAL_SECONDS, String(timer.totalSeconds));
  });
}

function removeTimerPropsFromBlock(blockUuid) {
  return queueTimerPersistence(async () => {
    try { await logseq.Editor.removeBlockProperty(blockUuid, TIMER_PROP_EXPIRES_AT); } catch (_) {}
    try { await logseq.Editor.removeBlockProperty(blockUuid, TIMER_PROP_TOTAL_SECONDS); } catch (_) {}
  });
}

async function queryTimerPropertyBlocks() {
  try {
    const result = await logseq.DB.datascriptQuery(`
      [:find (pull ?b [*])
       :where
       [?b :block/properties ?props]]
    `);
    return normalizeQueryBlocks(result).filter((block) => getTimerMetaFromBlock(block));
  } catch (e) {
    console.warn("queryTimerPropertyBlocks:", e);
    return [];
  }
}

async function queryClockMarkerBlocks() {
  try {
    const result = await logseq.DB.datascriptQuery(`
      [:find (pull ?b [*])
       :where
       [?b :block/content ?content]]
    `);
    return normalizeQueryBlocks(result).filter(hasClockMarker);
  } catch (e) {
    console.warn("queryClockMarkerBlocks:", e);
    return [];
  }
}

async function loadTimerData() {
  const byUuid = new Map();

  for (const block of await queryTimerPropertyBlocks()) {
    const meta = getTimerMetaFromBlock(block);
    if (!meta) continue;
    byUuid.set(block.uuid, {
      blockUuid: block.uuid,
      blockContent: block.content || "",
      totalSeconds: meta.totalSeconds,
      expiresAt: meta.expiresAt,
      source: "block",
    });
  }

  for (const block of await queryClockMarkerBlocks()) {
    if (byUuid.has(block.uuid)) continue;
    byUuid.set(block.uuid, {
      blockUuid: block.uuid,
      blockContent: block.content || "",
      totalSeconds: 0,
      expiresAt: Date.now() - 1000,
      source: "marker",
    });
  }

  for (const item of await loadLegacyTimerData()) {
    if (!item?.blockUuid || byUuid.has(item.blockUuid)) continue;
    const block = await logseq.Editor.getBlock(item.blockUuid);
    if (!block) continue;
    if (!hasClockMarker(block) && !getTimerMetaFromBlock(block)) continue;
    byUuid.set(item.blockUuid, {
      blockUuid: item.blockUuid,
      blockContent: block.content || item.blockContent || "",
      totalSeconds: Number(item.totalSeconds) || 0,
      expiresAt: Number(item.expiresAt) || (Date.now() - 1000),
      source: "legacy",
    });
  }

  return [...byUuid.values()];
}

async function cleanupLegacyTimerPage() {
  try {
    const page = await logseq.Editor.getPage(LEGACY_DATA_PAGE);
    if (page) await logseq.Editor.deletePage(LEGACY_DATA_PAGE);
  } catch (_) {}
}

function startTimerInterval(timer) {
  timer.intervalId = setInterval(async () => {
    timer.remaining = Math.ceil((timer.expiresAt - Date.now()) / 1000);
    if (timer.remaining <= 0) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
      timer.remaining = 0;
      timer.status = "expired";
      await saveTimers();
      await persistTimerToBlock(timer);
      await onTimerExpired(timer);
    }
  }, 1000);
}

async function restoreTimers({ notifyExpired = true } = {}) {
  if (_isRestoringTimers) return;
  _isRestoringTimers = true;
  try {
    const data = await loadTimerData();
    const existingByUuid = new Map([...timers.values()].map((ti) => [ti.blockUuid, ti]));
    const expiredOnRestore = [];
    const recoveredTimers = [];
    const nextTimers = new Map();

    for (const item of data) {
      if (!item.blockUuid || !item.expiresAt) continue;
      const existing = existingByUuid.get(item.blockUuid);
      const remaining = Math.ceil((item.expiresAt - Date.now()) / 1000);

      const timer = {
        id: existing?.id ?? ++timerIdCounter,
        blockUuid: item.blockUuid,
        blockContent: item.blockContent || "",
        totalSeconds: item.totalSeconds || 0,
        remaining: Math.max(0, remaining),
        status: remaining <= 0 ? "expired" : "running",
        expiresAt: item.expiresAt,
        intervalId: null,
      };

      nextTimers.set(timer.id, timer);

      if (timer.status === "running") {
        continue;
      } else {
        if (
          notifyExpired &&
          (!existing || existing.status !== "expired" || existing.expiresAt !== timer.expiresAt)
        ) {
          expiredOnRestore.push(timer);
        }
      }

      if (item.source === "marker" || item.source === "legacy") {
        recoveredTimers.push(timer);
      }
    }

    for (const [, timer] of timers) {
      if (timer.intervalId) clearInterval(timer.intervalId);
    }

    timers = nextTimers;

    for (const [, timer] of timers) {
      if (timer.status === "running") {
        startTimerInterval(timer);
      }
    }

    for (const timer of recoveredTimers) {
      await persistTimerToBlock(timer);
    }

    await saveTimers();
    if (timers.size > 0) await cleanupLegacyTimerPage();

    if (expiredOnRestore.length > 0) {
      setTimeout(async () => {
        for (const ti of expiredOnRestore) await refreshBlockContent(ti);
        playAlertSound();
        logseq.UI.showMsg(t("restoreExpired", expiredOnRestore.length), "warning", { timeout: 15000 });
        renderExpiredList();
        logseq.showMainUI({ autoFocus: true });
      }, 2000);
    }
  } catch (e) {
    console.warn("restoreTimers:", e);
  } finally {
    _isRestoringTimers = false;
  }
}

function scheduleRestoreTimers(opts = {}) {
  clearTimeout(_syncFromGraphTimer);
  _syncFromGraphTimer = setTimeout(() => {
    restoreTimers(opts);
  }, 500);
}

function isTimerRelevantBlock(block) {
  return !!(
    block?.uuid &&
    (
      hasClockMarker(block) ||
      getTimerMetaFromBlock(block) ||
      getTimerByBlockUuid(block.uuid)
    )
  );
}

// ─── Utilities ───

function truncate(str, len = 40) {
  if (!str) return t("noContent");
  return str
    .replace(/(?:^|\n)(?:async-timer-expires-at|async-timer-total-seconds)::[^\n]*/gi, "")
    .replace(/^(TODO|DOING|DONE|LATER|NOW|WAITING)\s+/i, "")
    .replace(/⏰\s*$/, "").trim().slice(0, len) || t("noContent");
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 250, 500, 1000, 1250, 1500].forEach((d) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = d < 800 ? 880 : 660;
      o.type = "sine"; g.gain.value = 0.25;
      o.start(ctx.currentTime + d / 1000);
      o.stop(ctx.currentTime + d / 1000 + 0.12);
    });
  } catch (_) {}
}

// ─── Block marker ───

async function addClockMarker(uuid) {
  try {
    const block = await logseq.Editor.getBlock(uuid);
    if (block && !hasClockMarker(block)) {
      await logseq.Editor.updateBlock(uuid, block.content.trimEnd() + " ⏰");
    }
  } catch (_) {}
}

async function removeClockMarker(uuid) {
  try {
    const block = await logseq.Editor.getBlock(uuid);
    if (block && hasClockMarker(block)) {
      await logseq.Editor.updateBlock(uuid, block.content.replace(/\s*⏰\s*$/, "").trimEnd());
    }
  } catch (_) {}
}

// ─── Timer ───

async function createTimer(blockUuid, blockContent, minutes) {
  const totalSeconds = Math.max(1, Math.round(minutes * 60));
  let timer = getTimerByBlockUuid(blockUuid);
  if (timer?.intervalId) clearInterval(timer.intervalId);
  timer = {
    id: timer?.id ?? ++timerIdCounter,
    blockUuid,
    blockContent,
    totalSeconds,
    remaining: totalSeconds,
    expiresAt: Date.now() + totalSeconds * 1000,
    status: "running",
    intervalId: null,
  };

  timers = new Map([...timers].filter(([, ti]) => ti.blockUuid !== blockUuid));
  startTimerInterval(timer);
  timers.set(timer.id, timer);
  await addClockMarker(blockUuid);
  await persistTimerToBlock(timer);
  saveTimers();
  const label = minutes < 1 ? t("seconds", totalSeconds) : formatMinutes(minutes);
  logseq.UI.showMsg(t("timerSet", label), "success", { timeout: 2000 });
}

function getExpiredTimers() {
  return [...timers.values()].filter(ti => ti.status === "expired");
}

async function refreshBlockContent(timer) {
  try {
    const block = await logseq.Editor.getBlock(timer.blockUuid);
    if (block && block.content) {
      timer.blockContent = block.content;
      await saveTimers();
    }
  } catch (_) {}
}

async function onTimerExpired(timer) {
  await refreshBlockContent(timer);
  const label = truncate(timer.blockContent, 40);

  playAlertSound();

  logseq.UI.showMsg(t("expiredMsg", label), "warning", { timeout: 30000 });

  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(t("expiredNotifTitle"), {
        body: t("expiredNotifBody", label),
        requireInteraction: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch (_) {}

  renderExpiredList();
  logseq.showMainUI({ autoFocus: true });
}

function refreshAfterAction() {
  const expired = getExpiredTimers();
  if (expired.length > 0) {
    renderExpiredList();
  } else {
    logseq.hideMainUI();
  }
}

async function completeTimer(id) {
  const timer = timers.get(id);
  if (!timer) return;
  if (timer.intervalId) clearInterval(timer.intervalId);
  try {
    const block = await logseq.Editor.getBlock(timer.blockUuid);
    if (block) {
      const c = block.content.replace(/\s*⏰/g, "")
        .replace(/^(TODO|DOING|LATER|NOW|WAITING)\s+/i, "DONE ").trimEnd();
      await logseq.Editor.updateBlock(timer.blockUuid, c);
    }
  } catch (e) { console.warn("completeTimer:", e); }
  timers.delete(id);
  await removeTimerPropsFromBlock(timer.blockUuid);
  saveTimers();
  logseq.UI.showMsg(t("taskDone"), "success", { timeout: 2000 });
}

async function snoozeTimer(id, minutes) {
  const timer = timers.get(id);
  if (!timer) return;
  if (timer.intervalId) clearInterval(timer.intervalId);
  timer.remaining = minutes * 60;
  timer.totalSeconds = minutes * 60;
  timer.expiresAt = Date.now() + minutes * 60 * 1000;
  timer.status = "running";
  startTimerInterval(timer);
  await persistTimerToBlock(timer);
  saveTimers();
  logseq.UI.showMsg(t("snoozeMsg", formatMinutes(minutes)), "success", { timeout: 2000 });
}

async function dismissTimer(id) {
  const timer = timers.get(id);
  if (!timer) return;
  if (timer.intervalId) clearInterval(timer.intervalId);
  await removeClockMarker(timer.blockUuid);
  timers.delete(id);
  await removeTimerPropsFromBlock(timer.blockUuid);
  saveTimers();
}

// ─── Render ───

function renderPickerDialog() {
  if (!_pendingBlock) return;
  const taskText = escapeHtml(truncate(_pendingBlock.content, 60));
  document.getElementById("app").innerHTML = `
    <div class="overlay" id="overlay-bg">
      <div class="dialog">
        <div class="title">${t("setReminder")}</div>
        <div class="task">${taskText}</div>
        <div class="presets">
          ${PRESET_MINUTES.map(m =>
            `<button class="preset-btn" data-minutes="${m}">${formatMinutes(m)}</button>`
          ).join("")}
        </div>
        <div class="custom-row">
          <input type="number" id="custom-input" min="0.1" step="0.1" placeholder="${t("custom")}" />
          <span class="unit">${t("minutes")}</span>
          <button id="custom-start-btn">${t("start")}</button>
        </div>
        <button class="cancel-btn" id="cancel-btn">${t("cancel")}</button>
      </div>
    </div>`;

  setTimeout(() => {
    const input = document.getElementById("custom-input");
    if (input) input.focus();
  }, 100);
}

function renderExpiredList() {
  const expired = getExpiredTimers();
  if (expired.length === 0) return;

  const countLabel = expired.length > 1 ? t("expiredCount", expired.length) : "";
  const items = expired.map(timer => {
    const taskText = escapeHtml(truncate(timer.blockContent, 60));
    return `
      <div class="expired-item">
        <div class="task">${taskText}</div>
        <div class="expired-actions">
          <button class="action-btn done-btn" data-action="done" data-id="${timer.id}">${t("markDone")}</button>
          <div class="snooze-row">
            ${PRESET_MINUTES.map(m =>
              `<button class="action-btn snooze-btn" data-action="snooze" data-id="${timer.id}" data-minutes="${m}">${t("snoozeWait")}${formatMinutes(m)}</button>`
            ).join("")}
          </div>
          <div class="snooze-custom-row">
            <input type="number" class="snooze-custom-input" data-id="${timer.id}" min="0.1" step="0.1" placeholder="${t("custom")}" />
            <span class="unit">${t("minutes")}</span>
            <button class="action-btn snooze-custom-btn" data-id="${timer.id}">${t("snoozeCustom")}</button>
          </div>
          <button class="action-btn dismiss-btn" data-action="dismiss" data-id="${timer.id}">${t("dismiss")}</button>
        </div>
      </div>`;
  }).join("");

  document.getElementById("app").innerHTML = `
    <div class="overlay" id="overlay-bg">
      <div class="dialog expired-dialog">
        <div class="title">${t("expired")}${countLabel}</div>
        <div class="expired-hint">${t("expiredHint")}</div>
        <div class="expired-list">${items}</div>
      </div>
    </div>`;
}

function renderTimerPanel() {
  const all = [...timers.values()].sort((a, b) => {
    if (a.status === "expired" && b.status !== "expired") return -1;
    if (a.status !== "expired" && b.status === "expired") return 1;
    return a.remaining - b.remaining;
  });

  if (all.length === 0) {
    logseq.UI.showMsg(t("panelEmpty"), "info", { timeout: 2000 });
    return;
  }

  const items = all.map(ti => {
    const taskText = escapeHtml(truncate(ti.blockContent, 50));
    if (ti.status === "expired") {
      return `<div class="panel-item-wrap">
        <div class="panel-item panel-item-expired">
          <span class="panel-time panel-expired">${t("timerExpired")}</span>
          <span class="panel-task panel-task-link" data-uuid="${ti.blockUuid}">${taskText}</span>
          <button class="panel-done-btn" data-action="done" data-id="${ti.id}" title="${t("markDone")}">✅</button>
          <button class="panel-snooze-toggle" data-id="${ti.id}" title="${t("snoozeWait")}">⏱</button>
          <button class="panel-dismiss-btn" data-action="dismiss" data-id="${ti.id}" title="${t("dismiss")}">✕</button>
        </div>
        <div class="panel-snooze-area" id="panel-snooze-${ti.id}" style="display:none">
          <div class="panel-snooze-presets">
            ${PRESET_MINUTES.map(m =>
              `<button class="panel-snooze-preset" data-action="snooze" data-id="${ti.id}" data-minutes="${m}">${formatMinutes(m)}</button>`
            ).join("")}
          </div>
          <div class="panel-snooze-custom">
            <input type="number" class="panel-snooze-input" data-id="${ti.id}" min="0.1" step="0.1" placeholder="${t("custom")}" />
            <span class="unit">${t("minutes")}</span>
            <button class="panel-snooze-go" data-id="${ti.id}">${t("snoozeCustom")}</button>
          </div>
        </div>
      </div>`;
    }
    return `<div class="panel-item" data-uuid="${ti.blockUuid}">
      <span class="panel-time">${formatTime(ti.remaining)}</span>
      <span class="panel-task">${taskText}</span>
    </div>`;
  }).join("");

  document.getElementById("app").innerHTML = `
    <div class="overlay" id="overlay-bg">
      <div class="dialog panel-dialog">
        <div class="title">${t("panelTitle")}</div>
        <div class="panel-hint">${t("panelClickHint")}</div>
        <div class="panel-list">${items}</div>
        <button class="cancel-btn" id="cancel-btn">${t("cancel")}</button>
      </div>
    </div>`;
}

// ─── Events ───

async function startCustomTimer() {
  const input = document.getElementById("custom-input");
  if (!input || !_pendingBlock) return;
  const val = parseFloat(input.value);
  if (!val || val <= 0) {
    input.style.borderColor = "#ef5350";
    input.focus();
    return;
  }
  await createTimer(_pendingBlock.uuid, _pendingBlock.content, val);
  _pendingBlock = null;
  logseq.hideMainUI();
}

function setupEvents() {
  document.addEventListener("click", async (e) => {
    const presetBtn = e.target.closest(".preset-btn");
    if (presetBtn && _pendingBlock) {
      await createTimer(_pendingBlock.uuid, _pendingBlock.content, parseFloat(presetBtn.dataset.minutes));
      _pendingBlock = null;
      logseq.hideMainUI();
      return;
    }

    if (e.target.id === "custom-start-btn") {
      await startCustomTimer();
      return;
    }

    const snoozeCustomBtn = e.target.closest(".snooze-custom-btn");
    if (snoozeCustomBtn) {
      const id = parseInt(snoozeCustomBtn.dataset.id);
      const input = document.querySelector(`.snooze-custom-input[data-id="${id}"]`);
      if (input) {
        const val = parseFloat(input.value);
        if (!val || val <= 0) { input.style.borderColor = "#ef5350"; input.focus(); return; }
        await snoozeTimer(id, val);
        refreshAfterAction();
      }
      return;
    }

    const snoozeToggle = e.target.closest(".panel-snooze-toggle");
    if (snoozeToggle) {
      const id = snoozeToggle.dataset.id;
      const area = document.getElementById(`panel-snooze-${id}`);
      if (area) area.style.display = area.style.display === "none" ? "block" : "none";
      return;
    }

    const panelSnoozePreset = e.target.closest(".panel-snooze-preset");
    if (panelSnoozePreset) {
      const id = parseInt(panelSnoozePreset.dataset.id);
      const minutes = parseFloat(panelSnoozePreset.dataset.minutes);
      await snoozeTimer(id, minutes);
      if (timers.size > 0) { renderTimerPanel(); } else { logseq.hideMainUI(); }
      return;
    }

    const panelSnoozeGo = e.target.closest(".panel-snooze-go");
    if (panelSnoozeGo) {
      const id = parseInt(panelSnoozeGo.dataset.id);
      const input = document.querySelector(`.panel-snooze-input[data-id="${id}"]`);
      if (input) {
        const val = parseFloat(input.value);
        if (!val || val <= 0) { input.style.borderColor = "#ef5350"; input.focus(); return; }
        await snoozeTimer(id, val);
        if (timers.size > 0) { renderTimerPanel(); } else { logseq.hideMainUI(); }
      }
      return;
    }

    const panelActionBtn = e.target.closest(".panel-done-btn, .panel-dismiss-btn");
    if (panelActionBtn) {
      const { action, id } = panelActionBtn.dataset;
      if (action === "done") await completeTimer(parseInt(id));
      else if (action === "dismiss") await dismissTimer(parseInt(id));
      if (timers.size > 0) {
        renderTimerPanel();
      } else {
        logseq.hideMainUI();
      }
      return;
    }

    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      const { action, id, minutes } = actionBtn.dataset;
      if (action === "done") await completeTimer(parseInt(id));
      else if (action === "snooze") await snoozeTimer(parseInt(id), parseFloat(minutes));
      else if (action === "dismiss") await dismissTimer(parseInt(id));
      refreshAfterAction();
      return;
    }

    const taskLink = e.target.closest(".panel-task-link");
    if (taskLink) {
      const uuid = taskLink.dataset.uuid;
      if (uuid) {
        logseq.hideMainUI();
        logseq.Editor.scrollToBlockInPage(uuid);
      }
      return;
    }

    const panelItem = e.target.closest(".panel-item:not(.panel-item-expired)");
    if (panelItem) {
      const uuid = panelItem.dataset.uuid;
      if (uuid) {
        logseq.hideMainUI();
        logseq.Editor.scrollToBlockInPage(uuid);
      }
      return;
    }

    if (e.target.id === "cancel-btn") {
      _pendingBlock = null;
      logseq.hideMainUI();
      return;
    }

    if (e.target.id === "overlay-bg") {
      _pendingBlock = null;
      logseq.hideMainUI();
    }
  });

  document.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      _pendingBlock = null;
      logseq.hideMainUI();
    }
    if (e.key === "Enter" && e.target.id === "custom-input") {
      await startCustomTimer();
    }
    if (e.key === "Enter" && e.target.classList.contains("snooze-custom-input")) {
      const id = parseInt(e.target.dataset.id);
      const val = parseFloat(e.target.value);
      if (!val || val <= 0) { e.target.style.borderColor = "#ef5350"; return; }
      await snoozeTimer(id, val);
      refreshAfterAction();
    }
    if (e.key === "Enter" && e.target.classList.contains("panel-snooze-input")) {
      const id = parseInt(e.target.dataset.id);
      const val = parseFloat(e.target.value);
      if (!val || val <= 0) { e.target.style.borderColor = "#ef5350"; return; }
      await snoozeTimer(id, val);
      if (timers.size > 0) { renderTimerPanel(); } else { logseq.hideMainUI(); }
    }
  });
}

function openPickerDialog(uuid, content) {
  _pendingBlock = { uuid, content };
  renderPickerDialog();
  logseq.showMainUI({ autoFocus: true });
}

// ─── Language detection ───

async function detectLanguage() {
  const settings = logseq.settings;
  if (settings?.language === "zh" || settings?.language === "en") {
    return settings.language;
  }
  try {
    const config = await logseq.App.getUserConfigs();
    if (config?.preferredLanguage) {
      return config.preferredLanguage.startsWith("zh") ? "zh" : "en";
    }
  } catch (_) {}
  return "en";
}

// ─── Main ───

async function main() {
  logseq.useSettingsSchema([
    {
      key: "language",
      type: "enum",
      title: "Language / 界面语言",
      description: "Choose the UI language for the plugin. Default: English",
      default: "auto",
      enumChoices: ["auto", "en", "zh"],
      enumPicker: "select",
    },
  ]);

  const langSetting = logseq.settings?.language || "auto";
  _lang = langSetting === "auto" ? await detectLanguage() : langSetting;

  logseq.onSettingsChanged((newSettings) => {
    const newLang = newSettings?.language || "auto";
    if (newLang === "auto") {
      detectLanguage().then(l => { _lang = l; });
    } else {
      _lang = newLang;
    }
  });

  logseq.setMainUIInlineStyle({
    position: "fixed", zIndex: "999",
    top: "0", left: "0", width: "100vw", height: "100vh",
  });

  logseq.provideStyle(`
    .block-properties > div:has([data-key="async-timer-expires-at"]),
    .block-properties > div:has([data-key="async-timer-total-seconds"]),
    .block-properties > div:has(a[data-ref="async-timer-expires-at"]),
    .block-properties > div:has(a[data-ref="async-timer-total-seconds"]),
    .block-properties [data-key="async-timer-expires-at"],
    .block-properties [data-key="async-timer-total-seconds"],
    .block-properties a[data-ref="async-timer-expires-at"],
    .block-properties a[data-ref="async-timer-total-seconds"] {
      display: none !important;
    }
  `);

  setupEvents();

  logseq.DB.onChanged(({ blocks }) => {
    if ((blocks || []).some(isTimerRelevantBlock)) {
      scheduleRestoreTimers({ notifyExpired: true });
    }
  });

  logseq.Editor.registerSlashCommand("Async Timer", async () => {
    const block = await logseq.Editor.getCurrentBlock();
    if (!block) return;
    const editingContent = await logseq.Editor.getEditingBlockContent();
    openPickerDialog(block.uuid, editingContent || block.content);
  });
  logseq.Editor.registerSlashCommand("异步任务计时", async () => {
    const block = await logseq.Editor.getCurrentBlock();
    if (!block) return;
    const editingContent = await logseq.Editor.getEditingBlockContent();
    openPickerDialog(block.uuid, editingContent || block.content);
  });

  logseq.Editor.registerBlockContextMenuItem(t("ctxMenuItem"), async ({ uuid }) => {
    const block = await logseq.Editor.getBlock(uuid);
    if (block) openPickerDialog(block.uuid, block.content);
  });

  logseq.provideModel({
    toggleTimerPanel() {
      if (timers.size === 0) {
        logseq.UI.showMsg(t("panelEmpty"), "info", { timeout: 2000 });
        return;
      }
      renderTimerPanel();
      logseq.showMainUI({ autoFocus: true });
    },
  });

  logseq.App.registerUIItem("toolbar", {
    key: "timer-toolbar-btn",
    template: `<a class="button" data-on-click="toggleTimerPanel" title="${t("toolbarTitle")}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/>
        <path d="M5 3L2 6"/><path d="M22 6l-3-3"/><path d="M12 2v2"/>
      </svg></a>`,
  });

  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }

  await restoreTimers();
}

logseq.ready(main).catch(console.error);
