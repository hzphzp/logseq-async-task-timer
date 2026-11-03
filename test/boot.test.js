import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ReminderController } from '../src/controller.js';
import { NotificationQueue, sendWecom } from '../src/notifications.js';
import { assertSupported, cleanTimerTitle, INLINE_TIMER_RENDERER_TYPE, recordToken } from '../src/db-store.js';
import { isDatabaseStarting, waitForDatabase } from '../src/readiness.js';
import { nextMorning, secondsFromMinutes } from '../src/reminder.js';
import { escapeHtml } from '../src/ui.js';
const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '') + '\nglobalThis.bootState = () => ({ ready, activating });';
function boot({ interruptMigration = false } = {}) {
  let startup, queries = 0, migrations = 0, unload;
  const events = [], timeouts = new Map(), storage = new Map(); let timerId = 0;
  const context = vm.createContext({
    ReminderController, NotificationQueue, sendWecom, assertSupported, cleanTimerTitle, INLINE_TIMER_RENDERER_TYPE, recordToken,
    isDatabaseStarting, nextMorning, secondsFromMinutes, escapeHtml,
    waitForDatabase: (api, options) => waitForDatabase(api, { ...options, wait: async () => {} }),
    DbTimerStore: class {
      async migrate() { events.push('migrate'); migrations++; if (interruptMigration && migrations === 1) throw new Error('db-worker has not been initialized'); return 0; }
      async list() { return []; }
    },
    TimerView: class {
      constructor() { this.lang = 'zh'; this.rows = new Map(); this.selected = new Set(); }
      update() {} setNotice() {} setBanner() {}
    },
    logseq: {
      ready: fn => { startup = fn(); return startup; }, settings: { language: 'zh' },
      useSettingsSchema() {}, onSettingsChanged() {}, setMainUIInlineStyle() {}, provideStyle() {}, provideModel() {}, hideMainUI() {},
      beforeunload: fn => { unload = fn; }, UI: { showMsg: () => events.push('message') },
      App: { getCurrentGraph: async () => ({ url: 'graph-a' }), getInfo: async () => ({ version: '2.0.2' }),
        checkCurrentIsDbGraph: async () => true, onCurrentGraphChanged() {}, onGraphAfterIndexed() {},
        onMacroRendererSlotted() {}, registerUIItem() {} },
      Editor: { registerSlashCommand() {}, registerBlockContextMenuItem() {} },
      DB: { onChanged() {}, datascriptQuery: async () => { events.push('probe'); queries++;
        if (queries < 3) throw new Error('db-worker has not been initialized'); return [[1]]; } },
    },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: { getElementById: () => ({}) }, window: {}, crypto: globalThis.crypto, console, Date,
    setTimeout: fn => { timeouts.set(++timerId, fn); return timerId; }, clearTimeout: id => timeouts.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
  });
  vm.runInContext(source, context);
  return { startup: () => startup, state: () => context.bootState(), events, timeouts, unload: () => unload() };
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
