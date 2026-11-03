import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationQueue, sendWecom } from '../src/notifications.js';
const record = { blockUuid: 'block', expiresAt: 1800000000000, state: 'active', taskStatus: '' };
const memory = () => { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; };

test('WeCom success requires both HTTP success and errcode zero, using the SDK proxy', async () => {
  let args;
  const api = { Net: { request: async options => { args = options; return { ok: true, status: 200, json: async () => ({ errcode: 0 }) }; } } };
  await sendWecom(api, 'https://example.invalid/test', 'test');
  assert.equal(args.retry, 0); assert.equal(args.method, 'POST'); assert.equal(args.mode, undefined);
  assert.deepEqual(args.body, { msgtype: 'markdown', markdown: { content: 'test' } });
  for (const response of [{ ok: false, status: 500 }, { ok: true, json: async () => ({ errcode: 93000, errmsg: 'secret' }) }, { ok: true, json: async () => null }]) {
    api.Net.request = async () => response;
    await assert.rejects(sendWecom(api, 'https://example.invalid/test', 'test'), error => !error.message.includes('secret'));
  }
});

test('failed deliveries retry at most three times, persist errors and can be manually retried', async () => {
  let now = 1800000000001, attempts = 0, fail = true;
  const queue = new NotificationQueue({ graph: 'a', storage: memory(), now: () => now, enabled: () => true, current: async () => record,
    send: async () => { attempts++; if (fail) throw new Error('token=secret'); } });
  assert.equal(queue.enqueue(record), true);
  for (let i = 0; i < 4; i++) { await queue.process(); now += 40000; }
  assert.equal(attempts, 3); assert.equal(queue.receipt(record).status, 'failed');
  assert.equal(queue.receipt(record).error.includes('secret'), false);
  assert.equal(queue.enqueue(record), false);
  fail = false; assert.equal(queue.enqueue(record, { manual: true }), true); await queue.process();
  assert.equal(queue.receipt(record).status, 'sent'); assert.equal(queue.enqueue(record, { manual: true }), false);
});

test('failed freshness reads are bounded, and a canceled reminder is never retried', async () => {
  let now = 1800000000001, reads = 0, sends = 0;
  const queue = new NotificationQueue({ graph: 'a', storage: memory(), now: () => now, enabled: () => true,
    current: async () => { reads++; throw new Error('Offline'); }, send: async () => sends++ });
  queue.enqueue(record);
  for (let i = 0; i < 5; i++) { await queue.process(); now += 40000; }
  assert.equal(reads, 3); assert.equal(sends, 0);
  queue.current = async () => ({ ...record, state: 'canceled' }); queue.enqueue(record, { manual: true }); await queue.process();
  assert.equal(queue.receipt(record).status, 'canceled'); assert.equal(sends, 0);
});

test('graph-scoped receipts survive restarts; interrupted work waits for manual retry', async () => {
  let now = 1800000000001, sends = 0;
  const storage = memory();
  const options = { storage, graph: 'a', now: () => now, enabled: () => true, current: async () => record, send: async () => sends++ };
  const first = new NotificationQueue(options); first.enqueue(record); first.dispose();
  const restarted = new NotificationQueue(options);
  assert.equal(restarted.receipt(record).status, 'failed'); await restarted.process(); assert.equal(sends, 0);
  restarted.enqueue(record, { manual: true }); await restarted.process(); assert.equal(sends, 1);
  assert.equal(new NotificationQueue(options).enqueue(record), false);
  assert.equal(new NotificationQueue({ ...options, graph: 'b' }).enqueue(record), true);
});

test('single-device setting and disposed graphs prevent sends', async () => {
  let enabled = false, sends = 0;
  const queue = new NotificationQueue({ storage: memory(), graph: 'a', now: () => 1800000000001, enabled: () => enabled,
    current: async () => record, send: async () => sends++ });
  assert.equal(queue.enqueue(record), false); enabled = true; queue.enqueue(record); queue.dispose(); await queue.process();
  assert.equal(sends, 0);
});
