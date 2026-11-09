import { isActive } from './reminder.js';
import { isDatabaseUnavailable } from './readiness.js';

const MAX_LIVE_LATENESS = 10 * 60 * 1000;
const deadlineKey = r => `${r.blockUuid}@${r.expiresAt}`;

export class ReminderController {
  constructor({ onChange = () => {}, onDue = () => {}, onBacklog = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { onChange, onDue, onBacklog, now });
    this.epoch = 0; this.graph = null; this.records = new Map(); this.handled = new Set();
    this.writes = Promise.resolve(); this.loading = null;
    this.connectionLost = false;
    this.revision = 0;
  }

  assert(epoch) {
    if (epoch !== this.epoch || !this.graph) throw new Error('Graph changed; operation canceled / 图谱已切换，操作已取消。');
  }

  async activate(graph, store) {
    ++this.epoch;
    this.graph = graph; this.store = store;
    this.connectionLost = false; this.revision++;
    this.records.clear(); this.handled.clear(); this.loading = null; this.activatedAt = this.now();
    this.lastListedAt = null;
    this.onChange();
    if (!graph) return;
    await this.refresh({ initial: true });
  }

  async refresh({ initial = false, maxAge = 0 } = {}) {
    if (!this.graph) return;
    if (this.loading) return this.loading;
    const age = this.now() - this.lastListedAt;
    if (maxAge && this.lastListedAt != null && !this.connectionLost && age >= 0 && age < maxAge) return;
    const epoch = this.epoch, store = this.store;
    const promise = (async () => {
      let records;
      let migrationPending = initial;
      // A list read already in flight must not roll back a verified local save
      // or a newer targeted read. Re-read in the background; actions never wait
      // for this scan to finish.
      for (;;) {
        await this.writes.catch(() => {});
        this.assert(epoch);
        const revision = this.revision;
        records = await store.list();
        this.assert(epoch);
        if (migrationPending) {
          const count = await store.migrate({ records, assertCurrent: () => this.assert(epoch) });
          this.assert(epoch);
          this.migrated = count;
          migrationPending = false;
          // A migration changes the snapshots. A read-only preflight can
          // supply the first panel and deadline reconciliation directly.
          if (count > 0) continue;
        }
        if (revision === this.revision) break;
      }
      const now = this.now();
      this.records = new Map(records.map(r => [r.blockUuid, r]));
      this.lastListedAt = now;
      this.connectionLost = false;
      const due = [], backlog = [];
      for (const record of records) {
        if (!isActive(record) || record.expiresAt > now || this.handled.has(deadlineKey(record))) continue;
        this.handled.add(deadlineKey(record));
        // A hidden window can deliver timers late even while the Mac is awake.
        // Classify the deadline itself, including updates first seen via sync.
        if (initial || record.expiresAt < this.activatedAt ||
            now - record.expiresAt > MAX_LIVE_LATENESS) backlog.push(record);
        else due.push(record);
      }
      this.onChange();
      if (backlog.length) this.onBacklog(backlog);
      for (const record of due) { this.assert(epoch); this.onDue(record); }
    })();
    this.loading = promise;
    try { await promise; }
    catch (error) { this.assert(epoch); throw error; }
    finally { if (this.loading === promise) this.loading = null; }
  }

  nextDeadline() {
    let next = null;
    for (const r of this.records.values()) {
      if (isActive(r) && !this.handled.has(deadlineKey(r)) && (next == null || r.expiresAt < next)) next = r.expiresAt;
    }
    return next;
  }

  async tick() {
    const now = this.now();
    const due = [...this.records.values()].some(r => isActive(r) && r.expiresAt <= now && !this.handled.has(deadlineKey(r)));
    if (due) await this.refresh();
  }

  async read(uuid, { withBlock = false } = {}) {
    const epoch = this.epoch, store = this.store;
    for (;;) {
      await this.writes.catch(() => {});
      this.assert(epoch);
      const revision = this.revision;
      const result = await store.get(uuid, { withBlock });
      this.assert(epoch);
      if (revision !== this.revision) continue;
      const record = withBlock ? result.record : result;
      if (record) this.records.set(uuid, record);
      else this.records.delete(uuid);
      this.revision++;
      this.onChange();
      return result;
    }
  }

  async act(uuid, action, options = {}) {
    const epoch = this.epoch, store = this.store;
    const promise = this.writes.catch(() => {}).then(async () => {
      this.assert(epoch);
      if (this.connectionLost) {
        const error = new Error('Waiting for the database to reconnect / 正在等待数据库重新连接。');
        error.bridgeTimeout = true;
        throw error;
      }
      try {
        const result = await store.act(uuid, action, {
          ...options, basis: this.records.get(uuid), assertCurrent: () => this.assert(epoch),
        });
        this.assert(epoch);
        this.records.set(uuid, result);
        this.revision++;
        this.onChange();
        return result;
      }
      catch (error) { this.assert(epoch); if (isDatabaseUnavailable(error)) this.connectionLost = true; throw error; }
    });
    this.writes = promise;
    return promise;
  }

  dispose() { ++this.epoch; this.graph = null; this.records.clear(); }
}
