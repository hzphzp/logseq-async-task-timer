import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReminderController } from '../src/controller.js';
const item = (id, expiresAt, extra = {}) => ({ blockUuid: id, expiresAt, state: 'active', taskStatus: '', ...extra });
function harness(initial) {
  let records = initial, now = 1800000000000;
  const alerts = [], backlogs = [];
  const store = { list: async () => structuredClone(records), migrate: async () => 0,
    act: async () => { throw new Error('Save failed'); } };
  const controller = new ReminderController({ now: () => now, onDue: r => alerts.push(r), onBacklog: r => backlogs.push(r) });
  return { controller, store, alerts, backlogs, setRecords: r => { records = r; }, advance: ms => { now += ms; } };
}
test('restart summarizes old deadlines, excludes completed tasks and sends no backlog', async () => {
  const h = harness([item('past', 1799999999000), item('done', 1799999999000, { taskStatus: 'logseq.property/status.done' })]);
  await h.controller.activate('a', h.store);
  assert.equal(h.alerts.length, 0); assert.equal(h.backlogs[0].length, 1);
  await h.controller.refresh(); await h.controller.tick();
  assert.equal(h.alerts.length, 0); assert.equal(h.backlogs.length, 1);
});
test('live deadline alerts exactly once; remote completion, deletion and extension suppress it', async () => {
  for (const replacement of [null, [], [item('r', 1800000001000, { taskStatus: 'logseq.property/status.done' })], [item('r', 1800000050000)]]) {
    const h = harness([item('r', 1800000001000)]);
    await h.controller.activate('a', h.store); h.advance(2000);
    if (replacement) h.setRecords(replacement);
    await h.controller.tick(); await h.controller.refresh();
    assert.equal(h.alerts.length, replacement === null ? 1 : 0);
  }
});
test('waking from sleep summarizes missed reminders instead of broadcasting', async () => {
  const h = harness([item('r', 1800000010000)]);
  await h.controller.activate('a', h.store); h.advance(120000);
  await h.controller.tick(); await h.controller.refresh();
  assert.equal(h.alerts.length, 0); assert.equal(h.backlogs.length, 1);
});
test('failed saves never create in-memory timers', async () => {
  const h = harness([]); await h.controller.activate('a', h.store);
  await assert.rejects(h.controller.act('r', 'schedule'), /Save failed/);
  assert.equal(h.controller.records.size, 0);
});
test('switching graphs cancels queued writes and rejects stale reads', async () => {
  const h = harness([item('old', 1800000090000)]); await h.controller.activate('a', h.store);
  let release, started;
  const wait = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let writes = 0;
  h.store.act = async (id, action, { assertCurrent }) => { started(); await wait; assertCurrent(); writes++; };
  const operation = h.controller.act('old', 'schedule');
  const rejected = assert.rejects(operation, /Graph changed/);
  await entered; h.setRecords([]);
  const switchGraph = h.controller.activate('b', h.store); release();
  await rejected; await switchGraph;
  assert.equal(writes, 0); assert.equal(h.controller.graph, 'b'); assert.equal(h.controller.records.size, 0);
});

test('a timed-out write stops queued mutations until a fresh authoritative read succeeds', async () => {
  const h = harness([item('r', 1800000090000)]); await h.controller.activate('a', h.store);
  let writes = 0;
  h.store.act = async () => { writes++; throw new Error('[deferred timeout] async call #5416'); };
  const results = await Promise.allSettled([h.controller.act('r', 'pause'), h.controller.act('r', 'cancel')]);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(writes, 1); assert.equal(h.controller.connectionLost, true);
  assert.equal(h.controller.records.get('r').state, 'active');
  h.setRecords([item('r', null, { state: 'paused' })]);
  await h.controller.refresh({ missed: true });
  assert.equal(h.controller.connectionLost, false);
  assert.equal(h.controller.records.get('r').state, 'paused');
  assert.equal(writes, 1);
});

test('a late timeout from an old graph does not disconnect the new graph', async () => {
  const h = harness([item('old', 1800000090000)]); await h.controller.activate('a', h.store);
  let reject;
  h.store.list = () => new Promise((_, fail) => { reject = fail; });
  const scan = h.controller.refresh();
  const rejected = assert.rejects(scan, /Graph changed/);
  await new Promise(resolve => setImmediate(resolve));
  await h.controller.activate('b', { migrate: async () => 0, list: async () => [item('new', 1800000090000)] });
  reject(new Error('[deferred timeout] async call #5416'));
  await rejected;
  assert.equal(h.controller.connectionLost, false);
  assert.deepEqual([...h.controller.records.keys()], ['new']);
});
