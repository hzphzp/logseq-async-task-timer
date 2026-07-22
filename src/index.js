import "@logseq/libs";

const PRESET_MINUTES = [3, 5, 10, 15, 30, 60, 240, 720, 1440, 4320];
const STORAGE_KEY = "logseq-async-task-timer-data";
// Tracks which (blockUuid @ expiresAt) reminders have already been pushed to the
// WeCom bot, so a still-expired timer isn't re-sent on every Logseq restart.
const BOT_NOTIFIED_KEY = "logseq-async-task-timer-bot-notified";

let timers = new Map();
let timerIdCounter = 0;
let _pendingBlock = null;
let _lang = "en";
let _lastExpiredTimerId = null;

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
    resetTimer: "Reset timer",
    justExpired: "Just expired",
    overdueFor: (label) => `Overdue ${label}`,
    clearAllExpired: "🧹 Clear all expired",
    clearedExpired: (n) => `🧹 Cleared ${n} expired timer(s)`,
    inlineChangeTime: "Change time",
    inlineComplete: "Complete",
    botHeader: "## ⏰ Async Task Reminder",
    botFooter: "Countdown finished — please check the progress.",
    botLineTask: (v) => `> **Task**: ${v}`,
    botLinePage: (v) => `> **Page**: ${v}`,
    botLineDuration: (v) => `> **Duration**: ${v}`,
    botLineDueTime: (v) => `> **Due**: ${v}`,
    botLineStatus: (v) => `> **Status**: <font color="warning">${v}</font>`,
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
    resetTimer: "重设计时",
    justExpired: "刚刚超时",
    overdueFor: (label) => `已超时 ${label}`,
    clearAllExpired: "🧹 清除所有过期",
    clearedExpired: (n) => `🧹 已清除 ${n} 个过期计时`,
    inlineChangeTime: "修改时间",
    inlineComplete: "完成",
    botHeader: "## ⏰ 异步任务到期提醒",
    botFooter: "倒计时已结束，请检查任务进度！",
    botLineTask: (v) => `> **任务**：${v}`,
    botLinePage: (v) => `> **页面**：${v}`,
    botLineDuration: (v) => `> **时长**：${v}`,
    botLineDueTime: (v) => `> **到期时间**：${v}`,
    botLineStatus: (v) => `> **状态**：<font color="warning">${v}</font>`,
  },
};

function t(key, ...args) {
  const str = (I18N[_lang] || I18N.en)[key] || I18N.en[key];
  return typeof str === "function" ? str(...args) : str;
}

function formatMinutes(m) {
  if (m >= 720 && m % 720 === 0) return t("day", m / 1440);
  if (m >= 60 && m % 60 === 0) return t("hour", m / 60);
  return t("min", m);
}

// ─── Persistence ───

const LEGACY_DATA_PAGE = "logseq-async-task-timer-data";
// New single-line format: `async-timer:: <expiresAtMs>~<totalSeconds>`.
// The two-property format below is still read for backward compatibility and
// gets migrated to the single line on the next write/clear.
const TIMER_PROP = "async-timer";
const TIMER_PROP_EXPIRES_AT = "async-timer-expires-at";
const TIMER_PROP_TOTAL_SECONDS = "async-timer-total-seconds";
const INLINE_TIMER_RENDERER_TYPE = ":async-task-timer-controls";
const INLINE_TIMER_RENDERER = `{{renderer ${INLINE_TIMER_RENDERER_TYPE}}}`;
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

function parseCombinedTimerValue(raw) {
  if (raw == null || raw === "") return null;
  // Logseq may hand back a string or (if it ever splits) an array.
  const str = Array.isArray(raw) ? raw.join("~") : String(raw);
  const [expiresStr, totalStr] = str.split(/[~,]/);
  const expiresAt = Number(expiresStr);
  if (!Number.isFinite(expiresAt)) return null;
  const totalSeconds = Number.isFinite(Number(totalStr)) ? Number(totalStr) : 0;
  return { expiresAt, totalSeconds: Math.max(0, totalSeconds) };
}

function getTimerMetaFromBlock(block) {
  // Preferred: new single-line property (when Logseq surfaces it).
  const combined = parseCombinedTimerValue(getBlockPropertyValue(block, TIMER_PROP));
  if (combined) return combined;

  // Fallback: read straight from the raw content. Some Logseq builds don't put
  // every property into :block/properties (depends on how the value parses), so
  // the markdown text is the real source of truth.
  const contentMatch = String(block?.content || "")
    .match(/(?:^|\n)[ \t]*async-timer::[ \t]*([^\n]+)/i);
  if (contentMatch) {
    const fromContent = parseCombinedTimerValue(contentMatch[1]);
    if (fromContent) return fromContent;
  }

  // Backward compatibility: legacy two-property format.
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

function extractTimerPropertyLines(content) {
  return String(content || "")
    .split("\n")
    .filter((line) => /^\s*async-timer(-expires-at|-total-seconds)?::/i.test(line));
}

function mergePreferredContentWithTimerProps(preferredContent, existingContent) {
  const base = String(preferredContent || "").trimEnd();
  const timerPropertyLines = extractTimerPropertyLines(existingContent);
  if (timerPropertyLines.length === 0) return base;
  return `${base}\n${timerPropertyLines.join("\n")}`;
}

function mutateFirstLine(content, transform) {
  const lines = String(content || "").split("\n");
  if (lines.length === 0) return transform("");
  lines[0] = transform(lines[0] || "");
  return lines.join("\n");
}

function markBlockAsDoing(content) {
  return mutateFirstLine(content, (line) => {
    const marker = /^(\s*)(TODO|DOING|DONE|LATER|NOW|WAITING)(?:\s+|$)/i;
    if (marker.test(line)) return line.replace(marker, "$1DOING ");
    const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
    const text = line.slice(leadingWhitespace.length);
    return `${leadingWhitespace}DOING${text ? ` ${text}` : ""}`;
  });
}

function hasClockMarker(blockOrContent) {
  const content = typeof blockOrContent === "string"
    ? blockOrContent
    : blockOrContent?.content;
  const firstLine = String(content || "").split("\n")[0] || "";
  return /\s*⏰\s*$/.test(removeInlineTimerRendererFromContent(firstLine));
}

function addClockMarkerToContent(content) {
  if (hasClockMarker(content)) return String(content || "");
  return mutateFirstLine(content, (line) => `${line.trimEnd()} ⏰`);
}

function removeClockMarkerFromContent(content) {
  return mutateFirstLine(content, (line) => line.replace(/\s*⏰\s*$/, "").trimEnd());
}

function removeInlineTimerRendererFromContent(content) {
  return mutateFirstLine(content, (line) => line
    .replace(/\s*\{\{renderer\s+:async-task-timer-controls\s*\}\}/gi, "")
    .trimEnd());
}

function addInlineTimerRendererToContent(content) {
  const withoutRenderer = removeInlineTimerRendererFromContent(content);
  return mutateFirstLine(
    withoutRenderer,
    (line) => `${line.trimEnd()} ${INLINE_TIMER_RENDERER}`,
  );
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

// Lines we manage inside a block's content. The block markdown is the single
// source of truth, so we always rebuild the timer lines from scratch (strip then
// re-add) to guarantee there is never a duplicate property line.
const TIMER_PROP_LINE_RE = /^\s*async-timer(-expires-at|-total-seconds)?::.*$/i;

// UUIDs the plugin itself just wrote. logseq.DB.onChanged fires for our own
// writes too; tracking them lets us ignore the echo and avoid a restore cascade.
const _recentWrites = new Map();

function markWritten(uuid) {
  if (uuid) _recentWrites.set(uuid, Date.now());
}

function wasRecentlyWritten(uuid) {
  const ts = _recentWrites.get(uuid);
  if (!ts) return false;
  if (Date.now() - ts > 4000) {
    _recentWrites.delete(uuid);
    return false;
  }
  return true;
}

function stripTimerPropLines(content) {
  return String(content || "")
    .split("\n")
    .filter((line) => !TIMER_PROP_LINE_RE.test(line));
}

function buildTimerContent(content, expiresAt, totalSeconds) {
  const lines = stripTimerPropLines(content);
  if (lines.length === 0) lines.push("");
  lines[0] = removeInlineTimerRendererFromContent(lines[0]);
  lines[0] = addInlineTimerRendererToContent(addClockMarkerToContent(lines[0]));
  lines.push(`${TIMER_PROP}:: ${expiresAt}~${totalSeconds}`);
  return lines.join("\n");
}

function persistTimerToBlock(timer, { markDoing = false } = {}) {
  return queueTimerPersistence(async () => {
    const block = await logseq.Editor.getBlock(timer.blockUuid);
    if (!block) return;
    const sourceContent = markDoing ? markBlockAsDoing(block.content) : block.content;
    const content = buildTimerContent(sourceContent, timer.expiresAt, timer.totalSeconds);
    timer.blockContent = content;
    markWritten(timer.blockUuid);
    await logseq.Editor.updateBlock(timer.blockUuid, content);
  });
}

// Reliably remove every timer artifact (both property lines + the ⏰ marker).
// When completing, only TODO/DOING tasks become DONE; ordinary blocks keep
// their original text. This is what makes "handled on one device → gone on
// every device" actually hold.
function clearTimerFromBlock(blockUuid, { toDone = false } = {}) {
  return queueTimerPersistence(async () => {
    const block = await logseq.Editor.getBlock(blockUuid);
    if (!block) return;
    const lines = stripTimerPropLines(block.content);
    if (lines.length === 0) lines.push("");
    lines[0] = removeInlineTimerRendererFromContent(lines[0]);
    lines[0] = removeClockMarkerFromContent(lines[0]);
    if (toDone) {
      lines[0] = lines[0].replace(/^(\s*)(TODO|DOING)\s+/i, "$1DONE ");
    }
    const content = lines.join("\n").replace(/\s+$/, "");
    markWritten(blockUuid);
    await logseq.Editor.updateBlock(blockUuid, content);
  });
}

// Returns an array of matching blocks, or null if the query itself failed
// (unsupported syntax on this Logseq build) so the caller can try another way.
async function runDatascript(query) {
  try {
    const result = await logseq.DB.datascriptQuery(query);
    return normalizeQueryBlocks(result).filter((block) => getTimerMetaFromBlock(block));
  } catch (e) {
    console.warn("runDatascript failed:", e);
    return null;
  }
}

// Detect timer blocks by their CONTENT (the source of truth) rather than the
// property index — the index can silently drop properties depending on how the
// value parses, which made timers vanish from the panel. Pushing the substring
// filter into datascript keeps this cheap (it never pulls the whole graph).
async function queryTimerBlocks() {
  const byContent = await runDatascript(`
    [:find (pull ?b [*])
     :where
     [?b :block/content ?c]
     [(clojure.string/includes? ?c "async-timer")]]`);
  if (byContent !== null) return byContent;

  // clojure.string/includes? unsupported here — fall back to the property index.
  const byProp = await runDatascript(`
    [:find (pull ?b [*])
     :where
     [?b :block/properties ?props]
     [(contains? ?props :async-timer)]]`);
  if (byProp !== null) return byProp;

  // Last resort (both predicates unsupported): scan all content blocks.
  return (await runDatascript(`[:find (pull ?b [*]) :where [?b :block/content ?c]]`)) || [];
}

async function loadTimerData() {
  const byUuid = new Map();

  for (const block of await queryTimerBlocks()) {
    const meta = getTimerMetaFromBlock(block);
    if (!meta) continue;
    byUuid.set(block.uuid, {
      blockUuid: block.uuid,
      blockContent: block.content || "",
      totalSeconds: meta.totalSeconds,
      expiresAt: meta.expiresAt,
      hasMarker: hasClockMarker(block),
      source: "block",
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
      // expiresAt/total are already on the block; no need to rewrite it here.
      saveTimers();
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

      if (
        timer.status === "expired" &&
        notifyExpired &&
        (!existing || existing.status !== "expired" || existing.expiresAt !== timer.expiresAt)
      ) {
        expiredOnRestore.push(timer);
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

    // Restore is read-only: it never writes back to blocks, so it can't trigger
    // an onChanged cascade and can't corrupt markdown. localStorage is only a
    // best-effort cache, never a source that can revive deleted timers.
    saveTimers();

    // Don't blast a modal + alarm for a pile of already-stale timers that synced
    // in from another device — that was the "flood on open" problem. Just leave a
    // gentle toast; the toolbar ⏰ panel lists them for one-tap handling.
    if (expiredOnRestore.length > 0) {
      logseq.UI.showMsg(t("restoreExpired", expiredOnRestore.length), "warning", { timeout: 8000 });
      for (const timer of expiredOnRestore) {
        await notifyBotExpired(timer);
      }
    }
  } catch (e) {
    console.warn("restoreTimers:", e);
  } finally {
    _isRestoringTimers = false;
  }
}

// One-time, idempotent migration of legacy two-property timers into the new
// single-line `async-timer::` format. New-format blocks have no legacy lines and
// are skipped, so this self-terminates after the first pass. Runs through the
// Logseq API (not raw file edits) so the in-app DB stays consistent.
async function migrateLegacyTimers() {
  try {
    let migrated = 0;
    for (const block of await queryTimerBlocks()) {
      const content = block.content || "";
      // Never touch blocks carrying git conflict markers.
      if (/^(<{7}|={7}|>{7})/m.test(content)) continue;
      const hasLegacy = /(^|\n)\s*async-timer-(expires-at|total-seconds)::/i.test(content);
      if (!hasLegacy) continue;
      const meta = getTimerMetaFromBlock(block);
      if (!meta) continue;
      markWritten(block.uuid);
      await logseq.Editor.updateBlock(
        block.uuid,
        buildTimerContent(content, meta.expiresAt, meta.totalSeconds),
      );
      migrated++;
    }
    if (migrated > 0) {
      console.log(`async-task-timer: migrated ${migrated} legacy timer(s) to single-line format`);
    }
  } catch (e) {
    console.warn("migrateLegacyTimers:", e);
  }
}

async function ensureInlineTimerRenderers() {
  for (const timer of timers.values()) {
    const block = await logseq.Editor.getBlock(timer.blockUuid);
    if (!block) continue;
    const content = buildTimerContent(block.content, timer.expiresAt, timer.totalSeconds);
    if (content === block.content) continue;
    markWritten(timer.blockUuid);
    await logseq.Editor.updateBlock(timer.blockUuid, content);
  }
}

function scheduleRestoreTimers(opts = {}) {
  clearTimeout(_syncFromGraphTimer);
  _syncFromGraphTimer = setTimeout(() => {
    restoreTimers(opts);
  }, 1200);
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
    .replace(/(?:^|\n)\s*async-timer(?:-expires-at|-total-seconds)?::[^\n]*/gi, "")
    .replace(/\s*\{\{renderer\s+:async-task-timer-controls\s*\}\}/gi, "")
    .replace(/^(TODO|DOING|DONE|LATER|NOW|WAITING)\s+/i, "")
    .replace(/⏰\s*$/, "").trim().slice(0, len) || t("noContent");
}

// A clean, single-line task title for external notifications: first line only,
// stripped of the ⏰ marker, inline renderer, task keyword and priority tag.
function botTaskTitle(content, len = 80) {
  const firstLine = String(content || "").split("\n")[0] || "";
  const cleaned = firstLine
    .replace(/\{\{renderer\s+:async-task-timer-controls\s*\}\}/gi, "")
    .replace(/^\s*(TODO|DOING|DONE|LATER|NOW|WAITING)\s+/i, "")
    .replace(/\[#[A-C]\]\s*/g, "")
    .replace(/⏰/g, "")
    .trim();
  return cleaned.slice(0, len) || t("noContent");
}

function formatClockTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return t("seconds", seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("min", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("hour", hours);
  return t("day", Math.floor(hours / 24));
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

// ─── WeCom (企业微信) bot ───

async function getBlockPageName(blockUuid) {
  try {
    const block = await logseq.Editor.getBlock(blockUuid);
    const pageId = block?.page?.id;
    if (!pageId) return null;
    const page = await logseq.Editor.getPage(pageId);
    return page?.originalName || page?.name || null;
  } catch (_) {
    return null;
  }
}

function botNotifyKey(timer) {
  return `${timer.blockUuid}~${timer.expiresAt}`;
}

function loadBotNotified() {
  try {
    const raw = localStorage.getItem(BOT_NOTIFIED_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === "object" ? data : {};
  } catch (_) {
    return {};
  }
}

function saveBotNotified(map) {
  try { localStorage.setItem(BOT_NOTIFIED_KEY, JSON.stringify(map)); } catch (_) {}
}

function wasBotNotified(timer) {
  return botNotifyKey(timer) in loadBotNotified();
}

function markBotNotified(timer) {
  const map = loadBotNotified();
  map[botNotifyKey(timer)] = Date.now();
  saveBotNotified(map);
}

// Drop every remembered notification for a block (used on complete/dismiss so a
// future timer on the same block can notify again).
function clearBotNotifiedForBlock(blockUuid) {
  const map = loadBotNotified();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key.startsWith(`${blockUuid}~`)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) saveBotNotified(map);
}

async function sendWecomBot(payload) {
  const url = (logseq.settings?.wecomWebhook || "").trim();
  if (!url) return false;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // The WeCom webhook doesn't send CORS headers; we only need the request to
      // go out (fire-and-forget), so no-cors avoids the response being blocked.
      mode: "no-cors",
    });
    return true;
  } catch (e) {
    console.warn("sendWecomBot:", e);
    return false;
  }
}

// Push an expired timer to the WeCom bot, guarding against duplicates so the same
// still-expired task isn't re-sent on every restart.
async function notifyBotExpired(timer) {
  if (!(logseq.settings?.wecomWebhook || "").trim()) return;
  if (wasBotNotified(timer)) return;

  const s = logseq.settings || {};
  const title = botTaskTitle(timer.blockContent);
  // Fresh expiry reads "just expired"; restart-resend shows how overdue it is.
  const status = getOverdueMs(timer) < 60000 ? t("justExpired") : formatOverdue(timer);

  // `!== false` keeps a field on when its setting hasn't been written yet, so the
  // defaults (all on) hold for users who upgraded without touching settings.
  const lines = [t("botHeader"), t("botLineTask", title)];
  if (s.botShowPage !== false) {
    const pageName = await getBlockPageName(timer.blockUuid);
    if (pageName) lines.push(t("botLinePage", pageName));
  }
  if (s.botShowDuration !== false) lines.push(t("botLineDuration", formatDuration(timer.totalSeconds)));
  if (s.botShowDueTime !== false) lines.push(t("botLineDueTime", formatClockTime(timer.expiresAt)));
  lines.push(t("botLineStatus", status), "", t("botFooter"));

  const sent = await sendWecomBot({
    msgtype: "markdown",
    markdown: { content: lines.join("\n") },
  });
  if (sent) markBotNotified(timer);
}

// ─── Block marker ───

async function addClockMarker(uuid) {
  try {
    const block = await logseq.Editor.getBlock(uuid);
    if (block && !hasClockMarker(block)) {
      await logseq.Editor.updateBlock(uuid, addClockMarkerToContent(block.content));
    }
  } catch (_) {}
}

async function removeClockMarker(uuid) {
  try {
    const block = await logseq.Editor.getBlock(uuid);
    if (block && hasClockMarker(block)) {
      await logseq.Editor.updateBlock(uuid, removeClockMarkerFromContent(block.content));
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
  await persistTimerToBlock(timer, { markDoing: true });
  saveTimers();
  const label = minutes < 1 ? t("seconds", totalSeconds) : formatMinutes(minutes);
  logseq.UI.showMsg(t("timerSet", label), "success", { timeout: 2000 });
}

function getExpiredTimers() {
  return [...timers.values()].filter(ti => ti.status === "expired");
}

function getOverdueMs(timer, now = Date.now()) {
  return Math.max(0, now - Number(timer.expiresAt || now));
}

function formatOverdue(timer, now = Date.now()) {
  return t("overdueFor", formatDuration(Math.floor(getOverdueMs(timer, now) / 1000)));
}

function compareByOverdueAsc(a, b, now = Date.now()) {
  const overdueDiff = getOverdueMs(a, now) - getOverdueMs(b, now);
  if (overdueDiff !== 0) return overdueDiff;
  return (a.id || 0) - (b.id || 0);
}

function compareTimersForPanel(a, b, now = Date.now()) {
  const aExpired = a.status === "expired";
  const bExpired = b.status === "expired";
  if (aExpired && bExpired) return compareByOverdueAsc(a, b, now);
  if (aExpired) return -1;
  if (bExpired) return 1;
  const expiresDiff = Number(a.expiresAt || 0) - Number(b.expiresAt || 0);
  if (expiresDiff !== 0) return expiresDiff;
  return (a.id || 0) - (b.id || 0);
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
  _lastExpiredTimerId = timer.id;

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

  notifyBotExpired(timer);

  renderExpiredList(timer.id);
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
  timers.delete(id);
  clearBotNotifiedForBlock(timer.blockUuid);
  await clearTimerFromBlock(timer.blockUuid, { toDone: true });
  saveTimers();
  logseq.UI.showMsg(t("taskDone"), "success", { timeout: 2000 });
}

async function snoozeTimer(id, minutes) {
  const timer = timers.get(id);
  if (!timer) return;
  if (timer.intervalId) clearInterval(timer.intervalId);
  clearBotNotifiedForBlock(timer.blockUuid);
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
  timers.delete(id);
  clearBotNotifiedForBlock(timer.blockUuid);
  await clearTimerFromBlock(timer.blockUuid);
  saveTimers();
}

async function dismissAllExpired() {
  const expired = getExpiredTimers();
  for (const ti of expired) {
    if (ti.intervalId) clearInterval(ti.intervalId);
    timers.delete(ti.id);
    clearBotNotifiedForBlock(ti.blockUuid);
    await clearTimerFromBlock(ti.blockUuid);
  }
  saveTimers();
  logseq.UI.showMsg(t("clearedExpired", expired.length), "success", { timeout: 2000 });
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

function renderExpiredList(highlightTimerId = null) {
  const now = Date.now();
  const expired = getExpiredTimers().sort((a, b) => compareByOverdueAsc(a, b, now));
  if (expired.length === 0) return;

  const effectiveHighlightTimerId = expired.some((timer) => timer.id === highlightTimerId)
    ? highlightTimerId
    : expired.some((timer) => timer.id === _lastExpiredTimerId)
      ? _lastExpiredTimerId
      : expired[0].id;
  const countLabel = expired.length > 1 ? t("expiredCount", expired.length) : "";
  const items = expired.map(timer => {
    const isCurrent = timer.id === effectiveHighlightTimerId;
    const taskText = escapeHtml(truncate(timer.blockContent, 60));
    const blockUuid = escapeHtml(String(timer.blockUuid));
    const overdueText = escapeHtml(formatOverdue(timer, now));
    return `
      <div class="expired-item${isCurrent ? " expired-item-current" : ""}">
        ${isCurrent ? `<div class="expired-current-badge">${t("justExpired")}</div>` : ""}
        <div class="task expired-task-link"
             data-uuid="${blockUuid}"
             title="${t("panelClickHint")}">${taskText}</div>
        <div class="expired-overdue">${overdueText}</div>
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

function renderPanelTimerAdjuster(timerId) {
  return `
    <div class="panel-snooze-area" id="panel-snooze-${timerId}" style="display:none">
      <div class="panel-snooze-presets">
        ${PRESET_MINUTES.map(m =>
          `<button class="panel-snooze-preset" data-action="snooze" data-id="${timerId}" data-minutes="${m}">${formatMinutes(m)}</button>`
        ).join("")}
      </div>
      <div class="panel-snooze-custom">
        <input type="number" class="panel-snooze-input" data-id="${timerId}" min="0.1" step="0.1" placeholder="${t("custom")}" />
        <span class="unit">${t("minutes")}</span>
        <button class="panel-snooze-go" data-id="${timerId}">${t("snoozeCustom")}</button>
      </div>
    </div>`;
}

function togglePanelSnoozeArea(id) {
  const allAreas = document.querySelectorAll(".panel-snooze-area");
  const current = document.getElementById(`panel-snooze-${id}`);
  const shouldOpen = !!current && current.style.display === "none";
  allAreas.forEach((area) => {
    area.style.display = "none";
  });
  if (current && shouldOpen) current.style.display = "block";
}

function renderTimerPanel() {
  const now = Date.now();
  const all = [...timers.values()].sort((a, b) => compareTimersForPanel(a, b, now));

  if (all.length === 0) {
    logseq.UI.showMsg(t("panelEmpty"), "info", { timeout: 2000 });
    return;
  }

  const items = all.map(ti => {
    const taskText = escapeHtml(truncate(ti.blockContent, 50));
    if (ti.status === "expired") {
      const overdueText = escapeHtml(formatOverdue(ti, now));
      return `<div class="panel-item-wrap">
        <div class="panel-item panel-item-expired">
          <span class="panel-time panel-expired">${overdueText}</span>
          <span class="panel-task panel-task-link" data-uuid="${ti.blockUuid}">${taskText}</span>
          <button class="panel-done-btn" data-action="done" data-id="${ti.id}" title="${t("markDone")}">✅</button>
          <button class="panel-snooze-toggle" data-id="${ti.id}" title="${t("snoozeWait")}">⏱</button>
          <button class="panel-dismiss-btn" data-action="dismiss" data-id="${ti.id}" title="${t("dismiss")}">✕</button>
        </div>
        ${renderPanelTimerAdjuster(ti.id)}
      </div>`;
    }
    return `<div class="panel-item-wrap">
      <div class="panel-item" data-uuid="${ti.blockUuid}">
        <span class="panel-time">${formatTime(ti.remaining)}</span>
        <span class="panel-task">${taskText}</span>
        <button class="panel-reset-toggle" data-id="${ti.id}" title="${t("resetTimer")}">⟳</button>
      </div>
      ${renderPanelTimerAdjuster(ti.id)}
    </div>`;
  }).join("");

  const expiredCount = all.filter((ti) => ti.status === "expired").length;
  const clearAllRow = expiredCount > 0
    ? `<button class="action-btn dismiss-btn" id="dismiss-all-expired">${t("clearAllExpired")}${t("expiredCount", expiredCount)}</button>`
    : "";

  document.getElementById("app").innerHTML = `
    <div class="overlay" id="overlay-bg">
      <div class="dialog panel-dialog">
        <div class="title">${t("panelTitle")}</div>
        <div class="panel-hint">${t("panelClickHint")}</div>
        <div class="panel-list">${items}</div>
        ${clearAllRow}
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

    if (e.target.id === "dismiss-all-expired") {
      await dismissAllExpired();
      if (timers.size > 0) { renderTimerPanel(); } else { logseq.hideMainUI(); }
      return;
    }

    const snoozeToggle = e.target.closest(".panel-snooze-toggle, .panel-reset-toggle");
    if (snoozeToggle) {
      const id = snoozeToggle.dataset.id;
      togglePanelSnoozeArea(id);
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

    const taskLink = e.target.closest(".panel-task-link, .expired-task-link");
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

// ─── Inline block controls ───

function inlineTimerUIKey(blockUuid) {
  return `async-task-timer-inline-${blockUuid}`;
}

function renderInlineTimerUI(blockUuid) {
  const uuid = escapeHtml(String(blockUuid));
  return `
    <span class="async-timer-inline-controls">
      <button class="async-timer-inline-btn"
              data-uuid="${uuid}"
              data-on-click="changeInlineTimer"
              title="${t("inlineChangeTime")}">⏱ ${t("inlineChangeTime")}</button>
      <button class="async-timer-inline-btn async-timer-inline-done"
              data-uuid="${uuid}"
              data-on-click="completeInlineTimer"
              title="${t("inlineComplete")}">✅ ${t("inlineComplete")}</button>
    </span>`;
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
    {
      key: "wecomWebhook",
      type: "string",
      title: "WeCom Bot Webhook / 企业微信机器人 Webhook",
      description:
        "Optional. Paste a WeCom group bot webhook URL to also push expired-task reminders there (also re-sent after restart). Leave empty to disable. 可选：填入企业微信群机器人 Webhook，到期提醒会同步推送到群里（重启后也会补发），留空则关闭。",
      default: "",
    },
    {
      key: "botShowPage",
      type: "boolean",
      title: "Push includes: page / 推送包含：所在页面",
      description: "Include the page the timer block lives on. 推送中显示计时块所在的页面。",
      default: true,
    },
    {
      key: "botShowDuration",
      type: "boolean",
      title: "Push includes: duration / 推送包含：设定时长",
      description: "Include the configured countdown duration. 推送中显示设定的倒计时时长。",
      default: true,
    },
    {
      key: "botShowDueTime",
      type: "boolean",
      title: "Push includes: due time / 推送包含：到期时间",
      description: "Include the timestamp when the timer expired. 推送中显示任务到期时间。",
      default: true,
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
    .block-properties > div:has([data-key="async-timer"]),
    .block-properties > div:has([data-key="async-timer-expires-at"]),
    .block-properties > div:has([data-key="async-timer-total-seconds"]),
    .block-properties > div:has(a[data-ref="async-timer"]),
    .block-properties > div:has(a[data-ref="async-timer-expires-at"]),
    .block-properties > div:has(a[data-ref="async-timer-total-seconds"]),
    .block-properties [data-key="async-timer"],
    .block-properties [data-key="async-timer-expires-at"],
    .block-properties [data-key="async-timer-total-seconds"],
    .block-properties a[data-ref="async-timer"],
    .block-properties a[data-ref="async-timer-expires-at"],
    .block-properties a[data-ref="async-timer-total-seconds"] {
      display: none !important;
    }
    .async-timer-inline-controls {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 6px;
      vertical-align: middle;
      opacity: .72;
      transition: opacity .15s ease;
    }
    .block-content:hover .async-timer-inline-controls,
    .async-timer-inline-controls:focus-within {
      opacity: 1;
    }
    .async-timer-inline-btn {
      border: 1px solid var(--ls-border-color);
      border-radius: 6px;
      padding: 1px 6px;
      background: var(--ls-secondary-background-color);
      color: var(--ls-primary-text-color);
      font-size: 11px;
      line-height: 1.7;
      white-space: nowrap;
      cursor: pointer;
    }
    .async-timer-inline-btn:hover {
      border-color: var(--ls-link-text-color);
      color: var(--ls-link-text-color);
    }
    .async-timer-inline-done:hover {
      border-color: #4caf50;
      color: #2e7d32;
    }
  `);

  setupEvents();

  logseq.DB.onChanged(({ blocks }) => {
    // Ignore the echo of our own writes — otherwise every persist/clear would
    // re-trigger a full restore (the old behavior behind the per-edit lag).
    const relevant = (blocks || []).filter(
      (b) => isTimerRelevantBlock(b) && !wasRecentlyWritten(b.uuid)
    );
    if (relevant.length > 0) {
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
    async changeInlineTimer({ dataset }) {
      const uuid = dataset?.uuid;
      if (!uuid) return;
      const block = await logseq.Editor.getBlock(uuid);
      if (block && getTimerByBlockUuid(uuid)) {
        openPickerDialog(uuid, block.content);
      }
    },
    async completeInlineTimer({ dataset }) {
      const uuid = dataset?.uuid;
      if (!uuid) return;
      const timer = getTimerByBlockUuid(uuid);
      if (timer) await completeTimer(timer.id);
    },
    toggleTimerPanel() {
      if (timers.size === 0) {
        logseq.UI.showMsg(t("panelEmpty"), "info", { timeout: 2000 });
        return;
      }
      renderTimerPanel();
      logseq.showMainUI({ autoFocus: true });
    },
  });

  logseq.App.onMacroRendererSlotted(({ slot, payload }) => {
    const [type] = payload?.arguments || [];
    if (String(type || "").trim().toLowerCase() !== INLINE_TIMER_RENDERER_TYPE) return;
    const blockUuid = payload?.uuid;
    if (!blockUuid) return;
    logseq.provideUI({
      key: inlineTimerUIKey(blockUuid),
      slot,
      reset: true,
      template: renderInlineTimerUI(blockUuid),
    });
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
  await migrateLegacyTimers();
  await ensureInlineTimerRenderers();
}

logseq.ready(main).catch(console.error);
