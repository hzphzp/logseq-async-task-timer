import '../vendor/logseq-sdk/lsplugin.user.js';
import './style.css';
import { DbTimerStore, assertSupported, cleanTimerTitle, INLINE_TIMER_RENDERER_TYPE, recordToken } from './db-store.js';
import { ReminderController } from './controller.js';
import { NotificationQueue, sendWecom } from './notifications.js';
import { TimerView, escapeHtml } from './ui.js';
import { nextMorning, secondsFromMinutes } from './reminder.js';
import { isDatabaseStarting, waitForDatabase } from './readiness.js';

let notifier = null, view = null, ready = false, disposed = false, switching = 0;
let debounce = null, tick = null, poll = null, settingsVersion = 0;
let activating = false, startupRetry = null;
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
  if (isDatabaseStarting(error) || error?.databaseStarting) {
    ready = false;
    view?.setBanner(tr('数据库正在启动，插件会自动重新连接；已有提醒记录保留。', 'Database is starting. The plugin will reconnect automatically; saved reminders are retained.'));
    clearTimeout(startupRetry);
    startupRetry = setTimeout(() => activate(), 1500);
    return;
  }
  view?.setNotice(text, true);
  logseq.UI.showMsg(`Async Task Timer: ${text}`, 'error', { timeout: 7000 });
};

const controller = new ReminderController({
  onChange: () => view?.update(),
  onBacklog: records => {
    const text = tr(`有 ${records.length} 项提醒在加载或休眠期间到期，已汇总到面板；没有补发企业微信。`,
      `${records.length} reminders were missed while away. Review them in the panel; no backlog was pushed.`);
    view?.setBanner(text); logseq.UI.showMsg(text, 'info', { timeout: 6500 });
  },
  onDue: record => {
    const title = cleanTimerTitle(record.blockContent).split('\n')[0].slice(0, 120);
    logseq.UI.showMsg(tr(`该跟进了：${title}`, `Time to follow up: ${title}`), 'warning', { timeout: 7000 });
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const notification = new Notification(tr('异步任务到期', 'Follow-up due'), { body: title, tag: record.blockUuid });
        notification.onclick = () => { view.showPanel(); logseq.showMainUI({ autoFocus: true }); };
      }
    } catch (_) { /* The in-app notification remains available. */ }
    if (logseq.settings?.soundEnabled !== false) sound();
    notifier?.enqueue(record);
  },
});

function sound() {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.connect(gain); gain.connect(context.destination); gain.gain.value = 0.12;
    oscillator.frequency.value = 660; oscillator.start(); oscillator.stop(context.currentTime + 0.15);
    oscillator.onended = () => context.close();
  } catch (_) { /* Sound is optional. */ }
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

async function activate() {
  const sequence = ++switching;
  activating = true; clearTimeout(startupRetry);
  ready = false; notifier?.dispose(); notifier = null; controller.dispose();
  clearTimeout(debounce); view.mode = null; view.panel = null; view.rows.clear(); view.selected.clear();
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
    ready = true;
    if (controller.migrated) logseq.UI.showMsg(tr(`已升级 ${controller.migrated} 条提醒，原始计时值已保留。`,
      `Upgraded ${controller.migrated} reminders; original values retained.`), 'success');
    if (notifier.storageError) view.setBanner(tr('本机推送记录无法保存，重启后的去重可能失效。', 'Local delivery receipts could not be saved; deduplication across restarts may be unavailable.'));
  } catch (error) { if (sequence === switching) report(error); }
  finally { if (sequence === switching) activating = false; }
}

async function navigate(uuid) {
  const block = await logseq.Editor.getBlock(uuid, { includePage: true });
  if (!block) throw new Error(tr('任务已被删除。', 'The task was deleted.'));
  const page = block.page?.id ? await logseq.Editor.getPage(block.page.id) : block;
  if (!page?.uuid) throw new Error(tr('找不到所在页面。', 'The containing page was not found.'));
  logseq.hideMainUI(); view.mode = null;
  await logseq.Editor.scrollToBlockInPage(page.uuid, uuid);
}

async function run(action, uuid, options = {}) {
  if (action === 'close') { view.mode = null; logseq.hideMainUI(); return; }
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
    const epoch = controller.epoch;
    const expiresAt = ['tomorrow', 'weekday'].includes(options.preset) ? nextMorning(options.preset) : Date.now() + secondsFromMinutes(Number(options.preset)) * 1000;
    const selected = options.ids.map(id => [id, recordToken(controller.records.get(id))]);
    let succeeded = 0, failed = 0;
    for (const [id, expected] of selected) {
      controller.assert(epoch);
      try { await controller.act(id, 'schedule', { expiresAt, expected }); succeeded++; view.selected.delete(id); }
      catch (_) { controller.assert(epoch); failed++; }
    }
    view.setNotice(tr(`已延后 ${succeeded} 项${failed ? `；${failed} 项失败，保留选中，请刷新后重试` : ''}。`,
      `${succeeded} snoozed${failed ? `; ${failed} failed and remain selected. Refresh and retry` : ''}.`), failed > 0);
    return;
  }
  await controller.act(uuid, action, options);
  if (view.mode === 'picker' && action === 'schedule') { view.showPanel(); }
  view.setNotice(tr('已保存。可在操作历史中查看记录，或撤销上一步。', 'Saved. Review history or undo the last action.'));
}

async function openPicker(uuid, title) {
  if (!ready) throw new Error(tr('图谱正在加载或升级，请稍后重试。', 'Graph is loading or upgrading.'));
  await controller.refresh();
  view.showPicker(uuid, title, controller.records.get(uuid) || null);
  logseq.showMainUI({ autoFocus: true });
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
    clearTimeout(debounce); debounce = setTimeout(() => controller.refresh().catch(report), 800);
  }));
  offHooks.push(logseq.App.onCurrentGraphChanged(activate));
  offHooks.push(logseq.App.onGraphAfterIndexed(() => { if (!ready && !activating) activate(); }));
  for (const name of ['Async Timer', '异步任务计时']) logseq.Editor.registerSlashCommand(name, safe(async () => {
    const block = await logseq.Editor.getCurrentBlock();
    if (block) await openPicker(block.uuid, await logseq.Editor.getEditingBlockContent() || block.title);
  }));
  logseq.Editor.registerBlockContextMenuItem(tr('设置异步提醒', 'Set async reminder'), safe(async ({ uuid }) => {
    const block = await logseq.Editor.getBlock(uuid); if (block) await openPicker(uuid, block.title);
  }));
  logseq.provideModel({
    toggleTimerPanel: safe(async () => {
      if (activating) {
        logseq.UI.showMsg(tr('图谱正在加载或升级，完成后即可打开面板。', 'Graph is loading or upgrading; the panel will be available shortly.'), 'info');
        return;
      }
      if (!ready) { await activate(); if (!ready) return; }
      await controller.refresh(); view.showPanel(); logseq.showMainUI({ autoFocus: true });
    }),
    changeInlineTimer: safe(async ({ dataset }) => {
      const block = await logseq.Editor.getBlock(dataset.uuid); if (block) await openPicker(block.uuid, block.title);
    }),
    completeInlineTimer: safe(async ({ dataset }) => {
      if (!ready) return;
      await controller.refresh();
      await run('complete', dataset.uuid, { expected: recordToken(controller.records.get(dataset.uuid)) });
    }),
  });
  offHooks.push(logseq.App.onMacroRendererSlotted(({ slot, payload }) => {
    if (String(payload?.arguments?.[0] || '').trim().toLowerCase() !== INLINE_TIMER_RENDERER_TYPE || !payload.uuid) return;
    const uuid = escapeHtml(payload.uuid);
    logseq.provideUI({ key: `async-task-timer-inline-${uuid}`, slot, reset: true,
      template: `<span><button class="async-timer-inline-btn" data-uuid="${uuid}" data-on-click="changeInlineTimer">⏱ ${tr('跟进', 'Follow up')}</button><button class="async-timer-inline-btn" data-uuid="${uuid}" data-on-click="completeInlineTimer">✓ ${tr('完成', 'Complete')}</button></span>` });
  }));
  logseq.App.registerUIItem('toolbar', { key: 'timer-toolbar-btn', template: `<a class="button" data-on-click="toggleTimerPanel" title="Async Task Timer"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M5 3L2 6M22 6l-3-3M12 2v2"/></svg></a>` });
  tick = setInterval(() => { if (ready) { view.tick(); controller.tick().catch(report); notifier?.process().catch(report); } }, 1000);
  poll = setInterval(() => { if (ready) controller.refresh().catch(report); }, 30000);
  logseq.beforeunload(async () => {
    disposed = true; ready = false; switching++; controller.dispose(); notifier?.dispose();
    clearTimeout(debounce); clearTimeout(startupRetry); clearInterval(tick); clearInterval(poll);
    for (const off of offHooks) if (typeof off === 'function') off();
    await controller.writes.catch(() => {});
  });
  await activate();
}
logseq.ready(main).catch(report);
