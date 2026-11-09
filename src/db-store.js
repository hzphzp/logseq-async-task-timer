import { snapshot, transition, validate, isActive, ident, isFinished, STATUS_IDENT } from './reminder.js';
import { resolveRecordTitles } from './titles.js';
import { isBridgeTimeout } from './readiness.js';
export { ident, isFinished, STATUS_IDENT, secondsFromMinutes } from './reminder.js';

// Logseq 2.0.2 DB graphs only. Graph properties, never Markdown/localStorage,
// are the source of truth. Qualified idents preserve imported property identity.
export const TIMER_NAME = 'async-timer';
export const TIMER_IDENT = 'plugin.property.logseq-async-task-timer/async-timer';
export const INLINE_TIMER_RENDERER_TYPE = ':async-task-timer-controls';
const INLINE_RENDERER = `{{renderer ${INLINE_TIMER_RENDERER_TYPE}}}`;

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
export const SCHEMA_QUERY = `[:find (pull ?p [:db/ident :logseq.property/type :db/cardinality])
  :where (or ${Object.keys(FIELDS).map(key => `[?p :db/ident ${ref(key)}]`).join(' ')})]`;
const numericFields = Object.keys(SCHEMA).filter(key => SCHEMA[key] === 'number');
// Discover new imported attributes by name on every scan. Start with concrete
// title/ident lookups rather than iterating over every ident in the graph.
const listSchemaQuery = `[:find ?ident :where
  (or [?p :block/title "async-timer"] [?p :db/ident :${TIMER_IDENT}]
      ${numericFields.map(key => `[?p :db/ident ${ref(key)}]`).join(' ')})
  [?p :db/ident ?ident]]`;
function recordPull(numeric = numericFields) {
  return `[:block/uuid :block/title :block/tx-id
  {:block/page [:block/title :block/uuid]}
  {:logseq.property/status [:db/ident]}
  ${Object.keys(FIELDS).map(key => numeric.includes(key)
    ? `{${ref(key)} [:logseq.property/value]}` : ref(key)).join(' ')}]`;
}
const pull = recordPull();
const blockId = uuid => {
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(uuid)) throw new Error('Invalid block UUID');
  return `#uuid "${uuid}"`;
};
// Keep the source block even when it has no reminder yet. A legacy value may
// be a string or a property-value entity. Bind its attribute on this UUID only;
// native reminders skip the legacy branch, and no graph-wide property scan is needed.
const basicPull = `[:block/uuid :block/title {:logseq.property/status [:db/ident]} ${ref('state')} ${ref('history')}]`;
function targetQuery(uuid, pattern) {
  return `[:find (pull ?b ${pattern}) ?property ?raw
    :where [?b :block/uuid ${blockId(uuid)}]
    (or-join [?b ?property ?raw]
      (and [?b :block/uuid _] [(ground :async-timer/none) ?property] [(ground "") ?raw])
      (and (not [?b ${ref('state')}]) (not [?b ${ref('history')}])
           [?b ?property ?v]
           (or-join [?property]
             [(= ?property :${TIMER_IDENT})]
             (and [?p :db/ident ?property] [?p :block/title "async-timer"]))
           (or-join [?v ?raw]
             (and [(string? ?v)] [(identity ?v) ?raw])
             (and [(number? ?v)] [?v :block/title ?raw]))))]`;
}
function listQuery(imported, numeric) {
  const native = `(or [?b ${ref('state')}] [?b ${ref('history')}])`;
  const pattern = recordPull(numeric);
  if (!imported.length) return `[:find (pull ?b ${pattern}) :where ${native}]`;
  // Each branch uses a literal attribute, so multiple imported properties do
  // not turn [?b ?property ?v] into an unbounded scan. Read both formats in
  // one snapshot so a concurrent migration cannot make a reminder disappear.
  const attributes = imported.map(id =>
    `(and [?b :${id} ?v] [(ground :${id}) ?property])`).join(' ');
  return `[:find (pull ?b ${pattern}) ?property ?raw
    :where (or-join [?b ?property ?raw]
      (and ${native} [(ground :async-timer/native) ?property] [(ground "") ?raw])
      (and (or-join [?b ?property ?v] ${attributes})
           [(missing? $ ?b ${ref('state')})] [(missing? $ ?b ${ref('history')})]
           (or-join [?v ?raw]
             (and [(string? ?v)] [(identity ?v) ?raw])
             (and [(number? ?v)] [(get-else $ ?v :block/title "") ?raw]))))]`;
}
export const recordToken = record => JSON.stringify([snapshot(record), record?.history || null]);

function conflictError() {
  const error = new Error('Reminder changed on another device; refresh and retry / 提醒已改变，请刷新后重试。');
  error.code = 'REMINDER_CONFLICT';
  return error;
}

function saveFailure(error) {
  if (!isBridgeTimeout(error)) return error;
  const failure = new Error('Save response timed out; checking the saved result. Do not repeat this action yet. / 保存响应超时，正在确认结果，请暂勿重复操作。');
  failure.bridgeTimeout = true;
  failure.writeOutcomeUnknown = true;
  failure.cause = error;
  return failure;
}

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

function isTimerProperty(key) {
  return key === TIMER_IDENT || /^user\.property\/async-timer-[\w-]+$/.test(key);
}

function addLegacyRecord(found, block, property, raw) {
  const meta = parseTimer(raw);
  if (!meta || !block?.uuid) return;
  if (found.has(block.uuid)) throw new Error(`Multiple timer properties / 存在重复计时属性: ${block.uuid}`);
  const taskStatus = ident(block[':logseq.property/status']?.ident);
  found.set(block.uuid, { blockUuid: block.uuid, blockContent: block['full-title'] || block.title || '',
    pageName: '', taskStatus, property, raw, legacy: true, ...meta,
    state: isFinished(taskStatus) ? (taskStatus.endsWith('.done') ? 'completed' : 'canceled') : 'active',
    pausedSeconds: null, lastChecked: null, owner: '', project: '', history: { version: 1, events: [] } });
}

export class DbTimerStore {
  constructor(api) { this.api = api; this.schemaReady = false; this.statusIds = new Map(); }

  async list() {
    const schema = await this.api.DB.datascriptQuery(listSchemaQuery);
    if (!Array.isArray(schema)) throw new Error('Unable to query the current graph.');
    const idents = new Set(schema.map(([key]) => ident(key)));
    const imported = [...idents].filter(isTimerProperty);
    // A legacy-only graph has no number-valued ref attributes to pull yet.
    const numeric = numericFields.filter(key => idents.has(PREFIX + FIELDS[key]));
    const rows = await this.api.DB.datascriptQuery(listQuery(imported, numeric));
    if (!Array.isArray(rows)) throw new Error('Unable to query reminders.');
    const found = new Map();
    for (const [block, property, raw] of rows) {
      if (!property || ident(property) === 'async-timer/native') found.set(block.uuid, nativeRecord(block));
      else addLegacyRecord(found, block, ident(property), raw);
    }
    // A successful native pull establishes that the full read pattern works
    // in this graph. Schema types/cardinalities are still checked before writing.
    this.nativePullReady = numeric.length === numericFields.length && [...found.values()].some(r => r && !r.legacy);
    return resolveRecordTitles(this.api, [...found.values()]);
  }

  async readTarget(uuid) {
    // Before schema preflight, numeric properties may not exist yet. DataScript
    // permits nested pulls on them only for actual native reminders.
    const fullPull = this.schemaReady || this.nativePullReady;
    if (!fullPull) {
      const nativeRows = await this.api.DB.datascriptQuery(`[:find (pull ?b ${pull}) :where
        [?b :block/uuid ${blockId(uuid)}] (or [?b ${ref('state')}] [?b ${ref('history')}])]`);
      if (!Array.isArray(nativeRows)) throw new Error('Unable to query reminder.');
      const nativeBlock = nativeRows[0]?.[0];
      if (nativeBlock) return { block: nativeBlock, record: nativeRecord(nativeBlock) };
    }
    const rows = await this.api.DB.datascriptQuery(targetQuery(uuid, fullPull ? pull : basicPull));
    if (!Array.isArray(rows)) throw new Error('Unable to query reminder.');
    const block = rows[0]?.[0];
    if (!block) return { block: null, record: null };
    if (!fullPull && (block[ref('state')] !== undefined || block[ref('history')] !== undefined)) {
      // A remote write created a reminder between the cold lookup and fallback.
      throw conflictError();
    }
    const record = nativeRecord(block);
    if (record) return { block, record };
    const imported = new Map();
    for (const [, property, raw] of rows) {
      const key = ident(property);
      if (isTimerProperty(key)) addLegacyRecord(imported, block, key, raw);
    }
    return { block, record: imported.get(block.uuid) || null };
  }

  async get(uuid, { resolveTitles = true, withBlock = false } = {}) {
    const { record, block } = await this.readTarget(uuid);
    // The target query already returns the source block even before its first
    // reminder. Use its title rather than asking the editor to fetch children.
    const source = record || (withBlock && block ? { blockContent: block['full-title'] || block.title || '' } : null);
    const display = source && resolveTitles ? (await resolveRecordTitles(this.api, [source]))[0] : source;
    return withBlock ? { exists: !!block, record: record ? display : null, title: display?.blockContent || '' } : display;
  }

  async ensureSchema(assertCurrent) {
    if (this.schemaReady) return;
    // Check all eight fields in one host round trip. Pulls also return malformed
    // existing definitions, so missing type/cardinality cannot pass as absent.
    const rows = await this.api.DB.datascriptQuery(SCHEMA_QUERY);
    assertCurrent();
    if (!Array.isArray(rows)) throw new Error('Unable to read property schema.');
    const existing = new Map(rows.map(([property]) => [ident(property?.ident), property]));
    for (const [key, type] of Object.entries(SCHEMA)) {
      const property = existing.get(PREFIX + FIELDS[key]);
      if (property && (ident(property[':logseq.property/type']) !== type ||
          ident(property.cardinality) !== 'db.cardinality/one')) {
        throw new Error(`Conflicting reminder property schema / 提醒属性类型不匹配: ${FIELDS[key]}`);
      }
    }
    for (const [key, type] of Object.entries(SCHEMA)) {
      assertCurrent();
      if (!existing.has(PREFIX + FIELDS[key])) await this.api.Editor.upsertProperty(FIELDS[key], {
        type, cardinality: 'one', hide: ['state', 'expiresAt', 'lastChecked', 'history', 'pausedSeconds', 'totalSeconds'].includes(key),
      });
    }
    assertCurrent();
    this.schemaReady = true;
  }

  async statusId(status) {
    if (!status) return null;
    if (!/^logseq\.property\/status\.[\w-]+$/.test(status)) throw new Error('Unknown native task status');
    // A store belongs to one graph activation. Built-in status entity IDs stay
    // fixed within it; graph switches create a fresh store and a fresh cache.
    if (this.statusIds.has(status)) return this.statusIds.get(status);
    const rows = await this.api.DB.datascriptQuery(`[:find ?e :where [?e :db/ident :${status}]]`);
    const id = rows?.[0]?.[0];
    if (!Number.isInteger(id)) throw new Error(`Missing native task status: ${status}`);
    this.statusIds.set(status, id);
    return id;
  }

  async setStatus(uuid, status, assertCurrent = () => {}) {
    const id = await this.statusId('logseq.property/status.' + status);
    assertCurrent();
    await this.api.Editor.upsertBlockProperty(uuid, STATUS_IDENT, id);
  }

  async commit(uuid, before, next, event, { assertCurrent = () => {}, decorate = true, resolveTitles = true, initialStatus } = {}) {
    validate(next);
    await this.ensureSchema(assertCurrent);
    const history = { version: 1, events: [...(before?.history?.events || []), event] };
    const properties = { [PREFIX + FIELDS.history]: history };
    const expectedStatus = before ? ident(before.taskStatus) : initialStatus;
    if (expectedStatus !== ident(next.taskStatus)) properties[STATUS_IDENT] = await this.statusId(next.taskStatus);
    assertCurrent();
    // Read the source title, native status and reminder in the same snapshot.
    // The SDK's full-title expands references; only the stored title is safe to rewrite.
    const { block, record: current } = await this.readTarget(uuid);
    assertCurrent();
    if (!block) throw new Error('The task was deleted / 任务已被删除。');
    if (recordToken(current) !== recordToken(before) ||
        (expectedStatus !== undefined && expectedStatus !== ident(block[':logseq.property/status']?.ident))) {
      throw conflictError();
    }
    // The host runs an outliner operation for every supplied property, even
    // unchanged or empty ones. Compare with the actual stored fields: legacy
    // reminders also expose a logical state/duration before these fields exist.
    for (const key of Object.keys(FIELDS)) {
      if (key === 'history') continue;
      const stored = block[ref(key)];
      const value = next[key] === '' ? null : next[key] ?? null;
      const previous = SCHEMA[key] === 'number' ? stored?.[':logseq.property/value'] : stored;
      if (value === null ? stored != null : value !== previous) properties[PREFIX + FIELDS[key]] = value;
    }
    const title = decorate ? (isActive(next) || next.state === 'paused' ? decorateTimerTitle(block.title) : cleanTimerTitle(block.title)) : block.title;
    // Official 2.0.2 updateBlock batches all properties in one outliner transaction.
    // History and the native fields therefore cannot be saved half way through.
    try {
      await this.api.Editor.updateBlock(uuid, title, { properties });
    } catch (error) {
      // The host may already have committed before the response was lost.
      // Never repeat the mutation; reconnect and read the authoritative record.
      throw saveFailure(error);
    }
    assertCurrent();
    let saved;
    try { saved = await this.get(uuid, { resolveTitles: false }); } catch (error) { throw saveFailure(error); }
    assertCurrent();
    if (saved?.history?.events?.at(-1)?.id !== event.id || JSON.stringify(snapshot(saved)) !== JSON.stringify(snapshot(next))) {
      throw new Error('Save verification failed; refresh before retrying / 保存校验失败，请刷新后检查。');
    }
    try {
      const result = resolveTitles ? (await resolveRecordTitles(this.api, [saved]))[0] : saved;
      assertCurrent();
      return result;
    } catch (error) { throw saveFailure(error); }
  }

  event(action, before, after, extra = {}) {
    return { id: globalThis.crypto.randomUUID(), at: Date.now(), action, before: snapshot(before), after: snapshot(after), ...extra };
  }

  async migrate({ assertCurrent = () => {}, records } = {}) {
    records ??= await this.list(); // Complete preflight before the first write.
    let count = 0;
    for (const record of records.filter(r => r.legacy)) {
      assertCurrent();
      const next = snapshot(record);
      if (next.state !== 'active') next.expiresAt = null;
      await this.commit(record.blockUuid, record, next, this.event('import', record, next,
        { source: { property: record.property, value: record.raw } }), { assertCurrent, decorate: false, resolveTitles: false });
      count++;
    }
    return count;
  }

  async act(uuid, action, options = {}) {
    const { assertCurrent = () => {}, expected, basis } = options;
    // A displayed native record can supply the user's starting snapshot. commit()
    // still compares it to the live DB immediately before writing and verifies the result.
    const useBasis = basis?.blockUuid === uuid && basis.legacy === false &&
      expected !== undefined && recordToken(basis) === expected;
    const target = useBasis ? { record: basis } : await this.readTarget(uuid);
    assertCurrent();
    if (!useBasis && !target.block) throw new Error('The task was deleted / 任务已被删除。');
    let before = target.record;
    if (expected !== undefined && recordToken(before) !== expected) throw conflictError();
    if (before?.legacy) {
      const next = snapshot(before);
      if (next.state !== 'active') next.expiresAt = null;
      before = await this.commit(uuid, before, next, this.event('import', before, next,
        { source: { property: before.property, value: before.raw } }), { assertCurrent, decorate: false, resolveTitles: false });
    }
    // A new reminder may be attached to an existing native task with no history yet.
    const initialStatus = ident(target.block?.[':logseq.property/status']?.ident);
    let base = before;
    if (!base && initialStatus) {
      base = { ...snapshot({ state: 'canceled', totalSeconds: 1 }), taskStatus: initialStatus };
    }
    const next = transition(base, action, options);
    const event = this.event(action, before, next);
    // For undoing a first schedule, preserve the native status that predated it.
    if (!before && base) event.before = { ...next, state: 'canceled', expiresAt: null, lastChecked: null, taskStatus: base.taskStatus };
    return this.commit(uuid, before, next, event, { assertCurrent, initialStatus });
  }
}
