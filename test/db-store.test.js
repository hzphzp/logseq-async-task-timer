import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbTimerStore, assertSupported, parseTimer, cleanTimerTitle, decorateTimerTitle, recordToken } from '../src/db-store.js';
import { transition, snapshot, canUndo, nextMorning, groupOf, secondsFromMinutes } from '../src/reminder.js';

const now = new Date(2026, 10, 6, 14).getTime(); // Friday, local time
const active = () => ({ state: 'active', expiresAt: now + 60000, totalSeconds: 60, taskStatus: 'logseq.property/status.todo', owner: '', project: '', pausedSeconds: null, lastChecked: null });

test('only supported DB graphs and complete valid timer values are accepted', () => {
  assertSupported({ version: '2.0.2' }, true);
  for (const [version, db] of [['0.10.15', false], ['2.0.1', true], ['2.0.2', false], ['3.0.0', true]]) assert.throws(() => assertSupported({ version }, db));
  assert.deepEqual(parseTimer('1800000000000~600'), { expiresAt: 1800000000000, totalSeconds: 600 });
  for (const value of [null, '', '0~60', '1800000000000', 'NaN~60', '1~-1', '1~0', [1, 60]]) assert.equal(parseTimer(value), null);
  assert.equal(secondsFromMinutes(0.5), 30);
  for (const value of [Infinity, NaN, -1, 0, '5', 1e20]) assert.throws(() => secondsFromMinutes(value));
});

test('snooze, pause and cancel never force a native task status', () => {
  for (const taskStatus of ['', 'logseq.property/status.todo', 'logseq.property/status.doing']) {
    const record = { ...active(), taskStatus };
    for (const [action, options] of [['schedule', { expiresAt: now + 120000 }], ['pause', {}], ['cancel', {}], ['metadata', { owner: 'Alice' }]]) {
      assert.equal(transition(record, action, options, now).taskStatus, taskStatus);
    }
  }
  const paused = transition(active(), 'pause', {}, now + 20000);
  assert.equal(paused.pausedSeconds, 40);
  assert.equal(paused.expiresAt, null);
  assert.equal(transition(paused, 'resume', {}, now + 200000).expiresAt, now + 240000);
});

test('undo restores the preceding reminder and native status but rejects remote edits', () => {
  const before = active(), after = transition(before, 'complete', {}, now);
  const record = { ...after, history: { version: 1, events: [{ id: 'event', action: 'complete', before: snapshot(before), after: snapshot(after) }] } };
  assert.ok(canUndo(record));
  assert.deepEqual(transition(record, 'undo', {}, now), snapshot(before));
  for (const changes of [{ taskStatus: 'logseq.property/status.todo' }, { owner: 'Elsewhere' }, { expiresAt: now + 1 }]) {
    assert.equal(canUndo({ ...record, ...changes }), false);
    assert.throws(() => transition({ ...record, ...changes }, 'undo', {}, now));
  }
  assert.notEqual(recordToken(record), recordToken({ ...record, history: { version: 1, events: [] } }));
});

test('calendar presets use local 09:00 and skip weekends; grouping uses local midnight', () => {
  const tomorrow = new Date(nextMorning('tomorrow', now));
  assert.equal(tomorrow.getDay(), 6); assert.equal(tomorrow.getHours(), 9);
  const weekday = new Date(nextMorning('weekday', now));
  assert.equal(weekday.getDay(), 1); assert.equal(weekday.getHours(), 9);
  assert.equal(groupOf(active(), now), 'today');
  assert.equal(groupOf({ ...active(), expiresAt: now - 1 }, now), 'overdue');
  assert.equal(groupOf({ ...active(), taskStatus: 'logseq.property/status.done' }, now), 'history');
  assert.throws(() => transition(active(), 'schedule', { expiresAt: now - 1 }, now));
  assert.throws(() => transition(active(), 'schedule', { expiresAt: NaN }, now));
});

test('migration preflight errors never write any records', async () => {
  let writes = 0;
  const store = new DbTimerStore({ Editor: { updateBlock: async () => writes++ } });
  store.list = async () => { throw new Error('Ambiguous property'); };
  await assert.rejects(store.migrate(), /Ambiguous/);
  assert.equal(writes, 0);
});

test('changed graph, schema conflicts and deleted blocks stop writes', async () => {
  let writes = 0;
  const api = { DB: { datascriptQuery: async () => [[':number', ':db.cardinality/one']] },
    Editor: { updateBlock: async () => writes++, upsertProperty: async () => writes++ } };
  const store = new DbTimerStore(api);
  await assert.rejects(store.ensureSchema(() => {}), /schema/);
  await assert.rejects(store.ensureSchema(() => { throw new Error('Graph changed'); }), /Graph changed/);
  store.ensureSchema = async () => {}; store.get = async () => null;
  api.Editor.getBlock = async () => null;
  await assert.rejects(store.commit('id', null, active(), {}), /deleted/);
  assert.equal(writes, 0);
});

test('decorations preserve literal TODO and multiline content', () => {
  const text = 'TODO list is a title\n- nested line\ncustom:: literal';
  assert.equal(cleanTimerTitle(decorateTimerTitle(text)), text);
  assert.equal(decorateTimerTitle(decorateTimerTitle(text)), decorateTimerTitle(text));
});

test('write and verification timeouts report uncertain outcomes without retrying writes', async () => {
  for (const atVerification of [false, true]) {
    let writes = 0, reads = 0;
    const api = { Editor: { getBlock: async () => ({ title: 'Keep this' }),
      updateBlock: async () => { writes++; if (!atVerification) throw new Error('[deferred timeout] async call #5416'); } } };
    const store = new DbTimerStore(api);
    store.ensureSchema = async () => {};
    store.get = async () => { if (reads++ && atVerification) throw new Error('[deferred timeout] async call #5417'); return null; };
    await assert.rejects(store.commit('id', null, active(), { id: 'once' }), error =>
      error.writeOutcomeUnknown === true && error.bridgeTimeout === true && !error.message.includes('#5416'));
    assert.equal(writes, 1);
  }
});
