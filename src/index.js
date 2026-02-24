import "@logseq/libs";

const PRESET_MINUTES = [3, 5, 10, 15, 30];

let timers = new Map();
let timerIdCounter = 0;
let _pendingBlock = null;

// ─── Utilities ───

function truncate(str, len = 40) {
  if (!str) return "(无内容)";
  return str.replace(/^(TODO|DOING|DONE|LATER|NOW|WAITING)\s+/i, "")
    .replace(/⏰\s*$/, "").trim().slice(0, len) || "(无内容)";
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
    if (block && !block.content.includes("⏰")) {
      await logseq.Editor.updateBlock(uuid, block.content.trimEnd() + " ⏰");
    }
  } catch (_) {}
}

async function removeClockMarker(uuid) {
  try {
    const block = await logseq.Editor.getBlock(uuid);
    if (block && block.content.includes("⏰")) {
      await logseq.Editor.updateBlock(uuid, block.content.replace(/\s*⏰/g, "").trimEnd());
    }
  } catch (_) {}
}

// ─── Timer ───

function createTimer(blockUuid, blockContent, minutes) {
  const id = ++timerIdCounter;
  const totalSeconds = Math.max(1, Math.round(minutes * 60));
  const timer = {
    id, blockUuid, blockContent,
    totalSeconds,
    remaining: totalSeconds,
    status: "running", intervalId: null,
  };

  timer.intervalId = setInterval(() => {
    timer.remaining--;
    if (timer.remaining <= 0) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
      timer.status = "expired";
      onTimerExpired(timer);
    }
  }, 1000);

  timers.set(id, timer);
  addClockMarker(blockUuid);
  const label = minutes >= 1 ? `${minutes} 分钟` : `${totalSeconds} 秒`;
  logseq.UI.showMsg(`⏱️ 已设置 ${label} 后提醒`, "success", { timeout: 2000 });
}

function onTimerExpired(timer) {
  const label = truncate(timer.blockContent, 40);

  playAlertSound();

  // Logseq in-app notification (always works)
  logseq.UI.showMsg(
    `⏰ 异步任务到期！\n\n「${label}」\n\n倒计时已结束，请检查任务进度！`,
    "warning",
    { timeout: 30000 }
  );

  // System desktop notification
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification("⏰ 异步任务到期", {
        body: `「${label}」倒计时已结束，请检查任务进度！`,
        requireInteraction: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch (_) {}

  // Show expired dialog in plugin UI
  renderExpiredDialog(timer);
  logseq.showMainUI({ autoFocus: true });
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
  logseq.UI.showMsg("✅ 任务已标记完成!", "success", { timeout: 2000 });
}

function snoozeTimer(id, minutes) {
  const timer = timers.get(id);
  if (!timer) return;
  if (timer.intervalId) clearInterval(timer.intervalId);
  timer.remaining = minutes * 60;
  timer.totalSeconds = minutes * 60;
  timer.status = "running";
  timer.intervalId = setInterval(() => {
    timer.remaining--;
    if (timer.remaining <= 0) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
      timer.status = "expired";
      onTimerExpired(timer);
    }
  }, 1000);
  logseq.UI.showMsg(`⏱️ 再等 ${minutes} 分钟`, "success", { timeout: 2000 });
}

async function dismissTimer(id) {
  const timer = timers.get(id);
  if (!timer) return;
  if (timer.intervalId) clearInterval(timer.intervalId);
  await removeClockMarker(timer.blockUuid);
  timers.delete(id);
}

// ─── Render ───

function renderPickerDialog() {
  if (!_pendingBlock) return;
  const taskText = escapeHtml(truncate(_pendingBlock.content, 60));
  document.getElementById("app").innerHTML = `
    <div class="overlay" id="overlay-bg">
      <div class="dialog">
        <div class="title">⏱️ 设置异步任务提醒</div>
        <div class="task">${taskText}</div>
        <div class="presets">
          ${PRESET_MINUTES.map(m =>
            `<button class="preset-btn" data-minutes="${m}">${m}<span>分钟</span></button>`
          ).join("")}
        </div>
        <div class="custom-row">
          <input type="number" id="custom-input" min="0.1" step="0.1" placeholder="自定义" />
          <span class="unit">分钟</span>
          <button id="custom-start-btn">开始</button>
        </div>
        <button class="cancel-btn" id="cancel-btn">取消</button>
      </div>
    </div>`;

  // Auto focus the custom input
  setTimeout(() => {
    const input = document.getElementById("custom-input");
    if (input) input.focus();
  }, 100);
}

function renderExpiredDialog(timer) {
  const taskText = escapeHtml(truncate(timer.blockContent, 60));
  document.getElementById("app").innerHTML = `
    <div class="overlay" id="overlay-bg">
      <div class="dialog expired-dialog">
        <div class="title">⏰ 异步任务到期</div>
        <div class="task">${taskText}</div>
        <div class="expired-hint">倒计时已结束，请检查该任务是否已完成</div>
        <div class="expired-actions">
          <button class="action-btn done-btn" data-action="done" data-id="${timer.id}">✅ 已完成，标记 DONE</button>
          <div class="snooze-row">
            ${PRESET_MINUTES.map(m =>
              `<button class="action-btn snooze-btn" data-action="snooze" data-id="${timer.id}" data-minutes="${m}">再等${m}分钟</button>`
            ).join("")}
          </div>
          <button class="action-btn dismiss-btn" data-action="dismiss" data-id="${timer.id}">暂时忽略</button>
        </div>
      </div>
    </div>`;
}

// ─── Events ───

function startCustomTimer() {
  const input = document.getElementById("custom-input");
  if (!input || !_pendingBlock) return;
  const val = parseFloat(input.value);
  if (!val || val <= 0) {
    input.style.borderColor = "#ef5350";
    input.focus();
    return;
  }
  createTimer(_pendingBlock.uuid, _pendingBlock.content, val);
  _pendingBlock = null;
  logseq.hideMainUI();
}

function setupEvents() {
  document.addEventListener("click", async (e) => {
    // Preset button in picker dialog
    const presetBtn = e.target.closest(".preset-btn");
    if (presetBtn && _pendingBlock) {
      createTimer(_pendingBlock.uuid, _pendingBlock.content, parseFloat(presetBtn.dataset.minutes));
      _pendingBlock = null;
      logseq.hideMainUI();
      return;
    }

    // Custom start button
    if (e.target.id === "custom-start-btn") {
      startCustomTimer();
      return;
    }

    // Action buttons in expired dialog
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      const { action, id, minutes } = actionBtn.dataset;
      if (action === "done") await completeTimer(parseInt(id));
      else if (action === "snooze") snoozeTimer(parseInt(id), parseFloat(minutes));
      else if (action === "dismiss") await dismissTimer(parseInt(id));
      logseq.hideMainUI();
      return;
    }

    // Cancel button
    if (e.target.id === "cancel-btn") {
      _pendingBlock = null;
      logseq.hideMainUI();
      return;
    }

    // Click overlay background to close
    if (e.target.id === "overlay-bg") {
      _pendingBlock = null;
      logseq.hideMainUI();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      _pendingBlock = null;
      logseq.hideMainUI();
    }
    // Enter in custom input starts timer
    if (e.key === "Enter" && e.target.id === "custom-input") {
      startCustomTimer();
    }
  });
}

function openPickerDialog(uuid, content) {
  _pendingBlock = { uuid, content };
  renderPickerDialog();
  logseq.showMainUI({ autoFocus: true });
}

// ─── Main ───

function main() {
  logseq.setMainUIInlineStyle({
    position: "fixed", zIndex: "999",
    top: "0", left: "0", width: "100vw", height: "100vh",
  });

  setupEvents();

  logseq.Editor.registerSlashCommand("异步任务计时", async () => {
    const block = await logseq.Editor.getCurrentBlock();
    if (block) openPickerDialog(block.uuid, block.content);
  });
  logseq.Editor.registerSlashCommand("Async Timer", async () => {
    const block = await logseq.Editor.getCurrentBlock();
    if (block) openPickerDialog(block.uuid, block.content);
  });

  logseq.Editor.registerBlockContextMenuItem("⏱️ 设置异步提醒", async ({ uuid }) => {
    const block = await logseq.Editor.getBlock(uuid);
    if (block) openPickerDialog(block.uuid, block.content);
  });

  logseq.provideModel({
    toggleTimerPanel() {
      if (timers.size === 0) {
        logseq.UI.showMsg("暂无进行中的计时任务", "info", { timeout: 2000 });
        return;
      }
      let msg = "⏱️ 当前计时任务：\n";
      for (const [, t] of timers) {
        const label = truncate(t.blockContent, 25);
        msg += `\n• ${label} — ${t.status === "expired" ? "⏰ 已到期!" : formatTime(t.remaining)}`;
      }
      logseq.UI.showMsg(msg, "info", { timeout: 5000 });
    },
  });

  logseq.App.registerUIItem("toolbar", {
    key: "timer-toolbar-btn",
    template: `<a class="button" data-on-click="toggleTimerPanel" title="异步任务计时器">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/>
        <path d="M5 3L2 6"/><path d="M22 6l-3-3"/><path d="M12 2v2"/>
      </svg></a>`,
  });

  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

logseq.ready(main).catch(console.error);
