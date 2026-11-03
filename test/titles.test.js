import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecordTitles } from '../src/titles.js';
const a = '00000000-0000-4000-8000-000000000002', b = '00000000-0000-4000-8000-000000000001';

test('stored page and block references resolve for the panel and notification without changing source records', async () => {
  const source = [{ blockContent: `[[${a}]]`, pageName: `(( ${b} ))` }, { blockContent: `跟进 ((${b}))`, pageName: 'Journal' }];
  const before = structuredClone(source); let calls = 0;
  const api = { DB: { datascriptQuery: async query => { calls++; return [
    ...(query.includes(a) ? [[{ uuid: a, title: `项目复盘与总结 / [[${b}]]` }]] : []),
    ...(query.includes(b) ? [[{ uuid: b, title: '项目 A' }]] : []),
  ]; } } };
  const resolved = await resolveRecordTitles(api, source);
  assert.equal(resolved[0].blockContent, '项目复盘与总结 / 项目 A');
  assert.equal(resolved[1].blockContent, '跟进 项目 A');
  assert.deepEqual(source, before); assert.equal(calls, 1);
});

test('cyclic and genuinely missing links cannot hang title rendering', async () => {
  const api = { DB: { datascriptQuery: async () => [[{ uuid: a, title: `[[${a}]]` }]] } };
  const [resolved] = await resolveRecordTitles(api, [{ blockContent: `[[${a}]] [[${b}]]` }]);
  assert.match(resolved.blockContent, /cyclic/); assert.match(resolved.blockContent, /missing/);
});

test('plain titles need no additional queries; a query failure remains visible', async () => {
  const api = { DB: { datascriptQuery: async () => { throw new Error('Offline'); } } };
  assert.equal((await resolveRecordTitles(api, [{ blockContent: '普通任务' }]))[0].blockContent, '普通任务');
  await assert.rejects(resolveRecordTitles(api, [{ blockContent: `[[${a}]]` }]), /Offline/);
});
