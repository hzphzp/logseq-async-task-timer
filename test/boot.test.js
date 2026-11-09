import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ReminderController } from '../src/controller.js';
import { NotificationQueue, sendWecom } from '../src/notifications.js';
import { assertSupported, cleanTimerTitle, INLINE_TIMER_RENDERER_TYPE, recordToken } from '../src/db-store.js';
import { isDatabaseUnavailable, waitForDatabase } from '../src/readiness.js';
import { nextMorning, secondsFromMinutes } from '../src/reminder.js';
import { escapeHtml } from '../src/ui.js';
const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '') + '\nglobalThis.bootState = () => ({ ready, activating, records: [...controller.records.keys()] }); globalThis.refreshTest = () => controller.refresh().catch(report); globalThis.reportTest = report;';
function boot({ interruptMigration = false, startupBridgeTimeout = false, records = [] } = {}) {
  let startup, queries = 0, migrations = 0, unload, onChanged, graphReads = 0, listError = null;
  const events = [], messages = [], timeouts = new Map(), delays = [], storage = new Map(); let timerId = 0;
  const context = vm.createContext({
    ReminderController, NotificationQueue, sendWecom, assertSupported, cleanTimerTitle, INLINE_TIMER_RENDERER_TYPE, recordToken,
    isDatabaseUnavailable, nextMorning, secondsFromMinutes, escapeHtml,
    waitForDatabase: (api, options) => waitForDatabase(api, { ...options, wait: async () => {} }),
    DbTimerStore: class {
      async migrate() { events.push('migrate'); migrations++; if (interruptMigration && migrations === 1) throw new Error('db-worker has not been initialized'); return 0; }
      async list() { if (listError) throw listError; return structuredClone(records); }
    },
    TimerView: class {
      constructor() { this.lang = 'zh'; this.rows = new Map(); this.selected = new Set(); }
      update() {} setNotice() {} setBanner() {} resetInteraction() {}
    },
    logseq: {
      ready: fn => { startup = fn(); return startup; }, settings: { language: 'zh' },
      useSettingsSchema() {}, onSettingsChanged() {}, setMainUIInlineStyle() {}, provideStyle() {}, provideModel() {}, hideMainUI() {},
      beforeunload: fn => { unload = fn; }, UI: { showMsg: (_message, kind) => { messages.push(kind); events.push('message'); } },
      App: { getCurrentGraph: async () => { if (startupBridgeTimeout && !graphReads++) throw new Error('[deferred timeout] async call #5416'); return { url: 'graph-a' }; }, getInfo: async () => ({ version: '2.0.2' }),
        checkCurrentIsDbGraph: async () => true, onCurrentGraphChanged() {}, onGraphAfterIndexed() {},
        onMacroRendererSlotted() {}, registerUIItem() {} },
      Editor: { registerSlashCommand() {}, registerBlockContextMenuItem() {} },
      DB: { onChanged: fn => { onChanged = fn; }, datascriptQuery: async () => { events.push('probe'); queries++;
        if (queries < 3) throw new Error('db-worker has not been initialized'); return [[1]]; } },
    },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: { getElementById: () => ({}) }, window: {}, crypto: globalThis.crypto, console, Date,
    setTimeout: (fn, delay) => { const id = ++timerId; delays.push(delay); timeouts.set(id, async () => { timeouts.delete(id); return fn(); }); return id; }, clearTimeout: id => timeouts.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
  });
  vm.runInContext(source, context);
  return { startup: () => startup, state: () => context.bootState(), events, messages, timeouts, delays,
    error: value => { listError = value; }, refresh: () => context.refreshTest(), report: error => context.reportTest(error),
    changed: () => onChanged(), unload: () => unload() };
}

test('real plugin entry waits for the worker before migrating or reporting errors', async () => {
  const h = boot(); await h.startup();
  assert.equal(h.state().ready, true);
  assert.deepEqual(h.events, ['probe', 'probe', 'probe', 'migrate']);
  await h.unload();
});

test('worker interruption during initialization schedules recovery instead of leaving the plugin unusable', async () => {
  const h = boot({ interruptMigration: true }); await h.startup();
  assert.equal(h.state().ready, false); assert.equal(h.timeouts.size, 1);
  await [...h.timeouts.values()][0]();
  assert.equal(h.state().ready, true);
  assert.equal(h.events.filter(event => event === 'migrate').length, 2);
  assert.equal(h.events.includes('message'), false);
  await h.unload();
});

test('a bridge timeout before graph activation reconnects automatically without an error popup', async () => {
  const h = boot({ startupBridgeTimeout: true }); await h.startup();
  assert.equal(h.state().ready, false); assert.equal(h.timeouts.size, 1);
  await [...h.timeouts.values()][0]();
  assert.equal(h.state().ready, true); assert.equal(h.events.includes('message'), false);
  await h.unload();
});

test('background timeouts keep cached reminders, back off once, and recover without remigration', async () => {
  const h = boot({ records: [{ blockUuid: 'saved', state: 'active', expiresAt: Date.now() + 60000 }] });
  await h.startup();
  const error = new Error('[deferred timeout] async call #5416');
  h.error(error); await h.refresh();
  for (let i = 0; i < 20; i++) h.report(error);
  assert.equal(h.state().ready, false); assert.deepEqual([...h.state().records], ['saved']);
  assert.equal(h.timeouts.size, 1); assert.deepEqual(h.delays, [1500]);
  await [...h.timeouts.values()][0]();
  assert.equal(h.timeouts.size, 1); assert.deepEqual(h.delays, [1500, 3000]);
  h.error(null); await [...h.timeouts.values()][0]();
  assert.equal(h.state().ready, true); assert.equal(h.timeouts.size, 0);
  assert.equal(h.events.filter(e => e === 'migrate').length, 1);
  assert.equal(h.events.includes('message'), false);
  await h.unload();
});

test('bulk changes coalesce refreshes; unloading cancels pending recovery', async () => {
  const h = boot(); await h.startup();
  for (let i = 0; i < 200; i++) h.changed();
  assert.equal(h.timeouts.size, 1);
  await [...h.timeouts.values()][0]();
  h.changed(); assert.ok(h.delays.at(-1) >= 4000);
  h.report(new Error('[deferred timeout] async call #2'));
  assert.equal(h.timeouts.size, 1);
  await h.unload(); assert.equal(h.timeouts.size, 0);
});

test('desktop sound falls back to the system notification until the panel unlocks audio', () => {
  const messages = [], notifications = [];
  let tones = 0;
  class Audio {
    state = 'suspended';
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() { return { frequency: {}, connect() {}, start() { tones++; }, stop() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
  }
  class Notice {
    static permission = 'granted';
    constructor(_title, options) { notifications.push(options); }
  }
  const logseq = { settings: { soundEnabled: true }, ready: () => Promise.resolve(),
    UI: { showMsg: message => messages.push(message) } };
  const context = vm.createContext({ logseq, localStorage: { getItem: () => 'test', setItem() {} },
    window: { AudioContext: Audio, Notification: Notice }, Notification: Notice, ReminderController, cleanTimerTitle });
  vm.runInContext(source + '\nglobalThis.alert = () => controller.onDue({blockContent:"Test",blockUuid:"test"}); globalThis.unlock = unlockAudio;', context);
  context.alert(); context.unlock(); context.alert();
  logseq.settings.soundEnabled = false; context.alert();
  assert.deepEqual(notifications.map(n => n.silent), [false, true, true]);
  assert.equal(tones, 1);
  assert.equal(messages.length, 3);
});


test('reconnection delivers a still-active new deadline and drops a remote completion', async () => {
  const records = ['due', 'done'].map(blockUuid => ({ blockUuid, state: 'active', expiresAt: Date.now() + 60000 }));
  const h = boot({ records });
  await h.startup();
  h.report(new Error('[deferred timeout] async call #5416'));
  for (const r of records) r.expiresAt = Date.now();
  records[1].taskStatus = 'logseq.property/status.done';
  await [...h.timeouts.values()][0]();
  await h.refresh();
  assert.deepEqual(h.messages, ['warning']);
  await h.unload();
});
