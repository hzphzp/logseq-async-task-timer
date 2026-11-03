// Maps the official 2.0.2 SDK property calls to the real database worker.
// Always creates an isolated, unsynced graph; never touches the user's graph.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PREFIX = 'plugin.property.logseq-async-task-timer/';
export const kw = value => '~:' + value;
export const uid = value => '~u' + value;
export const map = value => ['^ ', ...Object.entries(value).flatMap(([k, v]) => [kw(k), v])];
function sdk(value) {
  if (Array.isArray(value)) return value.map(sdk);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    /^(block|db)\//.test(key) ? key.split('/')[1] : ':' + key, sdk(item),
  ]));
  return value;
}
export async function worker() {
  const root = mkdtempSync(join(tmpdir(), 'async-timer-db-test-'));
  const graph = 'async-timer-test';
  const types = new Map();
  function cli(...args) {
    const response = JSON.parse(execFileSync(process.env.LOGSEQ_CLI || 'logseq', [...args,
      '--root-dir', root, '--graph', graph, '--output', 'json', '--timeout-ms', '120000'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    assert.equal(response.status, 'ok', JSON.stringify(response.error));
    return response.data;
  }
  cli('graph', 'create');
  cli('upsert', 'page', '--page', 'Timer integration');
  const server = cli('server', 'list').servers.find(s => s.graph === graph);
  async function ops(operations) {
    const response = await fetch(`${server['base-url']}/v1/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread-api/apply-outliner-ops',
        argsTransit: JSON.stringify([server.repo, operations.map(([name, args]) => [kw(name), args]), map({})]) }),
    });
    const result = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result.error));
  }
  const op = (name, args) => ops([[name, args]]);
  const query = q => cli('query', '--query', q).result;
  const api = {
    DB: { datascriptQuery: async q => sdk(query(q)) },
    Editor: {
      getBlock: async id => sdk(query(`[:find (pull ?b [*]) :where [?b :block/uuid #uuid "${id}"]]`)[0]?.[0] || null),
      upsertProperty: async (key, schema) => {
        const property = key.includes('/') ? key : PREFIX + key;
        types.set(property, schema.type);
        return op('upsert-property', [kw(property), map({ 'logseq.property/type': kw(schema.type),
          'db/cardinality': kw('db.cardinality/' + schema.cardinality),
          'logseq.property/hide?': !!schema.hide }), map({ 'property-name': key.split('/').at(-1) })]);
      },
      upsertBlockProperty: async (id, key, value) => op('set-block-property', [uid(id), kw(key), value]),
      removeBlockProperty: async (id, key) => op('remove-block-property', [uid(id), kw(key)]),
      updateBlock: async (id, title, { properties = {} } = {}) => {
        const operations = Object.entries(properties).map(([key, value]) => {
          if (value == null) return ['remove-block-property', [uid(id), kw(key)]];
          if (types.get(key) === 'number') return ['batch-set-property', [[uid(id)], kw(key), value, map({ 'entity-id?': false })]];
          return ['set-block-property', [uid(id), kw(key), typeof value === 'object' ? JSON.stringify(value) : value]];
        });
        if (operations.length) await ops(operations);
        if ((await api.Editor.getBlock(id))?.title !== title) cli('upsert', 'block', '--uuid', id, '--content', title);
      },
    },
  };
  function create(title) {
    cli('upsert', 'block', '--target-page', 'Timer integration', '--content', title);
    return query(`[:find ?id :where [?b :block/title ${JSON.stringify(title)}] [?b :block/uuid ?id]]`)[0][0];
  }
  return { root, api, cli, query, create, op, ops, close: () => cli('server', 'stop') };
}
