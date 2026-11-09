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

test('startup reuses the preflight snapshot only when migration made no changes', async () => {
  for (const migrated of [0, 1]) {
    const h = harness([]);
    const original = [item('r', 1799999999000)];
    const afterMigration = [item('r', null, { state: 'completed' })];
    let scans = 0;
    h.store.list = async () => ++scans === 1 ? original : afterMigration;
    h.store.migrate = async ({ records, assertCurrent }) => {
      assert.equal(records, original);
      assertCurrent();
      return migrated;
    };
    await h.controller.activate('a', h.store);
    assert.equal(scans, migrated ? 2 : 1);
    assert.equal(h.controller.migrated, migrated);
    assert.equal(h.controller.records.get('r').state, migrated ? 'completed' : 'active');
    assert.equal(h.backlogs.length, migrated ? 0 : 1);
    assert.deepEqual(h.alerts, []);
  }
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
test('waking long after a deadline summarizes missed reminders instead of broadcasting', async () => {
  const h = harness([item('r', 1800000010000)]);
  await h.controller.activate('a', h.store); h.advance(20 * 60 * 1000);
  await h.controller.tick(); await h.controller.refresh();
  assert.equal(h.alerts.length, 0); assert.equal(h.backlogs.length, 1);
});
test('a background tick delayed over a minute still delivers a recent deadline once', async () => {
  const h = harness([item('r', 1800000300000)]);
  await h.controller.activate('a', h.store);
  assert.equal(h.controller.nextDeadline(), 1800000300000);
  h.advance(5 * 60 * 1000 + 5000);
  await Promise.all([h.controller.tick(), h.controller.refresh()]);
  await h.controller.tick();
  assert.deepEqual(h.alerts.map(r => r.blockUuid), ['r']);
  assert.deepEqual(h.backlogs, []);
  assert.equal(h.controller.nextDeadline(), null);
});

test('first scan after a synced deadline delivers recent edits and summarizes older ones', async () => {
  const h = harness([]);
  await h.controller.activate('a', h.store);
  h.advance(90000);
  h.setRecords([item('recent', 1800000080000), item('old', 1799999990000)]);
  await h.controller.refresh();
  assert.deepEqual(h.alerts.map(r => r.blockUuid), ['recent']);
  assert.deepEqual(h.backlogs[0].map(r => r.blockUuid), ['old']);
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
  await h.controller.refresh();
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

test('verified saves update one record without waiting for an in-flight full scan', async () => {
  const h = harness([item('r', 1800000090000)]);
  await h.controller.activate('a', h.store);
  const old = structuredClone(h.controller.records.get('r'));
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let scans = 0;
  const saved = item('r', null, { state: 'completed', taskStatus: 'logseq.property/status.done' });
  h.store.list = async () => {
    scans++;
    if (scans === 1) { entered(); return new Promise(resolve => { release = () => resolve([old]); }); }
    return [saved];
  };
  h.store.act = async () => saved;
  const changes = [];
  h.controller.onChange = () => changes.push(h.controller.records.get('r')?.state);
  const background = h.controller.refresh(); await started;
  const result = await h.controller.act('r', 'complete');
  assert.equal(result, saved);
  assert.equal(h.controller.records.get('r').state, 'completed');
  assert.equal(scans, 1, 'the save must not start or await a full scan');
  release(); await background;
  assert.deepEqual(changes, ['completed', 'completed'], 'the late pre-save snapshot must never reappear');
  assert.equal(scans, 2, 'only the background scan retries its stale snapshot');
});

test('a verified save remains successful even if a background scan fails', async () => {
  const h = harness([item('r', 1800000090000)]); await h.controller.activate('a', h.store);
  const saved = item('r', null, { state: 'completed' });
  h.store.act = async () => saved;
  h.store.list = async () => { throw new Error('List unavailable'); };
  await assert.rejects(h.controller.refresh(), /List unavailable/);
  assert.equal(await h.controller.act('r', 'complete'), saved);
  assert.equal(h.controller.records.get('r'), saved);
});

test('targeted reads reflect remote deletion without scanning other reminders', async () => {
  const h = harness([item('r', 1800000090000), item('other', 1800000090000)]);
  await h.controller.activate('a', h.store);
  h.store.list = async () => { throw new Error('Must not scan'); };
  h.store.get = async () => null;
  assert.equal(await h.controller.read('r'), null);
  assert.deepEqual([...h.controller.records.keys()], ['other']);
});

test('a targeted read racing a save re-reads instead of overwriting the saved record', async () => {
  const h = harness([item('r', 1800000090000)]); await h.controller.activate('a', h.store);
  const old = h.controller.records.get('r'), saved = { ...old, state: 'paused' };
  let release, entered, reads = 0;
  const started = new Promise(resolve => { entered = resolve; });
  h.store.get = async () => {
    if (++reads === 1) { entered(); return new Promise(resolve => { release = () => resolve(old); }); }
    return saved;
  };
  h.store.act = async () => saved;
  const read = h.controller.read('r'); await started;
  await h.controller.act('r', 'pause'); release();
  assert.equal(await read, saved);
  assert.equal(h.controller.records.get('r'), saved);
});

test('a targeted read from the previous graph cannot populate the next graph', async () => {
  const h = harness([item('r', 1800000090000)]); await h.controller.activate('a', h.store);
  let release;
  h.store.get = () => new Promise(resolve => { release = resolve; });
  const read = h.controller.read('r');
  const rejected = assert.rejects(read, /Graph changed/);
  await new Promise(resolve => setImmediate(resolve));
  await h.controller.activate('b', { migrate: async () => 0, list: async () => [] });
  release(item('r', 1800000090000)); await rejected;
  assert.equal(h.controller.records.size, 0);
});
