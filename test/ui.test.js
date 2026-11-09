import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TimerView } from '../src/ui.js';
import { recordToken } from '../src/db-store.js';
const active = id => ({ blockUuid: id, blockContent: 'Task ' + id, taskStatus: '', state: 'active', expiresAt: Date.now() + 600000,
  totalSeconds: 600, owner: 'Alice', project: 'Project A', history: { version: 1, events: [] } });
function fixture(records = new Map([['a', active('a')], ['b', active('b')]])) {
  const dom = new JSDOM('<div id="app"></div>'); globalThis.document = dom.window.document;
  const calls = [];
  const view = new TimerView(document.getElementById('app'), { records: () => records, receipt: () => null, run: async (...args) => calls.push(args) });
  view.showPanel(); return { dom, view, records, calls, root: document.getElementById('app') };
}
test('DB refresh and countdown updates preserve typed input, focus and expanded history', () => {
  const f = fixture(); const row = f.root.querySelector('[data-uuid="a"]');
  row.querySelector('[data-action="edit"]').click();
  const input = row.querySelector('[name="owner"]'); input.value = 'Unsaved name'; input.focus();
  input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  row.querySelector('details').open = true;
  f.records.get('a').blockContent = 'Changed remotely';
  f.records.get('a').expiresAt += 1000;
  f.view.update(); f.view.tick();
  assert.equal(f.root.querySelector('[data-uuid="a"]'), row);
  assert.equal(document.activeElement, input); assert.equal(input.value, 'Unsaved name');
  assert.equal(row.querySelector('.editor').hidden, false); assert.equal(row.querySelector('details').open, true);
  assert.equal(row.querySelector('.task-title').textContent, 'Changed remotely');
  assert.match(row.querySelector('.conflict').textContent, /更新/);
});
test('search, project filtering and selection stay consistent during updates', () => {
  const f = fixture(); f.records.get('b').project = 'Project B'; f.view.update();
  const select = f.root.querySelector('#select-all'); select.checked = true; select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  assert.equal(f.view.selected.size, 2);
  const search = f.root.querySelector('#search'); search.value = 'Task a'; search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  assert.equal(f.view.visible.length, 1); assert.equal(f.view.selected.size, 1);
  f.view.project = 'Project B'; f.view.update(); assert.equal(f.view.visible.length, 0); assert.equal(f.view.selected.size, 0);
});
test('countdown ticks only touch text that changes and a refreshed deadline is shown immediately', t => {
  let now = Date.UTC(2026, 0, 10, 9, 0, 0);
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  f.records.get('a').expiresAt = now + 2000;
  f.records.get('b').expiresAt = now - (90 * 24 + 2.5) * 3600000;
  f.view.update();
  const near = f.root.querySelector('[data-uuid="a"]');
  const clock = near.querySelector('.clock'), deadline = near.querySelector('.deadline');
  const observer = new f.dom.window.MutationObserver(() => {});
  observer.observe(f.root, { subtree: true, childList: true, attributes: true, characterData: true });
  now += 1000; f.view.tick();
  assert.equal(clock.textContent, '00:01');
  assert.deepEqual(observer.takeRecords().map(mutation => mutation.target), [clock]);
  now += 2000; f.view.tick();
  assert.equal(clock.textContent, '已到期 00:01');
  assert.equal(clock.classList.contains('overdue'), true);
  const next = now + 86400000; f.records.get('a').expiresAt = next;
  f.view.update();
  assert.equal(deadline.textContent, f.view.date(next));
  assert.equal(clock.title, f.view.date(next)); assert.equal(clock.classList.contains('overdue'), false);
  observer.disconnect();
});
test('opening an on-demand editor uses current data and reopening preserves a hidden draft and reports conflicts', () => {
  const f = fixture(), row = f.root.querySelector('[data-uuid="a"]');
  assert.equal(f.root.querySelector('.editor'), null);
  f.records.get('a').owner = 'Latest owner'; f.view.update();
  const edit = row.querySelector('[data-action="edit"]'); edit.click();
  const form = row.querySelector('.editor'), owner = form.querySelector('[name="owner"]');
  assert.equal(f.root.querySelectorAll('.editor').length, 1);
  assert.equal(document.activeElement, form.querySelector('[name="minutes"]'));
  assert.equal(owner.value, 'Latest owner');
  type(f, owner, 'Draft'); edit.click();
  f.records.get('a').owner = 'Changed elsewhere'; f.view.update(); edit.click();
  assert.equal(row.querySelector('.editor'), form); assert.equal(owner.value, 'Draft');
  assert.match(form.querySelector('.conflict').textContent, /记录已更新/);
});
test('history renders on expansion with current records, updates while open, and reopens in the current language', async () => {
  const record = active('a');
  record.history.events.push({ id: 'first', action: 'import', at: Date.now() });
  const f = fixture(new Map([['a', record]])), history = f.root.querySelector('.history');
  const actions = () => [...history.querySelectorAll('li strong')].map(label => label.textContent);
  const toggle = open => {
    const changed = new Promise(resolve => history.addEventListener('toggle', resolve, { once: true }));
    history.open = open;
    return changed;
  };
  assert.match(history.querySelector('summary').textContent, /1/);
  assert.deepEqual(actions(), []);
  const current = structuredClone(record);
  current.history.events.push({ id: 'second', action: 'schedule', at: Date.now() });
  f.records.set('a', current);
  await toggle(true);
  assert.deepEqual(actions(), ['设置 / 延后', '升级导入']);
  current.history.events[1].action = 'cancel'; f.view.update();
  assert.deepEqual(actions(), ['取消提醒', '升级导入']);
  await toggle(false);
  current.history.events.push({ id: 'third', action: 'complete', at: Date.now() });
  f.view.lang = 'en'; f.view.update();
  assert.equal(history.querySelector('summary').textContent, 'History · 3');
  assert.deepEqual(actions(), ['取消提醒', '升级导入']);
  await toggle(true);
  assert.deepEqual(actions(), ['Completed', 'Canceled', 'Imported']);
});
test('stored titles and project names cannot inject executable markup', () => {
  const f = fixture(); f.records.get('a').blockContent = '<img src=x onerror=alert(1)>';
  f.records.get('a').project = '"><img src=x>';
  f.view.update(); assert.equal(f.root.querySelectorAll('img').length, 0);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function type(f, input, value) {
  input.value = value; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
}

test('saving is visible immediately, ignores double clicks, and keeps local controls responsive', async () => {
  const f = fixture(), pending = deferred(), calls = [];
  f.view.run = async action => { calls.push(action); if (action !== 'close') await pending.promise; };
  const row = f.root.querySelector('[data-uuid="a"]'), complete = row.querySelector('[data-action="complete"]');
  const saving = f.view.click({ target: complete });
  assert.equal(f.view.busy, true); assert.equal(complete.disabled, true);
  assert.equal(row.getAttribute('aria-busy'), 'true');
  assert.match(row.querySelector('.row-pending').textContent, /正在完成/);
  assert.match(f.root.querySelector('.pending-status').textContent, /正在完成/);
  await f.view.click({ target: complete }); assert.deepEqual(calls, ['complete']);
  const edit = row.querySelector('[data-action="edit"]');
  assert.equal(edit.disabled, false); await f.view.click({ target: edit });
  assert.equal(row.querySelector('.editor').hidden, false);
  assert.equal(row.querySelector('[data-action="schedule"]').disabled, true);
  await f.view.click({ target: f.root.querySelector('[data-group="today"]') });
  assert.equal(f.view.group, 'today');
  await f.view.click({ target: f.root.querySelector('[data-action="close"]') });
  assert.deepEqual(calls, ['complete', 'close']); assert.equal(f.view.mode, null);
  f.view.showPanel(); assert.equal(f.view.busy, true);
  assert.equal(f.root.querySelector('[data-action="complete"]').disabled, true);
  pending.resolve(); await saving;
  assert.equal(f.view.busy, false); assert.equal(complete.disabled, false);
  assert.equal(f.root.querySelector('.pending-status').hidden, true);
});

test('unrelated rows accept work immediately; a failed save stays visible on its own row', async () => {
  const f = fixture(), a = deferred(), b = deferred(), calls = [];
  f.view.run = async (action, uuid) => { calls.push([action, uuid]); await (uuid === 'a' ? a : b).promise; };
  const row = id => f.root.querySelector(`[data-uuid="${id}"]`);
  const complete = id => row(id).querySelector('[data-action="complete"]');
  const bulk = f.root.querySelector('[data-action="bulk"]');
  f.view.selected.add('a'); f.view.updateSelection(); assert.equal(bulk.disabled, false);
  const first = f.view.click({ target: complete('a') });
  assert.equal(complete('b').disabled, false);
  assert.equal(bulk.disabled, true);
  await f.view.click({ target: bulk });
  const second = f.view.click({ target: complete('b') });
  await f.view.click({ target: complete('b') });
  assert.deepEqual(calls, [['complete', 'a'], ['complete', 'b']]);
  assert.match(f.root.querySelector('.pending-status').textContent, /2 项/);
  assert.equal(f.records.get('a').state, 'active');
  a.reject(new Error('Task A was changed elsewhere')); await first;
  assert.match(row('a').querySelector('.row-pending').textContent, /Task A/);
  assert.equal(complete('a').disabled, false); assert.equal(complete('b').disabled, true);
  f.view.setNotice('Task B saved'); b.resolve(); await second;
  assert.match(row('a').querySelector('.row-pending').textContent, /Task A/);
  assert.equal(complete('b').disabled, false); assert.equal(bulk.disabled, false);
});

test('bulk operations prevent overlapping saves and restore selection after settling', async () => {
  const f = fixture(), gate = deferred(), calls = [];
  f.view.selected.add('a'); f.view.updateSelection();
  f.view.run = async action => { calls.push(action); await gate.promise; f.view.selected.delete('a'); };
  const bulk = f.root.querySelector('[data-action="bulk"]'), complete = f.root.querySelector('[data-uuid="b"] [data-action="complete"]');
  const saving = f.view.click({ target: bulk });
  assert.equal(complete.disabled, true); assert.equal(bulk.disabled, true);
  await f.view.click({ target: complete }); assert.deepEqual(calls, ['bulk']);
  gate.resolve(); await saving;
  assert.equal(complete.disabled, false); assert.equal(bulk.disabled, true);
  assert.match(f.root.querySelector('.selection-count').textContent, /0/);
});

test('a previous graph operation cannot clear the new operation or show its error', async () => {
  const f = fixture(), first = deferred(), second = deferred();
  f.view.run = (action, uuid) => uuid === 'a' ? first.promise : second.promise;
  const old = f.view.click({ target: f.root.querySelector('[data-uuid="a"] [data-action="complete"]') });
  f.view.resetInteraction(); f.view.showPanel();
  const current = f.view.click({ target: f.root.querySelector('[data-uuid="b"] [data-action="complete"]') });
  first.reject(new Error('old graph error')); await old;
  assert.equal(f.view.busy, true); assert.equal(f.view.pending.get('b').action, 'complete');
  assert.equal(f.root.querySelector('[data-uuid="b"]').getAttribute('aria-busy'), 'true');
  assert.equal(f.root.querySelector('.notice').textContent, '');
  second.resolve(); await current; assert.equal(f.view.busy, false);
});

test('picker loads one record without losing draft input or focus', async () => {
  const f = fixture(), old = f.records.get('a');
  f.view.showPicker('a', old.blockContent, old); f.view.setPickerLoading('a');
  const form = f.root.querySelector('.editor'), input = form.querySelector('[name="owner"]');
  assert.equal(document.activeElement, form.querySelector('[name="minutes"]'));
  assert.equal(f.root.querySelector('[data-action="schedule"]').disabled, true);
  assert.equal(f.root.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true');
  input.focus(); type(f, input, 'My newer draft');
  const current = { ...old, owner: 'Remote owner' };
  assert.equal(f.view.setPickerRecord('a', current, 'Resolved task title'), true);
  assert.equal(input.value, 'My newer draft'); assert.equal(document.activeElement, input);
  assert.equal(form.dataset.expected, recordToken(old)); assert.match(form.querySelector('.conflict').textContent, /记录已更新/);
  assert.equal(f.root.querySelector('.picker-title').textContent, 'Resolved task title');
  assert.equal(f.root.querySelector('[data-action="schedule"]').disabled, false);
  await f.view.click({ target: form.querySelector('[data-action="reset-form"]') });
  assert.equal(input.value, 'Remote owner'); assert.equal(form.dataset.expected, recordToken(current));
  assert.equal(f.view.setPickerRecord('b', { ...current, owner: 'Wrong picker' }), false);
  assert.equal(input.value, 'Remote owner');
});

test('failed target reads keep picker writes disabled and stale completion cannot replace a new picker', async () => {
  const f = fixture(), pending = deferred();
  f.view.run = () => pending.promise;
  const saving = f.view.click({ target: f.root.querySelector('[data-uuid="a"] [data-action="complete"]') });
  f.view.showPicker('b', 'Task b', f.records.get('b')); f.view.setPickerLoading('b');
  pending.reject(new Error('Error for previous task')); await saving;
  assert.equal(f.view.busy, false); assert.equal(f.view.pickerState, 'loading');
  assert.equal(f.root.querySelector('.notice').textContent, '');
  assert.equal(f.root.querySelector('[data-action="schedule"]').disabled, true);
  f.view.setPickerError('b', 'Unable to read this task');
  assert.match(f.root.querySelector('.pending-status').textContent, /Unable to read/);
  assert.equal(f.root.querySelector('[data-action="schedule"]').disabled, true);
  assert.equal(f.root.querySelector('[data-action="close"]').disabled, false);
  f.view.showPanel(); assert.equal(f.view.setPickerRecord('b', f.records.get('b')), false);
});

test('typing while a save is pending preserves the newer draft and advances its expected record', async () => {
  const f = fixture(), pending = deferred(), calls = [];
  f.view.run = async (action, uuid, options) => { calls.push(options); await pending.promise; };
  const row = f.root.querySelector('[data-uuid="a"]');
  await f.view.click({ target: row.querySelector('[data-action="edit"]') });
  const form = row.querySelector('.editor'), input = form.querySelector('[name="owner"]');
  type(f, input, 'Submitted owner');
  const saving = f.view.click({ target: form.querySelector('[data-action="metadata"]') });
  type(f, input, 'Newer unsaved owner');
  f.records.set('a', { ...f.records.get('a'), owner: 'Submitted owner' }); f.view.update();
  pending.resolve(); await saving;
  assert.equal(calls[0].owner, 'Submitted owner');
  assert.equal(input.value, 'Newer unsaved owner'); assert.equal(form.dataset.dirty, 'true');
  assert.equal(form.dataset.expected, recordToken(f.records.get('a'))); assert.equal(form.querySelector('.conflict').textContent, '');
});

test('a failed save preserves input, unlocks retry and displays the error without changing the record', async () => {
  const f = fixture(), before = structuredClone(f.records.get('a'));
  f.view.run = async () => { throw new Error('Save was rejected'); };
  const row = f.root.querySelector('[data-uuid="a"]');
  await f.view.click({ target: row.querySelector('[data-action="edit"]') });
  const input = row.querySelector('[name="owner"]'); type(f, input, 'Keep this draft');
  await f.view.click({ target: row.querySelector('[data-action="metadata"]') });
  assert.equal(input.value, 'Keep this draft'); assert.equal(f.view.busy, false);
  assert.equal(row.querySelector('[data-action="metadata"]').disabled, false);
  assert.match(f.root.querySelector('.notice').textContent, /Save was rejected/);
  assert.deepEqual(f.records.get('a'), before);
});

test('picker scheduling preserves input entered after submission instead of returning to the panel', async () => {
  const f = fixture(), pending = deferred(), calls = [];
  f.view.run = async (action, uuid, options) => {
    calls.push(options); await pending.promise;
    f.records.set(uuid, { ...f.records.get(uuid), owner: options.owner, project: options.project, expiresAt: options.expiresAt });
    f.view.update(); f.view.setNotice('Saved');
  };
  f.view.showPicker('a', 'Task a', f.records.get('a'));
  const form = f.root.querySelector('.editor'), input = form.querySelector('[name="owner"]');
  type(f, input, 'Submitted owner');
  const saving = f.view.click({ target: form.querySelector('[data-action="schedule"][data-minutes="5"]') });
  input.focus(); type(f, input, 'Newer unsaved owner');
  pending.resolve(); await saving;
  assert.equal(calls[0].owner, 'Submitted owner');
  assert.equal(f.view.mode, 'picker'); assert.equal(f.root.querySelector('.editor'), form);
  assert.equal(input.value, 'Newer unsaved owner'); assert.equal(document.activeElement, input);
  assert.equal(form.dataset.dirty, 'true'); assert.equal(form.dataset.expected, recordToken(f.records.get('a')));
  assert.match(f.root.querySelector('.notice').textContent, /新输入尚未保存/);
  assert.equal(form.querySelector('[data-action="schedule"]').disabled, false);
});

test('picker scheduling returns to the panel after verified save when there is no newer input', async () => {
  const f = fixture(), pending = deferred();
  f.view.run = async (action, uuid, options) => {
    await pending.promise;
    f.records.set(uuid, { ...f.records.get(uuid), owner: options.owner, project: options.project, expiresAt: options.expiresAt });
    f.view.update(); f.view.setNotice('Saved');
  };
  f.view.showPicker('a', 'Task a', f.records.get('a'));
  const form = f.root.querySelector('.editor');
  type(f, form.querySelector('[name="owner"]'), 'Submitted owner');
  const saving = f.view.click({ target: form.querySelector('[data-action="schedule"][data-minutes="5"]') });
  assert.equal(f.view.mode, 'picker'); assert.equal(f.view.busy, true);
  pending.resolve(); await saving;
  assert.equal(f.view.mode, 'panel'); assert.equal(f.view.busy, false);
  assert.equal(f.records.get('a').owner, 'Submitted owner');
  assert.equal(f.root.querySelector('.notice').textContent, 'Saved');
  assert.equal(form.dataset.dirty, 'false'); assert.equal(form.dataset.expected, recordToken(f.records.get('a')));
});

test('newly overdue rows move to the top on the clock tick, including in the overdue filter', t => {
  let now = new Date(2026, 10, 9, 10).getTime();
  t.mock.method(Date, 'now', () => now);
  const records = new Map(['old', 'soon', 'second', 'recent'].map((id, i) =>
    [id, { ...active(id), expiresAt: now + [-300000, 1000, 2000, -30000][i] }]));
  const f = fixture(records);
  const order = section => [...f.root.querySelectorAll(`[data-group-section="${section}"] .cards > [data-uuid]`)].map(row => row.dataset.uuid);
  assert.deepEqual(order('overdue'), ['recent', 'old']);
  assert.deepEqual(order('today'), ['soon', 'second']);
  now += 1000; f.view.tick();
  assert.deepEqual(order('overdue'), ['soon', 'recent', 'old']);
  f.view.group = 'overdue'; f.view.update();
  now += 1000; f.view.tick();
  assert.deepEqual(order('overdue'), ['second', 'soon', 'recent', 'old']);
});
