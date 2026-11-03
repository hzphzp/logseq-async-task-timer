import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForDatabase } from '../src/readiness.js';

test('plugin bridge readiness does not imply DB readiness; wait through startup and then continue', async () => {
  let calls = 0, waits = 0;
  const api = { DB: { datascriptQuery: async () => {
    calls++;
    if (calls <= 2) throw new Error('db-worker has not been initialized');
    if (calls === 3) return null;
    return [[1]];
  } } };
  await waitForDatabase(api, { wait: async () => waits++ });
  assert.equal(calls, 4); assert.equal(waits, 3);
});

test('graph switching cancels startup wait before another database query', async () => {
  let changed = false, calls = 0;
  const api = { DB: { datascriptQuery: async () => { calls++; throw new Error('db-worker has not been initialized'); } } };
  await assert.rejects(waitForDatabase(api, { assertCurrent: () => { if (changed) throw new Error('Graph changed'); },
    wait: async () => { changed = true; } }), /Graph changed/);
  assert.equal(calls, 1);
});

test('readiness only retries initialization errors; timeouts are explicitly recoverable', async () => {
  const api = { DB: { datascriptQuery: async () => { throw new Error('Bad query'); } } };
  await assert.rejects(waitForDatabase(api, { wait: async () => {} }), /Bad query/);
  api.DB.datascriptQuery = async () => null;
  await assert.rejects(waitForDatabase(api, { attempts: 2, wait: async () => {} }), error => error.databaseStarting === true);
});
