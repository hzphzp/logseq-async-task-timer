import '../vendor/logseq-sdk/lsplugin.user.js';
import './style.css';
import deadlineWorkerUrl from './deadline-worker.js?worker&url';
import { DbTimerStore, assertSupported, cleanTimerTitle, INLINE_TIMER_RENDERER_TYPE, recordToken } from './db-store.js';
import { ReminderController } from './controller.js';
import { NotificationQueue, sendWecom } from './notifications.js';
import { TimerView, escapeHtml } from './ui.js';
import { nextMorning, secondsFromMinutes } from './reminder.js';
import { isDatabaseUnavailable, waitForDatabase } from './readiness.js';

let notifier = null, view = null, ready = false, disposed = false, switching = 0;
let debounce = null, tick = null, poll = null, settingsVersion = 0;
let deadlineWorker = null, armedDeadline = null, audioContext = null;
let activating = false, startupRetry = null;
let initialized = false, reconnectAttempts = 0, lastAutoRefresh = 0;
let saveOutcomePending = false;
let pickerSequence = 0;
const inlineActions = new Map(), inlineSlots = new Map();
// Host macro slots are ephemeral. Keep recent occurrences and re-register the
// clicked one even if its slot was evicted while browsing a long graph.
const MAX_INLINE_SLOTS = 128;
const offHooks = [];
const memory = new Map();
let storage;
try { storage = localStorage; storage.getItem('async-timer-check'); }
catch (_) { storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) }; }
const DEVICE_KEY = 'logseq-async-task-timer-device-id';
let deviceId;
try { deviceId = storage.getItem(DEVICE_KEY) || crypto.randomUUID(); storage.setItem(DEVICE_KEY, deviceId); }
catch (_) { deviceId = crypto.randomUUID(); }
const tr = (zh, en) => view?.lang === 'zh' ? zh : en;
const report = error => {
  if (disposed) return;
  const text = error?.message || String(error);
  if (text.startsWith('Graph changed;')) return;
  if (isDatabaseUnavailable(error)) {
    ready = false;
    controller.connectionLost = true;
    clearTimeout(debounce); debounce = null;
    view?.setBanner(tr('Logseq 数据库连接暂时不可用，正在自动重连；列表保留上次读取结果。', 'The Logseq database connection is temporarily unavailable. Reconnecting; the last loaded list is retained.'));
    if (error.writeOutcomeUnknown) { saveOutcomePending = true; view?.setNotice(text, true); }
    if (startupRetry === null) {
      const delay = [1500, 3000, 10000, 30000][Math.min(reconnectAttempts++, 3)];
      const sequence = switching;
      startupRetry = setTimeout(() => {
        startupRetry = null;
        if (!disposed && sequence === switching) return reconnect();
      }, delay);
    }
    return;
  }
  view?.setNotice(text, true);
  logseq.UI.showMsg(`Async Task Timer: ${text}`, 'error', { timeout: 7000 });
};

const controller = new ReminderController({
  onChange: () => {
    armDeadline();
    view?.update();
    for (const [slot, entry] of inlineSlots) paintSlot(slot, entry);
  },
  onBacklog: records => {
    const text = tr(`有 ${records.length} 项提醒在加载或休眠期间到期，已汇总到面板；没有补发企业微信。`,
      `${records.length} reminders were missed while away. Review them in the panel; no backlog was pushed.`);
    view?.setBanner(text); logseq.UI.showMsg(text, 'info', { timeout: 6500 });
  },
  onDue: record => {
    const title = cleanTimerTitle(record.blockContent).split('\n')[0].slice(0, 120);
    notifier?.enqueue(record);
    const soundEnabled = logseq.settings?.soundEnabled !== false;
    const played = soundEnabled && playTone();
    logseq.UI.showMsg(tr(`该跟进了：${title}`, `Time to follow up: ${title}`), 'warning', { timeout: 7000 });
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const notification = new Notification(tr('异步任务到期', 'Follow-up due'), { body: title, tag: record.blockUuid, silent: !soundEnabled || played });
        notification.onclick = () => { view.showPanel(); logseq.showMainUI({ autoFocus: true }); };
      }
    } catch (_) { /* The in-app notification remains available. */ }
  },
});

function unlockAudio() {
  if (logseq.settings?.soundEnabled === false) return;
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state !== 'running') audioContext.resume().catch(() => {});
  } catch (_) { /* The system notification can supply the sound. */ }
}

function playTone() {
  if (audioContext?.state !== 'running') return false;
  try {
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    oscillator.connect(gain); gain.connect(audioContext.destination); gain.gain.value = 0.12;
    oscillator.frequency.value = 660; oscillator.start(); oscillator.stop(audioContext.currentTime + 0.15);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    return true;
  } catch (_) { return false; }
}

function armDeadline() {
  if (!deadlineWorker) return;
  const next = ready ? controller.nextDeadline() : null;
  if (next === armedDeadline) return;
  armedDeadline = next;
  deadlineWorker.postMessage(next);
}

function pushEnabled() {
  return !!String(logseq.settings?.wecomWebhook || '').trim() &&
    (!logseq.settings?.botThisDeviceOnly || String(logseq.settings.botHostDeviceId || '').trim() === deviceId);
}
function botText(record) {
  const text = value => String(value || '').replace(/[\r\n<>]/g, ' ').slice(0, 180);
  const lines = [tr('## ⏰ 异步任务跟进提醒', '## ⏰ Async follow-up'),
    `> ${text(cleanTimerTitle(record.blockContent).split('\n')[0])}`];
  if (logseq.settings?.botShowPage !== false && record.pageName) lines.push(tr('页面：', 'Page: ') + text(record.pageName));
  if (record.project) lines.push(tr('项目：', 'Project: ') + text(record.project));
  if (record.owner) lines.push(tr('负责人：', 'Owner: ') + text(record.owner));
  if (logseq.settings?.botShowDuration !== false) lines.push(tr('设定时长：', 'Duration: ') + view.duration(record.totalSeconds));
  if (logseq.settings?.botShowDueTime !== false) lines.push(tr('跟进时间：', 'Follow-up: ') + new Date(record.expiresAt).toLocaleString());
  lines.push(tr('请检查进展；任务状态保持不变。', 'Please check progress; task status is unchanged.'));
  return lines.join('\n');
}

async function reconnect() {
  if (disposed) return;
  if (!initialized) return activate();
  const sequence = switching;
  const assertCurrent = () => {
    if (disposed || sequence !== switching) throw new Error('Graph changed; reconnect canceled.');
  };
  activating = true;
  try {
    const graph = await logseq.App.getCurrentGraph();
    assertCurrent();
    if (!graph || graph.url !== controller.graph) return activate();
    // A failed probe returns to the backoff loop, rather than queuing reads.
    await waitForDatabase(logseq, { attempts: 1, assertCurrent });
    assertCurrent();
    await controller.refresh();
    assertCurrent();
    ready = true; armDeadline(); reconnectAttempts = 0;
    view.setBanner(tr('连接已恢复，列表已重新核对。', 'Connection restored; the list has been refreshed.'));
    if (saveOutcomePending) {
      saveOutcomePending = false;
      view.setNotice(tr('已重新读取保存结果，请核对任务当前状态。', 'The saved result has been re-read. Check the current task state.'));
    }
  } catch (error) { if (sequence === switching) report(error); }
  finally { if (sequence === switching) activating = false; }
}

async function activate() {
  const sequence = ++switching;
  activating = true; initialized = false; saveOutcomePending = false; clearTimeout(startupRetry); startupRetry = null;
  ready = false; notifier?.dispose(); notifier = null; controller.dispose();
  pickerSequence++; inlineActions.clear(); inlineSlots.clear(); view.resetInteraction();
  clearTimeout(debounce); debounce = null; view.mode = null; view.panel = null; view.rows.clear(); view.selected.clear();
  view.banner = ''; view.notice = ''; logseq.hideMainUI();
  try {
    const graph = await logseq.App.getCurrentGraph();
    if (!graph || disposed || sequence !== switching) return;
    const [info, db] = await Promise.all([logseq.App.getInfo(), logseq.App.checkCurrentIsDbGraph()]);
    if (disposed || sequence !== switching) return;
    assertSupported(info, db);
    await waitForDatabase(logseq, { assertCurrent: () => {
      if (disposed || sequence !== switching) throw new Error('Graph changed; initialization canceled.');
    }, onWaiting: () => {
      view.setBanner(tr('正在等待 Logseq 数据库就绪…', 'Waiting for the Logseq database…'));
    } });
    view.banner = '';
    const store = new DbTimerStore(logseq);
    notifier = new NotificationQueue({ storage, graph: graph.url,
      current: uuid => store.get(uuid), enabled: pushEnabled, onChange: () => view?.update(),
      send: (record, signal) => sendWecom(logseq, String(logseq.settings.wecomWebhook || '').trim(), botText(record), signal),
    });
    await controller.activate(graph.url, store);
    if (sequence !== switching || disposed) return;
    ready = true; initialized = true; armDeadline(); reconnectAttempts = 0;
    if (controller.migrated) logseq.UI.showMsg(tr(`已升级 ${controller.migrated} 条提醒，原始计时值已保留。`,
      `Upgraded ${controller.migrated} reminders; original values retained.`), 'success');
    if (notifier.storageError) view.setBanner(tr('本机推送记录无法保存，重启后的去重可能失效。', 'Local delivery receipts could not be saved; deduplication across restarts may be unavailable.'));
  } catch (error) { if (sequence === switching) report(error); }
  finally { if (sequence === switching) activating = false; }
}

async function navigate(uuid) {
  const sequence = ++pickerSequence, epoch = controller.epoch;
  const current = () => !disposed && sequence === pickerSequence && epoch === controller.epoch;
  const block = await logseq.Editor.getBlock(uuid);
  if (!current()) return;
  if (!block) throw new Error(tr('任务已被删除。', 'The task was deleted.'));
  // DB graphs route directly to a node UUID. The SDK's legacy page-scroll
  // helper uses block-content-* anchors, while 2.0.2 uses ls-block-*.
  await logseq.App.pushState('page', { name: uuid });
  if (!current()) return;
  view.mode = null; logseq.hideMainUI();
}

async function run(action, uuid, options = {}) {
  if (action === 'close') { pickerSequence++; view.mode = null; logseq.hideMainUI(); return; }
  if (!ready) throw new Error(tr('图谱正在加载或升级，请稍后重试。', 'Graph is loading or upgrading; try again shortly.'));
  if (action === 'navigate') return navigate(uuid);
  if (action === 'permission') {
    if (!('Notification' in window)) throw new Error(tr('当前环境不支持系统通知；应用内提示仍可使用。', 'System notifications are unavailable; in-app reminders still work.'));
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    view.setNotice(permission === 'granted' ? tr('系统通知已获授权。', 'System notifications are enabled.') :
      tr('系统通知未获授权，请在系统或 Logseq 的通知设置中开启。', 'Enable notifications in your system or Logseq settings.'), permission !== 'granted');
    return;
  }
  if (action === 'test') {
    if (!pushEnabled()) throw new Error(tr('请先配置 Webhook，并将本机设为允许推送的设备。', 'Configure a Webhook and allow this device to push first.'));
    const abort = new AbortController(); let timeout;
    try {
      await Promise.race([sendWecom(logseq, String(logseq.settings.wecomWebhook || '').trim(),
        tr('## Async Task Timer 测试通知\n连接成功，可以接收任务跟进提醒。', '## Async Task Timer test\nConnection successful. This bot can receive follow-up reminders.'), abort.signal),
      new Promise((_, reject) => { timeout = setTimeout(() => { abort.abort(); reject(new Error(tr('测试超时，请检查网络。', 'Test timed out; check the network.'))); }, 10000); })]);
      view.setNotice(tr('企业微信已确认接收测试通知。', 'WeCom confirmed receipt of the test notification.'));
    } finally { clearTimeout(timeout); }
    return;
  }
  if (action === 'retry') {
    if (!pushEnabled()) throw new Error(tr('当前设备未启用企业微信推送。', 'WeCom is not enabled on this device.'));
    const record = await controller.store.get(uuid);
    if (!notifier.enqueue(record, { manual: true })) throw new Error(tr('提醒已改变或正在推送，请刷新后检查。', 'The reminder changed or is already queued.'));
    return;
  }
  if (action === 'bulk') {
    const epoch = controller.epoch, sequence = pickerSequence;
    const expiresAt = ['tomorrow', 'weekday'].includes(options.preset) ? nextMorning(options.preset) : Date.now() + secondsFromMinutes(Number(options.preset)) * 1000;
    const selected = options.ids.map(id => [id, recordToken(controller.records.get(id))]);
    let succeeded = 0, failed = 0;
    for (const [id, expected] of selected) {
      controller.assert(epoch);
      try { await controller.act(id, 'schedule', { expiresAt, expected }); succeeded++; view.selected.delete(id); }
      catch (error) {
        controller.assert(epoch); failed++;
        if (isDatabaseUnavailable(error)) { report(error); throw error; }
      }
    }
    if (sequence !== pickerSequence) return;
    view.setNotice(tr(`已延后 ${succeeded} 项${failed ? `；${failed} 项失败，保留选中，请刷新后重试` : ''}。`,
      `${succeeded} snoozed${failed ? `; ${failed} failed and remain selected. Refresh and retry` : ''}.`), failed > 0);
    return;
  }
  const sequence = pickerSequence, epoch = controller.epoch;
  try { await controller.act(uuid, action, options); }
  catch (error) {
    if (error.code === 'REMINDER_CONFLICT' && epoch === controller.epoch) {
      // A write based on the displayed record was rejected, not applied. Fetch
      // the current one for an explicit retry; never replay the submitted edit.
      try {
        const latest = await controller.read(uuid);
        if (sequence === pickerSequence && view.mode === 'picker' && view.pickerUuid === uuid) {
          view.setPickerRecord(uuid, latest);
        }
      } catch (readError) { if (isDatabaseUnavailable(readError)) report(readError); throw readError; }
    }
    if (isDatabaseUnavailable(error)) report(error);
    throw error;
  }
  if (sequence !== pickerSequence) return;
  view.setNotice(tr('已保存。可在操作历史中查看记录，或撤销上一步。', 'Saved. Review history or undo the last action.'));
}

async function openPicker(uuid, title) {
  if (!ready) throw new Error(tr('图谱正在加载或升级，请稍后重试。', 'Graph is loading or upgrading.'));
  const sequence = ++pickerSequence, epoch = controller.epoch;
  const cached = controller.records.get(uuid) || null;
  logseq.showMainUI({ autoFocus: true });
  view.showPicker(uuid, title || cached?.blockContent || tr('正在读取任务…', 'Loading task…'), cached);
  // The form's expected token describes exactly what the user saw. A cached
  // reminder is safe to edit now: commit compares it to the live graph first.
  if (cached) return;
  view.setPickerLoading(uuid);
  const current = () => !disposed && sequence === pickerSequence && epoch === controller.epoch && view.mode === 'picker' && view.pickerUuid === uuid;
  try {
    const target = await controller.read(uuid, { withBlock: true });
    if (!current()) return;
    if (!target.exists) throw new Error(tr('任务已被删除。', 'The task was deleted.'));
    view.setPickerRecord(uuid, target.record, title || target.title);
  } catch (error) {
    if (!current()) return;
    view.setPickerError(uuid, error.message || String(error));
    throw error;
  }
}

function rememberSlot(uuid, slot) {
  const previous = inlineSlots.get(slot);
  const entry = previous?.uuid === uuid ? previous : { uuid };
  inlineSlots.delete(slot); inlineSlots.set(slot, entry);
  if (inlineSlots.size > MAX_INLINE_SLOTS) inlineSlots.delete(inlineSlots.keys().next().value);
  return entry;
}

function paintSlot(slot, entry, force = false) {
  const { uuid } = entry;
  const busy = inlineActions.has(uuid), id = escapeHtml(uuid);
  const done = controller.records.get(uuid)?.taskStatus === 'logseq.property/status.done';
  const state = view.lang + (busy ? ':saving' : done ? ':done' : ':ready');
  if (!force && entry.display === state) return;
  entry.display = state;
  // Logseq's provider keys are global, including when one block is rendered
  // in both the journal and a linked reference. Each slot needs its own key.
  const data = `data-uuid="${id}" data-slot="${escapeHtml(slot)}"`;
  logseq.provideUI({ key: `async-task-timer-inline-${uuid}-${slot}`, slot, reset: true,
    template: `<span aria-busy="${busy}"><button class="async-timer-inline-btn" ${data} data-on-click="changeInlineTimer" ${busy ? 'disabled' : ''}>⏱ ${tr('跟进', 'Follow up')}</button><button class="async-timer-inline-btn" ${data} data-on-click="completeInlineTimer" ${busy || done ? 'disabled' : ''}>${busy ? tr('保存中…', 'Saving…') : '✓ ' + (done ? tr('已完成', 'Completed') : tr('完成', 'Complete'))}</button></span>` });
}

function renderInline(uuid) {
  for (const [slot, entry] of inlineSlots) if (entry.uuid === uuid) paintSlot(slot, entry);
}

function completeInline(uuid, slot) {
  if (!ready) return;
  if (slot) rememberSlot(uuid, slot);
  if (inlineActions.has(uuid)) { renderInline(uuid); return inlineActions.get(uuid); }
  if (controller.records.get(uuid)?.taskStatus === 'logseq.property/status.done') { renderInline(uuid); return; }
  const epoch = controller.epoch;
  const expected = recordToken(controller.records.get(uuid));
  // The store checks this token against the database before writing.
  const promise = Promise.resolve().then(async () => {
    controller.assert(epoch);
    await run('complete', uuid, { expected });
  }).finally(() => {
    if (epoch === controller.epoch && inlineActions.get(uuid) === promise) {
      inlineActions.delete(uuid); renderInline(uuid);
    }
  });
  inlineActions.set(uuid, promise); renderInline(uuid);
  return promise;
}

const SETTINGS = [
  { key: 'language', type: 'enum', title: 'Language / 界面语言', default: 'auto', enumChoices: ['auto', 'en', 'zh'], enumPicker: 'select', description: 'UI language / 插件界面语言' },
  { key: 'wecomWebhook', type: 'string', title: 'WeCom Bot Webhook / 企业微信机器人 Webhook', default: '', description: 'Optional HTTPS URL. Only live reminders push; startup backlog is summarized locally. / 可选，启动时只汇总过期任务。' },
  ...[['botShowPage', 'Page / 页面'], ['botShowDuration', 'Duration / 时长'], ['botShowDueTime', 'Due time / 到期时间']].map(([key, label]) => ({ key, type: 'boolean', title: 'Push includes / 推送包含：' + label, default: true, description: 'Show in bot message / 在机器人消息中显示' })),
  { key: 'botThisDeviceOnly', type: 'boolean', title: 'Single push device / 仅允许一台设备推送', default: false, description: 'Settings are local. Copy the same host device ID to every device using this webhook. / 设置不随图谱同步，请在各设备填同一个推送主机 ID。' },
  { key: 'botHostDeviceId', type: 'string', title: 'Push host device ID / 推送主机设备 ID', default: '', description: 'When enabled and blank, this device claims the role. / 开启上项且留空时，由当前设备认领。' },
  { key: 'soundEnabled', type: 'boolean', title: 'Reminder sound / 提醒声音', default: true, description: 'Play a short tone when a running reminder expires. / 运行中的提醒到期时播放短提示音。' },
];
async function settingsChanged() {
  const version = ++settingsVersion;
  let lang = logseq.settings?.language;
  if (!['zh', 'en'].includes(lang)) {
    try { lang = (await logseq.App.getUserConfigs())?.preferredLanguage?.startsWith('zh') ? 'zh' : 'en'; }
    catch (_) { lang = 'en'; }
  }
  if (version !== settingsVersion || disposed) return;
  if (view && view.lang !== lang) { view.lang = lang; view.panel = null; view.rows.clear(); if (view.mode === 'panel') view.showPanel(); }
  if (logseq.settings?.botThisDeviceOnly && !String(logseq.settings.botHostDeviceId || '').trim()) {
    await logseq.updateSettings({ botHostDeviceId: deviceId });
  }
}

async function main() {
  logseq.useSettingsSchema(SETTINGS);
  view = new TimerView(document.getElementById('app'), { records: () => controller.records, receipt: r => notifier?.receipt(r), run });
  await settingsChanged();
  offHooks.push(logseq.onSettingsChanged(settingsChanged));
  logseq.setMainUIInlineStyle({ position: 'fixed', zIndex: '999', top: '0', left: '0', width: '100vw', height: '100vh' });
  logseq.provideStyle('.async-timer-inline-btn{border:1px solid var(--ls-border-color);border-radius:5px;padding:1px 5px;margin-left:4px;font-size:11px;color:var(--ls-primary-text-color);background:var(--ls-secondary-background-color);cursor:pointer}');
  const safe = fn => async (...args) => { try { await fn(...args); } catch (error) { report(error); } };
  offHooks.push(logseq.DB.onChanged(() => {
    if (!ready) return;
    // Bulk imports and sync transactions must not trigger a scan per edit.
    // Timely deadlines still refresh through controller.tick independently.
    if (debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      if (!ready || disposed) return;
      lastAutoRefresh = Date.now();
      return controller.refresh().catch(report);
    }, Math.max(800, 5000 - (Date.now() - lastAutoRefresh)));
  }));
  offHooks.push(logseq.App.onCurrentGraphChanged(activate));
  offHooks.push(logseq.App.onGraphAfterIndexed(() => { if (!ready && !activating && startupRetry === null) activate(); }));
  for (const name of ['Async Timer', '异步任务计时']) logseq.Editor.registerSlashCommand(name, safe(async (event = {}) => {
    // 2.0.2 includes the originating UUID in the slash-command event.
    if (event.uuid) return openPicker(event.uuid);
    const sequence = pickerSequence, epoch = controller.epoch;
    const block = await logseq.Editor.getCurrentBlock();
    if (block && sequence === pickerSequence && epoch === controller.epoch) await openPicker(block.uuid, block.title);
  }));
  logseq.Editor.registerBlockContextMenuItem(tr('设置异步提醒', 'Set async reminder'), safe(async ({ uuid }) => {
    await openPicker(uuid);
  }));
  logseq.provideModel({
    toggleTimerPanel: safe(async () => {
      if (!ready && initialized) {
        logseq.showMainUI({ autoFocus: true }); view.showPanel();
        return;
      }
      if (activating) {
        logseq.UI.showMsg(tr('图谱正在加载或升级，完成后即可打开面板。', 'Graph is loading or upgrading; the panel will be available shortly.'), 'info');
        return;
      }
      if (!ready) { await activate(); if (!ready) return; }
      pickerSequence++; logseq.showMainUI({ autoFocus: true }); view.showPanel();
      await controller.refresh({ maxAge: debounce === null ? 5000 : 0 });
    }),
    changeInlineTimer: safe(async ({ dataset }) => {
      await openPicker(dataset.uuid);
    }),
    completeInlineTimer: safe(async ({ dataset }) => {
      await completeInline(dataset.uuid, dataset.slot);
    }),
  });
  offHooks.push(logseq.App.onMacroRendererSlotted(({ slot, payload }) => {
    if (String(payload?.arguments?.[0] || '').trim().toLowerCase() !== INLINE_TIMER_RENDERER_TYPE || !payload.uuid) return;
    if (slot) paintSlot(slot, rememberSlot(payload.uuid, slot), true);
  }));
  logseq.App.registerUIItem('toolbar', { key: 'timer-toolbar-btn', template: `<button type="button" class="button" data-on-click="toggleTimerPanel" title="Async Task Timer" aria-label="Async Task Timer"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M5 3L2 6M22 6l-3-3M12 2v2"/></svg></button>` });
  document.addEventListener?.('pointerdown', unlockAudio, true);
  document.addEventListener?.('keydown', unlockAudio, true);
  if (typeof Worker !== 'undefined') {
    try {
      deadlineWorker = new Worker(deadlineWorkerUrl);
      deadlineWorker.onmessage = async ({ data }) => {
        if (!ready || disposed || data !== armedDeadline) return;
        try {
          await controller.tick();
          await notifier?.process();
        } catch (error) { report(error); }
      };
    } catch (_) { /* The regular tick also reconciles deadlines. */ }
  }
  tick = setInterval(() => { if (ready) { view.tick(); controller.tick().catch(report); notifier?.process().catch(report); } }, 1000);
  poll = setInterval(() => { if (ready) controller.refresh().catch(report); }, 30000);
  logseq.beforeunload(async () => {
    deadlineWorker?.terminate(); deadlineWorker = null;
    document.removeEventListener?.('pointerdown', unlockAudio, true);
    document.removeEventListener?.('keydown', unlockAudio, true);
    audioContext?.close().catch(() => {});
    disposed = true; ready = false; switching++; controller.dispose(); notifier?.dispose();
    clearTimeout(debounce); clearTimeout(startupRetry); clearInterval(tick); clearInterval(poll);
    for (const off of offHooks) if (typeof off === 'function') off();
    await controller.writes.catch(() => {});
  });
  await activate();
}
logseq.ready(main).catch(report);
