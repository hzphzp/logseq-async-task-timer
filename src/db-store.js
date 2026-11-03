import { snapshot, transition, validate, isActive, ident, isFinished, STATUS_IDENT } from './reminder.js';
import { resolveRecordTitles } from './titles.js';
export { ident, isFinished, STATUS_IDENT, secondsFromMinutes } from './reminder.js';

// Logseq 2.0.2 DB graphs only. Graph properties, never Markdown/localStorage,
// are the source of truth. Qualified idents preserve imported property identity.
export const TIMER_NAME = 'async-timer';
export const TIMER_IDENT = 'plugin.property.logseq-async-task-timer/async-timer';
export const INLINE_TIMER_RENDERER_TYPE = ':async-task-timer-controls';
const INLINE_RENDERER = `{{renderer ${INLINE_TIMER_RENDERER_TYPE}}}`;
export const PROPERTY_QUERY = `[:find ?ident
  :where [?p :db/ident ?ident]
  (or-join [?p ?ident]
    [(= ?ident :plugin.property.logseq-async-task-timer/async-timer)]
    [?p :block/title "async-timer"])]`;

export function timerQuery(property) {
  if (!/^(?:user\.property|plugin\.property\.logseq-async-task-timer)\/[\w-]+$/.test(property)) {
    throw new Error(`Unexpected timer property: ${property}`);
  }
  return `[:find (pull ?b [:block/uuid :block/title
                          {:logseq.property/status [:db/ident]}]) ?raw
    :where [?b :${property} ?v]
    (or-join [?v ?raw]
      (and [(string? ?v)] [(identity ?v) ?raw])
      (and [(number? ?v)] [?v :block/title ?raw]))]`;
}

export function parseTimer(raw) {
  if (typeof raw !== 'string' || !/^\d+~\d+$/.test(raw)) return null;
  const [expiresAt, totalSeconds] = raw.split('~').map(Number);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > 8640000000000000 ||
      !Number.isSafeInteger(totalSeconds) || totalSeconds <= 0) return null;
  return { expiresAt, totalSeconds };
}

export function cleanTimerTitle(title) {
  const lines = String(title || '').split('\n');
  // Only the plugin's own first-line decoration is managed; all other text stays.
  lines[0] = lines[0].replace(/\s*\{\{renderer\s+:async-task-timer-controls\s*\}\}/gi, '')
    .replace(/\s*⏰\s*$/, '').trimEnd();
  return lines.join('\n');
}

export function decorateTimerTitle(title) {
  const lines = cleanTimerTitle(title).split('\n');
  lines[0] = `${lines[0]} ⏰ ${INLINE_RENDERER}`;
  return lines.join('\n');
}

export function assertSupported(info, isDb) {
  const version = String(info?.version || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
  if (!isDb || !version || Number(version[1]) !== 2 ||
      (Number(version[2]) === 0 && Number(version[3]) < 2)) {
    throw new Error('Async Task Timer 2 requires Logseq 2.0.2+ (2.x) DB graphs. File graphs are not supported. / 仅支持 Logseq 2.0.2 起的 2.x 数据库图谱。');
  }
}

export const PREFIX = 'plugin.property.logseq-async-task-timer/';
export const FIELDS = {
  state: 'reminder-state', expiresAt: 'next-follow-up', totalSeconds: 'reminder-duration',
  pausedSeconds: 'paused-seconds', lastChecked: 'last-checked', owner: 'follow-up-owner',
  project: 'follow-up-project', history: 'reminder-history',
};
export const SCHEMA = {
  state: 'string', expiresAt: 'datetime', totalSeconds: 'number', pausedSeconds: 'number',
  lastChecked: 'datetime', owner: 'string', project: 'string', history: 'json',
};
const ref = key => ':' + PREFIX + FIELDS[key];
const pull = `[:block/uuid :block/title :block/tx-id
  {:block/page [:block/title :block/uuid]}
  {:logseq.property/status [:db/ident]}
  ${Object.keys(FIELDS).map(key => SCHEMA[key] === 'number'
    ? `{${ref(key)} [:logseq.property/value]}` : ref(key)).join(' ')}]`;
const blockId = uuid => {
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(uuid)) throw new Error('Invalid block UUID');
  return `#uuid "${uuid}"`;
};
export const RECORD_QUERY = `[:find (pull ?b ${pull}) :where
  (or [?b ${ref('state')}] [?b ${ref('history')}])]`;
export const recordToken = record => JSON.stringify([snapshot(record), record?.history || null]);

function nativeRecord(block) {
  const value = key => block[ref(key)];
  if (value('state') === undefined && value('history') === undefined) return null;
  let history;
  try { history = typeof value('history') === 'string' ? JSON.parse(value('history')) : value('history'); } catch (_) { /* validated below */ }
  if (history?.version !== 1 || !Array.isArray(history.events) || !history.events.every(event =>
    event && typeof event.id === 'string' && typeof event.action === 'string' && Number.isFinite(event.at) && event.after)) {
    throw new Error(`Unreadable reminder history / 提醒历史无法读取: ${block.uuid}`);
  }
  const record = { blockUuid: block.uuid, blockContent: block['full-title'] || block.title || '',
    pageName: block.page?.title || '', taskStatus: ident(block[':logseq.property/status']?.ident), history, legacy: false };
  for (const key of Object.keys(FIELDS).filter(key => key !== 'history')) {
    record[key] = SCHEMA[key] === 'number' ? value(key)?.[':logseq.property/value'] ?? null : value(key) ?? null;
  }
  record.owner ||= ''; record.project ||= '';
  return validate(record);
}

export class DbTimerStore {
  constructor(api) { this.api = api; this.schemaReady = false; }

  async properties() {
    const rows = await this.api.DB.datascriptQuery(PROPERTY_QUERY);
    if (!Array.isArray(rows)) throw new Error('Unable to query the current graph.');
    return rows.map(([key]) => ident(key)).filter(key =>
      key === TIMER_IDENT || /^user\.property\/async-timer-[\w-]+$/.test(key));
  }

  async legacyRecords(uuid = null) {
    const found = new Map();
    for (const property of await this.properties()) {
      let query = timerQuery(property);
      if (uuid) query = query.replace(':where ', `:where [?b :block/uuid ${blockId(uuid)}] `);
      const rows = await this.api.DB.datascriptQuery(query);
      if (!Array.isArray(rows)) throw new Error('Unable to query timer records.');
      for (const [block, raw] of rows) {
        const meta = parseTimer(raw);
        if (!meta || !block?.uuid) continue;
        if (found.has(block.uuid)) throw new Error(`Multiple timer properties / 存在重复计时属性: ${block.uuid}`);
        const taskStatus = ident(block[':logseq.property/status']?.ident);
        found.set(block.uuid, { blockUuid: block.uuid, blockContent: block['full-title'] || block.title || '',
          pageName: '', taskStatus, property, raw, legacy: true, ...meta,
          state: isFinished(taskStatus) ? (taskStatus.endsWith('.done') ? 'completed' : 'canceled') : 'active',
          pausedSeconds: null, lastChecked: null, owner: '', project: '', history: { version: 1, events: [] } });
      }
    }
    return [...found.values()];
  }

  async list() {
    const rows = await this.api.DB.datascriptQuery(RECORD_QUERY);
    if (!Array.isArray(rows)) throw new Error('Unable to query reminders.');
    const found = new Map(rows.map(([block]) => [block.uuid, nativeRecord(block)]));
    for (const record of await this.legacyRecords()) if (!found.has(record.blockUuid)) found.set(record.blockUuid, record);
    return resolveRecordTitles(this.api, [...found.values()].filter(Boolean));
  }

  async get(uuid) {
    const rows = await this.api.DB.datascriptQuery(`[:find (pull ?b ${pull}) :where [?b :block/uuid ${blockId(uuid)}]
      (or [?b ${ref('state')}] [?b ${ref('history')}])]`);
    if (!Array.isArray(rows)) throw new Error('Unable to query reminder.');
    const record = rows[0]?.[0] && nativeRecord(rows[0][0]);
    const result = record || (await this.legacyRecords(uuid))[0] || null;
    return result ? (await resolveRecordTitles(this.api, [result]))[0] : null;
  }

  async ensureSchema(assertCurrent) {
    if (this.schemaReady) return;
    for (const [key, type] of Object.entries(SCHEMA)) {
      const rows = await this.api.DB.datascriptQuery(`[:find ?t ?c :where [?p :db/ident ${ref(key)}]
        [?p :logseq.property/type ?t] [?p :db/cardinality ?c]]`);
      assertCurrent();
      if (!Array.isArray(rows)) throw new Error('Unable to read property schema.');
      if (rows.length) {
        if (ident(rows[0][0]) !== type || ident(rows[0][1]) !== 'db.cardinality/one') {
          throw new Error(`Conflicting reminder property schema / 提醒属性类型不匹配: ${FIELDS[key]}`);
        }
      } else await this.api.Editor.upsertProperty(FIELDS[key], {
        type, cardinality: 'one', hide: ['history', 'pausedSeconds', 'totalSeconds'].includes(key),
      });
    }
    assertCurrent();
    this.schemaReady = true;
  }

  async statusId(status) {
    if (!status) return null;
    if (!/^logseq\.property\/status\.[\w-]+$/.test(status)) throw new Error('Unknown native task status');
    const rows = await this.api.DB.datascriptQuery(`[:find ?e :where [?e :db/ident :${status}]]`);
    const id = rows?.[0]?.[0];
    if (!Number.isInteger(id)) throw new Error(`Missing native task status: ${status}`);
    return id;
  }

  async setStatus(uuid, status, assertCurrent = () => {}) {
    const id = await this.statusId('logseq.property/status.' + status);
    assertCurrent();
    await this.api.Editor.upsertBlockProperty(uuid, STATUS_IDENT, id);
  }

  async commit(uuid, before, next, event, { assertCurrent = () => {}, decorate = true } = {}) {
    validate(next);
    await this.ensureSchema(assertCurrent);
    const history = { version: 1, events: [...(before?.history?.events || []), event] };
    const properties = Object.fromEntries(Object.keys(FIELDS).map(key => [PREFIX + FIELDS[key], key === 'history' ? history : next[key] || null]));
    if (before && ident(before.taskStatus) !== ident(next.taskStatus)) properties[STATUS_IDENT] = await this.statusId(next.taskStatus);
    const current = await this.get(uuid);
    assertCurrent();
    if (recordToken(current) !== recordToken(before)) throw new Error('Reminder changed on another device; refresh and retry / 提醒已改变，请刷新后重试。');
    const block = await this.api.Editor.getBlock(uuid, { includePage: true });
    assertCurrent();
    if (!block) throw new Error('The task was deleted / 任务已被删除。');
    const title = decorate ? (isActive(next) || next.state === 'paused' ? decorateTimerTitle(block.title) : cleanTimerTitle(block.title)) : block.title;
    // Official 2.0.2 updateBlock batches all properties in one outliner transaction.
    // History and the native fields therefore cannot be saved half way through.
    await this.api.Editor.updateBlock(uuid, title, { properties });
    assertCurrent();
    const saved = await this.get(uuid);
    assertCurrent();
    if (saved?.history?.events?.at(-1)?.id !== event.id || JSON.stringify(snapshot(saved)) !== JSON.stringify(next)) {
      throw new Error('Save verification failed; refresh before retrying / 保存校验失败，请刷新后检查。');
    }
    return saved;
  }

  event(action, before, after, extra = {}) {
    return { id: globalThis.crypto.randomUUID(), at: Date.now(), action, before: snapshot(before), after: snapshot(after), ...extra };
  }

  async migrate({ assertCurrent = () => {} } = {}) {
    const records = await this.list(); // Complete preflight before the first write.
    let count = 0;
    for (const record of records.filter(r => r.legacy)) {
      assertCurrent();
      const next = snapshot(record);
      if (next.state !== 'active') next.expiresAt = null;
      await this.commit(record.blockUuid, record, next, this.event('import', record, next,
        { source: { property: record.property, value: record.raw } }), { assertCurrent, decorate: false });
      count++;
    }
    return count;
  }

  async act(uuid, action, options = {}) {
    const { assertCurrent = () => {}, expected } = options;
    let before = await this.get(uuid);
    assertCurrent();
    if (expected !== undefined && recordToken(before) !== expected) throw new Error('Reminder changed; refresh and retry / 提醒已改变，请刷新后重试。');
    if (before?.legacy) {
      const next = snapshot(before);
      if (next.state !== 'active') next.expiresAt = null;
      before = await this.commit(uuid, before, next, this.event('import', before, next,
        { source: { property: before.property, value: before.raw } }), { assertCurrent, decorate: false });
    }
    // A new reminder may be attached to an existing native task with no history yet.
    let base = before;
    if (!base) {
      const rows = await this.api.DB.datascriptQuery(`[:find ?s :where [?b :block/uuid ${blockId(uuid)}]
        [?b :logseq.property/status ?v] [?v :db/ident ?s]]`);
      assertCurrent();
      if (rows?.length) base = { ...snapshot({ state: 'canceled', totalSeconds: 1 }), taskStatus: ident(rows[0][0]) };
    }
    const next = transition(base, action, options);
    const event = this.event(action, before, next);
    // For undoing a first schedule, preserve the native status that predated it.
    if (!before && base) event.before = { ...next, state: 'canceled', expiresAt: null, lastChecked: null, taskStatus: base.taskStatus };
    return this.commit(uuid, before, next, event, { assertCurrent });
  }
}
