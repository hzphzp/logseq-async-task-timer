import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbTimerStore, assertSupported, parseTimer, cleanTimerTitle, decorateTimerTitle, recordToken,
  PREFIX, FIELDS, SCHEMA, SCHEMA_QUERY } from '../src/db-store.js';
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
  assert.ok(canUndo({ ...record, history: { version: 1, events: [{ ...record.history.events[0],
    after: Object.fromEntries(Object.entries(record.history.events[0].after).reverse()) }] } }));
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
  const api = { DB: { datascriptQuery: async () => [[{ ident: PREFIX + FIELDS.state,
    ':logseq.property/type': ':number', cardinality: ':db.cardinality/one' }]] },
    Editor: { updateBlock: async () => writes++, upsertProperty: async () => writes++ } };
  const store = new DbTimerStore(api);
  await assert.rejects(store.ensureSchema(() => {}), /schema/);
  await assert.rejects(store.ensureSchema(() => { throw new Error('Graph changed'); }), /Graph changed/);
  store.ensureSchema = async () => {}; store.readTarget = async () => ({ block: null, record: null });
  store.statusId = async () => 42;
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
    let writes = 0;
    const api = { Editor: { getBlock: async () => ({ title: 'Keep this' }),
      updateBlock: async () => { writes++; if (!atVerification) throw new Error('[deferred timeout] async call #5416'); } } };
    const store = new DbTimerStore(api);
    store.ensureSchema = async () => {};
    store.statusId = async () => 42;
    store.readTarget = async () => ({ block: { title: 'Keep this' }, record: null });
    store.get = async () => { if (atVerification) throw new Error('[deferred timeout] async call #5417'); return null; };
    await assert.rejects(store.commit('id', null, active(), { id: 'once' }), error =>
      error.writeOutcomeUnknown === true && error.bridgeTimeout === true && !error.message.includes('#5416'));
    assert.equal(writes, 1);
  }
});

test('completing a native task without a previous reminder writes Done and verifies its first history event', async () => {
  let saved = null, status = 'logseq.property/status.doing', written;
  const next = { ...active(), state: 'completed', expiresAt: null, taskStatus: 'logseq.property/status.done' };
  const event = { id: 'first-completion', action: 'complete', at: now, after: next };
  const api = { Editor: { getBlock: async () => ({ title: 'A native task' }),
    updateBlock: async (_id, _title, { properties }) => {
      written = properties;
      if (properties['logseq.property/status'] === 42) status = 'logseq.property/status.done';
      saved = { ...next, taskStatus: status, history: { version: 1, events: [event] } };
    } } };
  const store = new DbTimerStore(api);
  store.ensureSchema = async () => {};
  store.statusId = async s => { assert.equal(s, 'logseq.property/status.done'); return 42; };
  store.readTarget = async () => ({ block: { title: 'A native task' }, record: saved });
  store.get = async () => saved;
  const result = await store.commit('id', null, next, event);
  assert.equal(written['logseq.property/status'], 42);
  assert.equal(result.taskStatus, 'logseq.property/status.done');
  assert.equal(result.history.events.length, 1);
});

const schemaRows = () => Object.entries(SCHEMA).map(([key, type]) => [{
  ident: ':' + PREFIX + FIELDS[key], ':logseq.property/type': ':' + type, cardinality: ':db.cardinality/one',
}]);

test('schema preflight reads once, validates every existing field before creating missing ones, and stays graph-local', async () => {
  let reads = 0;
  const creates = [];
  const missing = new Set([FIELDS.state, FIELDS.expiresAt, FIELDS.lastChecked].map(name => ':' + PREFIX + name));
  const existing = () => schemaRows().filter(([field]) => !missing.has(field.ident));
  let rows = existing();
  const store = new DbTimerStore({ DB: { datascriptQuery: async query => {
    assert.equal(query, SCHEMA_QUERY); reads++; return rows;
  } }, Editor: { upsertProperty: async (...args) => creates.push(args) } });
  // Even when an earlier field is missing, a later malformed field prevents all writes.
  rows.at(-1)[0].cardinality = ':db.cardinality/many';
  await assert.rejects(store.ensureSchema(() => {}), /schema/);
  assert.equal(creates.length, 0);
  rows = existing();
  await store.ensureSchema(() => {});
  assert.equal(reads, 2);
  assert.deepEqual(creates, [
    [FIELDS.state, { type: 'string', cardinality: 'one', hide: true }],
    [FIELDS.expiresAt, { type: 'datetime', cardinality: 'one', hide: true }],
    [FIELDS.lastChecked, { type: 'datetime', cardinality: 'one', hide: true }],
  ]);
  await store.ensureSchema(() => {});
  assert.equal(reads, 2);
  const another = new DbTimerStore(store.api);
  await another.ensureSchema(() => {});
  assert.equal(reads, 3);
  assert.equal(creates.length, 6);
});

test('schema pull rejects existing fields with absent types or cardinalities', async () => {
  for (const absent of [':logseq.property/type', 'cardinality']) {
    const rows = schemaRows(); delete rows[0][0][absent];
    let writes = 0;
    const store = new DbTimerStore({ DB: { datascriptQuery: async () => rows },
      Editor: { upsertProperty: async () => writes++ } });
    await assert.rejects(store.ensureSchema(() => {}), /schema/);
    assert.equal(writes, 0);
  }
});

test('built-in status ID cache is per store and failed lookups never become cached', async () => {
  let reads = 0, id = 42;
  const api = { DB: { datascriptQuery: async () => { reads++; return id === null ? [] : [[id]]; } } };
  const store = new DbTimerStore(api);
  assert.equal(await store.statusId('logseq.property/status.done'), 42);
  assert.equal(await store.statusId('logseq.property/status.done'), 42);
  assert.equal(reads, 1);
  id = 43;
  assert.equal(await new DbTimerStore(api).statusId('logseq.property/status.done'), 43);
  id = null;
  await assert.rejects(store.statusId('logseq.property/status.todo'), /Missing/);
  id = 44;
  assert.equal(await store.statusId('logseq.property/status.todo'), 44);
  assert.equal(reads, 4);
  await assert.rejects(store.statusId('arbitrary/ident'), /Unknown/);
  assert.equal(reads, 4);
});

function linkedFixture() {
  const uuid = '00000000-0000-4000-8000-000000000001';
  const reference = '00000000-0000-4000-8000-000000000002';
  const initial = { ...active(), expiresAt: Date.now() + 3600000, history: { version: 1, events: [] } };
  const block = { uuid, title: `Follow up [[${reference}]]`, page: { title: 'Test page' },
    ':logseq.property/status': { ident: 'logseq.property/status.todo' } };
  for (const key of Object.keys(FIELDS)) {
    if (initial[key] == null || initial[key] === '') continue;
    block[':' + PREFIX + FIELDS[key]] = SCHEMA[key] === 'number'
      ? { ':logseq.property/value': initial[key] } : initial[key];
  }
  const calls = [], hooks = {};
  let recordReads = 0, writes = 0, title = 'Reference target';
  const api = {
    DB: { datascriptQuery: async query => {
      if (query === SCHEMA_QUERY) { calls.push('schema'); return schemaRows(); }
      if (query.includes(':find ?e :where')) { calls.push('status'); return [[42]]; }
      if (query.includes(':block/tx-id')) {
        calls.push('record'); recordReads++; hooks.onRecordRead?.(recordReads, block);
        return [[structuredClone(block)]];
      }
      assert.ok(query.includes(reference)); calls.push('title');
      return [[{ uuid: reference, title }]];
    } },
    Editor: {
      getBlock: async id => { assert.equal(id, uuid); calls.push('block'); return structuredClone(block); },
      updateBlock: async (id, nextTitle, { properties }) => {
        assert.equal(id, uuid); calls.push('write'); writes++; block.title = nextTitle;
        hooks.onWrite?.(properties);
        for (const [property, value] of Object.entries(properties)) {
          if (value == null) delete block[':' + property];
          else if (property === 'logseq.property/status') block[':logseq.property/status'] = { ident: 'logseq.property/status.done' };
          else {
            const key = Object.keys(FIELDS).find(k => PREFIX + FIELDS[k] === property);
            block[':' + property] = SCHEMA[key] === 'number' ? { ':logseq.property/value': value } : value;
          }
        }
      },
    },
  };
  return { store: new DbTimerStore(api), api, uuid, reference, calls, hooks, block,
    writes: () => writes, rename: value => { title = value; } };
}

test('native saves only send changed fields, including clearing an owner and completing a running task', async () => {
  const f = linkedFixture();
  f.block[':' + PREFIX + FIELDS.project] = 'Keep project';
  f.block[':' + PREFIX + FIELDS.owner] = 'Previous owner';
  let written;
  f.hooks.onWrite = properties => { written = properties; };

  const updated = await f.store.act(f.uuid, 'metadata', { owner: '' });
  assert.deepEqual(Object.keys(written).sort(), [PREFIX + FIELDS.history, PREFIX + FIELDS.owner].sort());
  assert.equal(written[PREFIX + FIELDS.owner], null);
  assert.equal(updated.owner, '');
  assert.equal(updated.project, 'Keep project');

  const completed = await f.store.act(f.uuid, 'complete', { expected: recordToken(updated), basis: updated });
  assert.deepEqual(Object.keys(written).sort(), [
    PREFIX + FIELDS.history, PREFIX + FIELDS.state, PREFIX + FIELDS.lastChecked,
    PREFIX + FIELDS.expiresAt, 'logseq.property/status',
  ].sort());
  assert.equal(written[PREFIX + FIELDS.expiresAt], null);
  assert.equal(completed.history.events.length, 2);
  assert.equal(completed.totalSeconds, updated.totalSeconds);
});

test('first schedule preserves its native status and removes leftover fields without redundant empty values', async () => {
  const f = linkedFixture();
  for (const key of Object.values(FIELDS)) delete f.block[':' + PREFIX + key];
  f.block[':' + PREFIX + FIELDS.pausedSeconds] = { ':logseq.property/value': 15 };
  f.store.schemaReady = true;
  let written;
  f.hooks.onWrite = properties => { written = properties; };
  const saved = await f.store.act(f.uuid, 'schedule', { expiresAt: Date.now() + 120000 });
  // Native task status makes lastChecked part of this first transition.
  assert.deepEqual(Object.keys(written).sort(), [
    PREFIX + FIELDS.history, PREFIX + FIELDS.state, PREFIX + FIELDS.expiresAt,
    PREFIX + FIELDS.totalSeconds, PREFIX + FIELDS.lastChecked, PREFIX + FIELDS.pausedSeconds,
  ].sort());
  assert.equal(written[PREFIX + FIELDS.pausedSeconds], null);
  assert.equal(saved.taskStatus, 'logseq.property/status.todo');
  assert.equal(saved.pausedSeconds, null);
});

test('linked completion keeps three authoritative reads but resolves display titles only after verified save', async () => {
  const f = linkedFixture();
  const saved = await f.store.act(f.uuid, 'complete');
  assert.deepEqual(f.calls, ['record', 'schema', 'status', 'record', 'write', 'record', 'title']);
  assert.equal(f.writes(), 1);
  assert.equal(saved.taskStatus, 'logseq.property/status.done');
  assert.equal(saved.history.events.length, 1);
  assert.equal(saved.blockContent, 'Follow up Reference target');
  assert.ok(f.block.title.includes(f.reference));
  // Display names are not cached: a rename on another device is reflected by the next read.
  f.rename('Changed reference title');
  assert.match((await f.store.get(f.uuid)).blockContent, /Changed reference title/);
});

test('raw reads skip title work and still reject a concurrent reminder edit before saving', async () => {
  const f = linkedFixture();
  const raw = await f.store.get(f.uuid, { resolveTitles: false });
  assert.ok(raw.blockContent.includes(f.reference));
  assert.deepEqual(f.calls, ['record']);
  f.calls.length = 0;
  // The first action read is #2; change the native field at the fresh commit check (#3).
  f.hooks.onRecordRead = (n, block) => { if (n === 3) block[':' + PREFIX + FIELDS.owner] = 'Edited elsewhere'; };
  await assert.rejects(f.store.act(f.uuid, 'complete'), /changed on another device/);
  assert.equal(f.writes(), 0);
  assert.deepEqual(f.calls, ['record', 'schema', 'status', 'record']);
});

test('a cached UI snapshot skips a redundant read but keeps the raw source title and post-write check', async () => {
  const f = linkedFixture();
  const basis = await f.store.get(f.uuid);
  const expected = recordToken(basis);
  assert.equal(basis.blockContent, 'Follow up Reference target');
  f.calls.length = 0;
  f.store.schemaReady = true;
  f.store.statusIds.set('logseq.property/status.done', 42);
  // A concurrent rename is editor-owned. Preserve even multiline content and UUID links.
  f.block.title = `Renamed [[${f.reference}]]\nsecond line`;
  f.block['full-title'] = 'Renamed Reference target\nsecond line';
  const saved = await f.store.act(f.uuid, 'complete', { expected, basis });
  assert.deepEqual(f.calls, ['record', 'write', 'record']);
  assert.equal(f.block.title, `Renamed [[${f.reference}]]\nsecond line`);
  assert.equal(saved.taskStatus, 'logseq.property/status.done');
});

test('a stale cached record still rejects a sync edit and exposes a recoverable conflict code', async () => {
  const f = linkedFixture();
  const basis = await f.store.get(f.uuid);
  const expected = recordToken(basis);
  f.block[':' + PREFIX + FIELDS.owner] = 'Edited on another device';
  for (const startingPoint of [basis, undefined]) {
    await assert.rejects(f.store.act(f.uuid, 'complete', { expected, basis: startingPoint }),
      error => error.code === 'REMINDER_CONFLICT');
  }
  assert.equal(f.writes(), 0);
});

test('a task with no reminder history changing status during setup rejects the first save', async () => {
  const f = linkedFixture();
  for (const key of Object.values(FIELDS)) delete f.block[':' + PREFIX + key];
  f.store.schemaReady = true;
  f.hooks.onRecordRead = (n, block) => {
    if (n === 2) block[':logseq.property/status'] = { ident: 'logseq.property/status.done' };
  };
  await assert.rejects(f.store.act(f.uuid, 'schedule', { expiresAt: Date.now() + 3600000 }),
    error => error.code === 'REMINDER_CONFLICT');
  assert.equal(f.writes(), 0);
});

test('migration accepts a complete preflight list but standalone migration still queries it', async () => {
  const f = linkedFixture();
  let lists = 0;
  f.store.list = async () => { lists++; return []; };
  assert.equal(await f.store.migrate({ records: [] }), 0);
  assert.equal(lists, 0);
  assert.equal(await f.store.migrate(), 0);
  assert.equal(lists, 1);
});

test('cold reads discover targeted legacy properties without creating schema or scanning the graph', async () => {
  const uuid = '00000000-0000-4000-8000-000000000001';
  const block = { uuid, title: 'Imported title' };
  const property = 'user.property/async-timer-migrated';
  let rows = [[block, 'async-timer/none', ''], [block, property, '1860000000000~60']];
  let queries = 0;
  const store = new DbTimerStore({ DB: { datascriptQuery: async query => {
    assert.ok(query.includes(uuid));
    queries++;
    return query.includes(':async-timer/none') ? rows : [];
  } } });
  const record = await store.get(uuid);
  assert.equal(record.property, property);
  assert.equal(record.totalSeconds, 60);
  assert.equal(queries, 2);
  rows.push([block, 'user.property/async-timer-another', '1870000000000~120']);
  await assert.rejects(store.get(uuid), /Multiple timer properties/);
  rows = [[block, 'async-timer/none', '']];
  assert.equal(await store.get(uuid), null);
  rows = { tag: 'error' };
  await assert.rejects(store.get(uuid), /Unable to query/);
});
