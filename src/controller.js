import { isActive } from './reminder.js';
import { isDatabaseUnavailable } from './readiness.js';

const deadlineKey = r => `${r.blockUuid}@${r.expiresAt}`;

export class ReminderController {
  constructor({ onChange = () => {}, onDue = () => {}, onBacklog = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { onChange, onDue, onBacklog, now });
    this.epoch = 0; this.graph = null; this.records = new Map(); this.handled = new Set();
    this.writes = Promise.resolve(); this.loading = null; this.lastTick = now();
    this.connectionLost = false;
  }

  assert(epoch) {
    if (epoch !== this.epoch || !this.graph) throw new Error('Graph changed; operation canceled / 图谱已切换，操作已取消。');
  }

  async activate(graph, store) {
    const epoch = ++this.epoch;
    this.graph = graph; this.store = store;
    this.connectionLost = false;
    this.records.clear(); this.handled.clear(); this.loading = null; this.lastTick = this.now();
    this.onChange();
    if (!graph) return;
    await this.writes.catch(() => {});
    this.assert(epoch);
    this.migrated = await store.migrate({ assertCurrent: () => this.assert(epoch) });
    this.assert(epoch);
    await this.refresh({ initial: true });
  }

  async refresh({ initial = false, missed = false } = {}) {
    if (!this.graph) return;
    if (this.loading) return this.loading;
    const epoch = this.epoch, store = this.store;
    const promise = (async () => {
      await this.writes.catch(() => {});
      this.assert(epoch);
      const records = await store.list();
      this.assert(epoch);
      const now = this.now(), previous = this.records;
      this.records = new Map(records.map(r => [r.blockUuid, r]));
      this.connectionLost = false;
      const due = [], backlog = [];
      for (const record of records) {
        if (!isActive(record) || record.expiresAt > now || this.handled.has(deadlineKey(record))) continue;
        this.handled.add(deadlineKey(record));
        const old = previous.get(record.blockUuid);
        if (initial || missed || now - this.lastTick > 60000 || !isActive(old) || old.expiresAt !== record.expiresAt) backlog.push(record);
        else due.push(record);
      }
      this.onChange();
      if (backlog.length && (initial || missed || now - this.lastTick > 60000)) this.onBacklog(backlog);
      for (const record of due) { this.assert(epoch); this.onDue(record); }
    })();
    this.loading = promise;
    try { await promise; }
    catch (error) { this.assert(epoch); throw error; }
    finally { if (this.loading === promise) this.loading = null; }
  }

  async tick() {
    const now = this.now(), missed = now - this.lastTick > 60000;
    const due = [...this.records.values()].some(r => isActive(r) && r.expiresAt <= now && !this.handled.has(deadlineKey(r)));
    if (due) await this.refresh({ missed });
    this.lastTick = now;
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
      try { return await store.act(uuid, action, { ...options, assertCurrent: () => this.assert(epoch) }); }
      catch (error) { this.assert(epoch); if (isDatabaseUnavailable(error)) this.connectionLost = true; throw error; }
    });
    this.writes = promise;
    const result = await promise;
    this.assert(epoch);
    // A previous scan could have read the pre-write snapshot. Finish it before re-reading.
    await this.loading?.catch(() => {});
    this.assert(epoch);
    await this.refresh();
    return result;
  }

  dispose() { ++this.epoch; this.graph = null; this.records.clear(); }
}
