import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ReminderController } from '../src/controller.js';
import { NotificationQueue, sendWecom } from '../src/notifications.js';
import { assertSupported, cleanTimerTitle, INLINE_TIMER_RENDERER_TYPE, recordToken } from '../src/db-store.js';
import { isDatabaseUnavailable } from '../src/readiness.js';
import { nextMorning, secondsFromMinutes } from '../src/reminder.js';
import { escapeHtml } from '../src/ui.js';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '')
  + '\nglobalThis.testRun = run; globalThis.testController = controller;';
const task = id => ({ blockUuid: id, blockContent: 'Task ' + id, state: 'active', taskStatus: '',
  expiresAt: Date.now() + 60000, totalSeconds: 60, owner: '', project: '', history: { version: 1, events: [] } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  const rows = new Map([['a', task('a')], ['b', task('b')]]), events = [], errors = [], inline = [], injections = [];
  let slash, startup, models, view, graphHook, macroHook, lists = 0, reads = 0, writes = 0, getGate, saveGate;
  class Store {
    async migrate() { return 0; }
    async list() { lists++; return structuredClone([...rows.values()]); }
    async get(id, { withBlock = false } = {}) {
      reads++;
      const record = await (getGate ? getGate(id) : structuredClone(rows.get(id)));
      return withBlock ? { exists: !!record, record, title: record?.blockContent } : record;
    }
    async act(id, action, { assertCurrent, basis, expected }) {
      assert.equal(recordToken(basis), expected);
      if (expected !== recordToken(rows.get(id))) {
        throw Object.assign(new Error('Reminder changed'), { code: 'REMINDER_CONFLICT' });
      }
      writes++; if (saveGate) await saveGate.promise;
      assertCurrent();
      const saved = { ...rows.get(id), state: 'completed', expiresAt: null, taskStatus: 'logseq.property/status.done' };
      rows.set(id, saved); return saved;
    }
  }
  class View {
    constructor() { view = this; this.lang = 'zh'; this.rows = new Map(); this.selected = new Set(); }
    update() {} resetInteraction() {} setBanner() {}
    setNotice(message) { events.push(['notice', message]); }
    showPanel() { this.mode = 'panel'; events.push(['panel']); }
    showPicker(id) { this.mode = 'picker'; this.pickerUuid = id; events.push(['picker', id]); }
    setPickerLoading(id) { events.push(['loading', id]); }
    setPickerRecord(id, record) { events.push(['loaded', id, record?.state]); }
    setPickerError(id, message) { events.push(['error', id, message]); }
  }
  const context = vm.createContext({
    ReminderController, NotificationQueue, sendWecom, assertSupported, cleanTimerTitle, INLINE_TIMER_RENDERER_TYPE,
    recordToken, isDatabaseUnavailable, nextMorning, secondsFromMinutes, escapeHtml,
    waitForDatabase: async () => {}, DbTimerStore: Store, TimerView: View,
    document: { getElementById: () => ({}) }, window: {}, crypto: globalThis.crypto, console, Date,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    logseq: {
      ready: fn => { startup = fn(); return startup; }, settings: { language: 'zh' },
      useSettingsSchema() {}, onSettingsChanged() {}, setMainUIInlineStyle() {}, provideStyle() {},
      provideModel: model => { models = model; }, provideUI: ui => { inline.push(ui.template); injections.push(ui); },
      hideMainUI: () => events.push(['hide']), showMainUI: () => events.push(['show']), beforeunload() {},
      UI: { showMsg: message => errors.push(message) },
      App: { getCurrentGraph: async () => ({ url: 'graph-a' }), getInfo: async () => ({ version: '2.0.2' }),
        pushState: async (route, params) => { events.push(['route', route, params.name]); },
        checkCurrentIsDbGraph: async () => true, onCurrentGraphChanged: hook => { graphHook = hook; }, onGraphAfterIndexed() {},
        onMacroRendererSlotted: hook => { macroHook = hook; }, registerUIItem() {} },
      Editor: { registerSlashCommand(_name, hook) { slash = hook; }, registerBlockContextMenuItem() {}, getBlock: async id => ({ uuid: id, title: 'Task ' + id }) },
      DB: { onChanged() {} },
    },
  });
  vm.runInContext(source, context); await startup;
  return { events, errors, inline, injections, models, view, context, rows, slash,
    counts: () => ({ lists, reads, writes }), gateGet: fn => { getGate = fn; }, gateSave: d => { saveGate = d; },
    macro: (id, slot = 'slot-' + id) => macroHook({ slot, payload: { uuid: id, arguments: [INLINE_TIMER_RENDERER_TYPE] } }),
    close: () => context.testRun('close'), switchGraph: () => graphHook() };
}

test('verified cached reminders are immediately editable from inline and slash without a DB lookup', async () => {
  const h = await fixture();
  h.gateGet(() => { throw Error('Warm picker must not query the graph'); });
  for (const open of [() => h.models.changeInlineTimer({ dataset: { uuid: 'a' } }), () => h.slash({ uuid: 'a' })]) {
    await open();
    assert.deepEqual(h.events.slice(-2), [['show'], ['picker', 'a']]);
  }
  assert.deepEqual(h.counts(), { lists: 1, reads: 0, writes: 0 });
});

test('an uncached picker opens before the target read, then enables saving against the returned record', async () => {
  const h = await fixture(), gate = deferred();
  h.gateGet(() => gate.promise);
  const opening = h.models.changeInlineTimer({ dataset: { uuid: 'cold' } });
  assert.deepEqual(h.events.slice(-3), [['show'], ['picker', 'cold'], ['loading', 'cold']]);
  gate.resolve(task('cold')); await opening;
  assert.deepEqual(h.events.at(-1), ['loaded', 'cold', 'active']);
  assert.deepEqual(h.counts(), { lists: 1, reads: 1, writes: 0 });
});

test('closing or opening a cached picker prevents late target reads from updating it', async () => {
  const h = await fixture(), gate = deferred();
  h.gateGet(() => gate.promise);
  const first = h.models.changeInlineTimer({ dataset: { uuid: 'cold' } }); await flush();
  await h.models.changeInlineTimer({ dataset: { uuid: 'b' } });
  gate.resolve(task('cold')); await first;
  assert.deepEqual(h.events.filter(e => e[0] === 'loaded'), []);
  const closeGate = deferred(); h.gateGet(() => closeGate.promise);
  const closing = h.models.changeInlineTimer({ dataset: { uuid: 'another' } }); await flush();
  await h.close(); closeGate.resolve(task('another')); await closing;
  assert.equal(h.view.mode, null);
  assert.equal(h.events.filter(e => e[0] === 'loaded').length, 0);
});

test('a rejected warm picker save loads remote state without overwriting it or replaying the edit', async () => {
  const h = await fixture();
  await h.slash({ uuid: 'b' });
  const expected = recordToken(h.context.testController.records.get('b'));
  h.rows.set('b', { ...h.rows.get('b'), owner: 'another device' });
  await assert.rejects(h.context.testRun('schedule', 'b', { expected }), /Reminder changed/);
  assert.equal(h.context.testController.records.get('b').owner, 'another device');
  assert.deepEqual(h.events.at(-1), ['loaded', 'b', 'active']);
  assert.deepEqual(h.counts(), { lists: 1, reads: 1, writes: 0 });
});

test('inline completion gives immediate feedback, deduplicates double clicks and never scans the list', async () => {
  const h = await fixture(), gate = deferred(); h.gateSave(gate); h.macro('a');
  const first = h.models.completeInlineTimer({ dataset: { uuid: 'a' } });
  const second = h.models.completeInlineTimer({ dataset: { uuid: 'a' } });
  assert.match(h.inline.at(-1), /保存中/); assert.match(h.inline.at(-1), /disabled/);
  await flush(); assert.equal(h.counts().writes, 1);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(h.counts(), { lists: 1, reads: 0, writes: 1 });
  assert.equal(h.context.testController.records.get('a').state, 'completed');
  assert.match(h.inline.at(-1), /已完成/);
  await h.models.completeInlineTimer({ dataset: { uuid: 'a' } });
  assert.equal(h.counts().writes, 1);
  h.rows.set('a', task('a')); await h.context.testController.refresh();
  assert.doesNotMatch(h.inline.at(-1), /已完成|保存中|disabled/);
});

test('two copies of the same block show pending and completion together but only write once', async () => {
  const h = await fixture(), gate = deferred(); h.gateSave(gate);
  h.macro('a', 'journal'); h.macro('a', 'reference');
  const ids = h.injections.map(ui => ui.key); assert.equal(new Set(ids).size, 2);
  const first = h.models.completeInlineTimer({ dataset: { uuid: 'a', slot: 'journal' } });
  const second = h.models.completeInlineTimer({ dataset: { uuid: 'a', slot: 'reference' } });
  assert.deepEqual(h.injections.slice(-2).map(ui => ui.slot), ['reference', 'journal']);
  assert.ok(h.injections.slice(-2).every(ui => ui.template.includes('保存中')));
  await flush(); assert.equal(h.counts().writes, 1);
  gate.resolve(); await Promise.all([first, second]);
  for (const key of ids) assert.match(h.injections.filter(ui => ui.key === key).at(-1).template, /已完成/);
});

test('inline completion refreshes a stale reminder and requires an explicit retry', async () => {
  const h = await fixture(); h.macro('a');
  h.rows.set('a', { ...h.rows.get('a'), owner: 'Changed elsewhere' });
  await h.models.completeInlineTimer({ dataset: { uuid: 'a' } });
  assert.deepEqual(h.counts(), { lists: 1, reads: 1, writes: 0 });
  assert.equal(h.context.testController.records.get('a').owner, 'Changed elsewhere');
  assert.match(h.errors.at(-1), /Reminder changed/);
  await h.models.completeInlineTimer({ dataset: { uuid: 'a' } });
  assert.deepEqual(h.counts(), { lists: 1, reads: 1, writes: 1 });
});

test('an old picker read cannot re-open a picker after a graph switch', async () => {
  const h = await fixture(), gate = deferred(); h.gateGet(() => gate.promise);
  const opening = h.models.changeInlineTimer({ dataset: { uuid: 'cold' } }); await flush();
  await h.switchGraph(); gate.resolve(task('cold')); await opening;
  assert.equal(h.view.mode, null);
  assert.equal(h.events.filter(e => e[0] === 'loaded').length, 0);
  assert.deepEqual(h.errors, []);
});

test('toolbar opens cached reminders before a slow background list read', async () => {
  const h = await fixture(), gate = deferred();
  await h.models.toggleTimerPanel();
  assert.equal(h.counts().lists, 1, 'opening just after activation uses the fresh list');
  h.context.testController.lastListedAt -= 5001;
  let scanned = false;
  h.context.testController.store.list = () => { scanned = true; return gate.promise; };
  const opening = h.models.toggleTimerPanel();
  assert.deepEqual(h.events.slice(-2), [['show'], ['panel']]);
  await flush(); assert.equal(scanned, true);
  gate.resolve([task('a')]); await opening;
});

test('task title opens the source block itself, without a journal-page anchor or extra scan', async () => {
  const h = await fixture(); h.view.showPanel();
  h.context.logseq.Editor.getBlock = async id => ({ uuid: id, page: { id: 100, uuid: 'journal' }, collapsed: true });
  h.context.logseq.Editor.getPage = async () => { throw new Error('Must not route through the containing journal'); };
  h.context.logseq.Editor.scrollToBlockInPage = () => { throw new Error('Legacy anchors cannot locate DB blocks'); };
  await h.context.testRun('navigate', 'a');
  assert.deepEqual(h.events.slice(-2), [['route', 'page', 'a'], ['hide']]);
  assert.equal(h.view.mode, null);
  assert.deepEqual(h.counts(), { lists: 1, reads: 0, writes: 0 });
});

test('a deleted task reports the error without dismissing the panel or navigating elsewhere', async () => {
  const h = await fixture(); h.view.showPanel();
  const start = h.events.length;
  h.context.logseq.Editor.getBlock = async () => null;
  await assert.rejects(h.context.testRun('navigate', 'a'), /任务已被删除/);
  assert.equal(h.view.mode, 'panel');
  assert.deepEqual(h.events.slice(start), []);
});

test('closing the panel or switching graphs cancels navigation while a block lookup is pending', async () => {
  for (const cancel of ['close', 'switchGraph']) {
    const h = await fixture(), gate = deferred(); h.view.showPanel();
    h.context.logseq.Editor.getBlock = () => gate.promise;
    const navigation = h.context.testRun('navigate', 'a');
    await h[cancel](); gate.resolve({ uuid: 'a', page: { id: 100 } }); await navigation;
    assert.equal(h.events.some(e => e[0] === 'route'), false, cancel);
  }
});

test('a navigation failure keeps the panel available for its error message and retry', async () => {
  const h = await fixture(); h.view.showPanel();
  const start = h.events.length;
  h.context.logseq.App.pushState = async () => { throw new Error('Route unavailable'); };
  await assert.rejects(h.context.testRun('navigate', 'a'), /Route unavailable/);
  assert.equal(h.view.mode, 'panel');
  assert.deepEqual(h.events.slice(start), []);
});

test('a late navigation acknowledgement does not close a newly opened follow-up picker', async () => {
  const h = await fixture(), gate = deferred(); h.view.showPanel();
  h.context.logseq.App.pushState = () => gate.promise;
  const navigation = h.context.testRun('navigate', 'a'); await flush();
  await h.models.changeInlineTimer({ dataset: { uuid: 'b' } });
  const start = h.events.length;
  gate.resolve(); await navigation;
  assert.equal(h.view.mode, 'picker'); assert.equal(h.view.pickerUuid, 'b');
  assert.deepEqual(h.events.slice(start), []);
});
