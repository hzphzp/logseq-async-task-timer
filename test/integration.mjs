import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { worker, kw, uid, map } from './worker.mjs';
import { DbTimerStore, PREFIX, FIELDS, recordToken } from '../src/db-store.js';
import { canUndo, isActive } from '../src/reminder.js';

const w = await worker();
try {
  const store = new DbTimerStore(w.api);
  const due = Date.now() + 3600000;
  assert.deepEqual(await store.list(), []);
  // New imports must be discoverable on a later refresh, even before the
  // native number schema exists. The legacy formats use strings or value nodes.
  const importedAttrs = ['user.property/async-timer-first', 'user.property/async-timer-second'];
  const legacyId = w.create('Legacy discovery fixture');
  for (const [index, attr] of importedAttrs.entries()) {
    await w.op('upsert-property', [kw(attr), map({ 'logseq.property/type': kw(index ? 'default' : 'string'),
      'db/cardinality': kw('db.cardinality/one') }), map({ 'property-name': 'async-timer' })]);
    await w.api.Editor.upsertBlockProperty(legacyId, attr, `${due}~300`);
    if (!index) {
      const [legacy] = await store.list();
      assert.equal(legacy.blockUuid, legacyId);
      assert.equal(legacy.legacy, true);
      assert.equal(legacy.totalSeconds, 300);
    }
  }
  await assert.rejects(store.list(), /Multiple timer properties/);
  await w.api.Editor.removeBlockProperty(legacyId, importedAttrs[0]);
  const id = w.create('TODO is literal text\nPreserve the second line');
  w.cli('upsert', 'block', '--target-uuid', id, '--content', 'Child stays here');
  await store.setStatus(id, 'todo');
  let record = await store.act(id, 'schedule', { expiresAt: due, owner: 'Owner', project: 'Project A' });
  assert.equal(record.taskStatus, 'logseq.property/status.todo');
  assert.equal(record.expiresAt, due);
  assert.equal(record.owner, 'Owner');
  assert.equal(record.history.events.length, 1);
  assert.equal(await store.migrate(), 1);
  // Both legacy values now coexist on an already migrated reminder. Only the
  // native record should appear in the list, alongside the first scheduled task.
  await w.api.Editor.upsertBlockProperty(legacyId, importedAttrs[0], `${due}~300`);
  const migratedList = await store.list();
  assert.equal(migratedList.length, 2);
  const migrated = migratedList.find(r => r.blockUuid === legacyId);
  assert.equal(migrated.legacy, false);
  assert.equal(migrated.history.events.length, 1);
  w.cli('remove', 'block', '--uuid', legacyId);
  const initialToken = recordToken(record);
  record = await store.act(id, 'schedule', { expiresAt: due + 10000, expected: initialToken });
  assert.equal(record.taskStatus, 'logseq.property/status.todo');
  await assert.rejects(store.act(id, 'cancel', { expected: initialToken }), /changed/);
  record = await store.act(id, 'pause');
  assert.equal(record.state, 'paused');
  assert.equal(record.expiresAt, null);
  assert.ok(record.pausedSeconds > 0);
  record = await store.act(id, 'resume');
  assert.ok(isActive(record));
  record = await store.act(id, 'cancel');
  assert.equal(record.state, 'canceled');
  assert.equal(record.expiresAt, null);
  assert.equal(record.taskStatus, 'logseq.property/status.todo');
  assert.ok(canUndo(record));
  record = await store.act(id, 'undo');
  assert.ok(isActive(record));
  assert.equal(canUndo(record), false);
  record = await store.act(id, 'complete');
  assert.equal(record.taskStatus, 'logseq.property/status.done');
  assert.equal(record.state, 'completed');
  record = await store.act(id, 'undo');
  assert.equal(record.taskStatus, 'logseq.property/status.todo');
  assert.ok(isActive(record));
  assert.equal((await new DbTimerStore(w.api).get(id)).history.events.length, 8);
  assert.equal(w.query(`[:find ?c :where [?b :block/uuid #uuid "${id}"] [?c :block/parent ?b] [?c :block/title "Child stays here"]]`).length, 1);
  assert.match((await w.api.Editor.getBlock(id)).title, /^TODO is literal text.*\nPreserve the second line$/);
  // Native UI edits are authoritative, not overwritten by an opaque JSON state.
  await w.api.Editor.upsertBlockProperty(id, PREFIX + FIELDS.expiresAt, due + 60000);
  assert.equal((await store.get(id)).expiresAt, due + 60000);
  assert.equal(canUndo(await store.get(id)), false);
  await store.act(id, 'metadata', { project: 'Changed project' });
  assert.equal((await store.get(id)).project, 'Changed project');

  const imported = 'user.property/async-timer-integration';
  await w.op('upsert-property', [kw(imported), map({ 'logseq.property/type': kw('default'),
    'db/cardinality': kw('db.cardinality/one') }), map({ 'property-name': 'async-timer' })]);
  const importedId = w.create('Imported reminder');
  const oldRaw = `${due}~900`;
  await w.api.Editor.upsertBlockProperty(importedId, imported, oldRaw);
  assert.equal((await store.get(importedId)).legacy, true);
  const importedDone = w.create('Completed imported reminder');
  await w.api.Editor.upsertBlockProperty(importedDone, imported, oldRaw);
  await store.setStatus(importedDone, 'done');
  assert.equal(await store.migrate(), 2);
  assert.equal(await store.migrate(), 0);
  record = await store.get(importedId);
  assert.equal(record.expiresAt, due);
  assert.equal(record.totalSeconds, 900);
  assert.equal(record.history.events[0].source.value, oldRaw);
  assert.equal(record.history.events[0].source.property, imported);
  assert.equal((await w.api.Editor.getBlock(importedId)).title, 'Imported reminder');
  assert.equal((await store.get(importedDone)).state, 'completed');
  assert.equal((await store.get(importedDone)).expiresAt, null);
  const plain = w.create('Plain block without a task status');
  await store.act(plain, 'schedule', { expiresAt: due });
  assert.equal((await store.get(plain)).taskStatus, '');
  await store.act(plain, 'complete');
  await store.act(plain, 'undo');
  assert.equal((await store.get(plain)).taskStatus, '');
  assert.ok(isActive(await store.get(plain)));
  // Regression: completing a native Doing task directly creates its first
  // reminder history entry and must also change the native task to Done.
  const nativeOnly = w.create('Doing task without reminder history');
  await store.setStatus(nativeOnly, 'doing');
  // Opening an untracked task in a migrated graph needs only its indexed
  // snapshot. No editor/children read or schema mutation on this path.
  let pickerReads = 0;
  const reader = new DbTimerStore({ DB: { datascriptQuery: q => {
    pickerReads++; return w.api.DB.datascriptQuery(q);
  } } });
  await reader.list(); pickerReads = 0;
  assert.deepEqual(await reader.get(nativeOnly, { withBlock: true }), {
    exists: true, record: null, title: 'Doing task without reminder history',
  });
  assert.equal(pickerReads, 1);
  assert.equal(reader.schemaReady, false, 'readable fields do not bypass write preflight');
  assert.deepEqual(await reader.get(crypto.randomUUID(), { withBlock: true }), { exists: false, record: null, title: '' });
  assert.equal(await store.get(nativeOnly), null);
  const firstCompletion = await store.act(nativeOnly, 'complete');
  assert.equal(firstCompletion.state, 'completed');
  assert.equal(firstCompletion.taskStatus, 'logseq.property/status.done');
  assert.equal(firstCompletion.history.events.length, 1);
  assert.equal(firstCompletion.history.events[0].before.taskStatus, 'logseq.property/status.doing');
  assert.ok(canUndo(firstCompletion));
  const firstUndo = await store.act(nativeOnly, 'undo');
  assert.equal(firstUndo.taskStatus, 'logseq.property/status.doing');
  assert.equal(firstUndo.state, 'canceled');
  assert.equal(firstUndo.history.events.length, 2);
  const reference = w.create('Reference target');
  const linked = w.create(`Follow up [[${reference}]]`);
  await store.act(linked, 'schedule', { expiresAt: due });
  assert.match((await store.get(linked)).blockContent, /Follow up Reference target/);
  assert.ok((await w.api.Editor.getBlock(linked)).title.includes(reference));
  w.cli('upsert', 'block', '--uuid', reference, '--content', 'Renamed reference target');
  assert.match((await store.get(linked)).blockContent, /Follow up Renamed reference target/);
  // Simulate a host write that succeeds but loses its SDK response. The plugin
  // must read the saved result later, never send the same write a second time.
  const uncertain = w.create('Lost response fixture');
  const updateBlock = w.api.Editor.updateBlock;
  let writes = 0;
  w.api.Editor.updateBlock = async (...args) => {
    writes++; await updateBlock(...args);
    throw new Error('[deferred timeout] async call #5416');
  };
  await assert.rejects(store.act(uncertain, 'schedule', { expiresAt: due }), e => e.writeOutcomeUnknown === true);
  w.api.Editor.updateBlock = updateBlock;
  assert.equal(writes, 1);
  const confirmed = await store.get(uncertain);
  assert.equal(confirmed.expiresAt, due);
  assert.equal(confirmed.history.events.length, 1);
  await store.act(importedId, 'cancel');
  assert.equal(isActive(await store.get(importedId)), false);
  assert.equal(w.query(`[:find ?title :where [?b :block/uuid #uuid "${importedId}"] [?b :${imported} ?v] [?v :block/title ?title]]`)[0][0], oldRaw);
  // Remote completion/deletion is reflected immediately, with no history erasure.
  await store.setStatus(id, 'done');
  assert.equal(isActive(await store.get(id)), false);
  await assert.rejects(store.act(id, 'undo'), /undo/);
  w.cli('remove', 'block', '--uuid', id);
  assert.equal(await store.get(id), null);
  let fixtureCount = 0;
  // Optionally verify a local read-only export of real timer values. Titles are
  // deliberately replaced with synthetic text; no user graph or sync is opened.
  if (process.env.ASYNC_TIMER_MIGRATION_FIXTURE) {
    const fixtures = JSON.parse(readFileSync(process.env.ASYNC_TIMER_MIGRATION_FIXTURE, 'utf8'));
    const pairs = [];
    for (const [index, fixture] of fixtures.entries()) {
      const target = w.create('Migration fixture ' + index);
      await w.api.Editor.upsertBlockProperty(target, imported, fixture.raw);
      if (fixture.taskStatus) await store.setStatus(target, fixture.taskStatus.split('.').at(-1));
      pairs.push([target, fixture]);
    }
    assert.equal(await store.migrate(), fixtures.length);
    assert.equal(await store.migrate(), 0);
    for (const [target, fixture] of pairs) {
      const saved = await store.get(target);
      assert.equal(saved.taskStatus, fixture.taskStatus);
      assert.equal(saved.state, fixture.state);
      assert.equal(saved.totalSeconds, fixture.totalSeconds);
      assert.equal(saved.expiresAt, fixture.state === 'active' ? fixture.expiresAt : null);
      assert.equal(saved.history.events[0].source.value, fixture.raw);
    }
    fixtureCount = fixtures.length;
  }
  const validation = w.cli('graph', 'validate').result;
  assert.equal(validation.errors, null);
  assert.deepEqual(validation['invalid-entity-ids'], []);
  console.log(JSON.stringify({ ok: true, root: w.root, migration: '2/2, idempotent, original values retained',
    lifecycle: 'schedule, snooze, pause, resume, cancel, complete, undo',
    nativeProperties: 'datetime, number, string, JSON, status', nativeEdits: true,
    historyPreserved: true, conflictsRejected: true, titleAndChildrenPreserved: true, lostWriteResponseVerified: true,
    firstNativeCompletionAndUndoVerified: true, fixtureCount, valid: true }, null, 2));
} finally { w.close(); }
