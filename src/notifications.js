import { isActive } from './reminder.js';

const keyOf = record => `${record.blockUuid}@${record.expiresAt}`;
const RETRY_DELAYS = [5000, 30000];

export async function sendWecom(api, url, content, signal) {
  let address;
  try { address = new URL(url); } catch (_) { throw new Error('Invalid Webhook / Webhook 地址无效'); }
  if (address.protocol !== 'https:') throw new Error('Webhook must use HTTPS / Webhook 需要 HTTPS');
  let response;
  try {
    response = await api.Net.request({ url, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: { msgtype: 'markdown', markdown: { content } }, responseType: 'json', timeout: 8000,
      signal, retry: 0 });
  } catch (_) { throw new Error('Network error or timeout / 网络错误或超时'); }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let body;
  try { body = await response.json(); } catch (_) { throw new Error('Invalid response / 无法读取机器人响应'); }
  // Do not expose server messages, URLs or secrets in logs and local receipts.
  if (body?.errcode !== 0) throw new Error(`WeCom errcode: ${Number.isFinite(body?.errcode) ? body.errcode : 'unknown'}`);
}

export class NotificationQueue {
  constructor({ storage, graph, send, current, enabled, onChange = () => {}, now = () => Date.now() }) {
    Object.assign(this, { storage, graph, send, current, enabled, onChange, now });
    this.key = 'async-timer-delivery-v1:' + graph;
    this.queue = new Map(); this.busy = false; this.disposed = false; this.nextSend = 0;
    try { this.receipts = JSON.parse(storage.getItem(this.key) || '{}'); } catch (_) { this.receipts = {}; }
    if (!this.receipts || typeof this.receipts !== 'object' || Array.isArray(this.receipts)) this.receipts = {};
    for (const receipt of Object.values(this.receipts)) {
      if (['sending', 'retry', 'queued'].includes(receipt?.status)) {
        receipt.status = 'failed'; receipt.error = 'Interrupted; retry manually / 推送已中断，可手动重试';
      }
    }
    this.save();
  }

  save() {
    // Receipts are local delivery metadata, never the source of reminder records.
    const entries = Object.entries(this.receipts).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 1500);
    this.receipts = Object.fromEntries(entries);
    try { this.storage.setItem(this.key, JSON.stringify(this.receipts)); }
    catch (_) { this.storageError = true; }
    this.onChange();
  }

  receipt(record) { return this.receipts[keyOf(record)] || null; }

  enqueue(record, { manual = false } = {}) {
    if (this.disposed || !this.enabled() || !isActive(record) || record.expiresAt > this.now()) return false;
    const key = keyOf(record), receipt = this.receipts[key];
    if (this.queue.has(key) || receipt?.status === 'sent' || (!manual && receipt)) return false;
    this.receipts[key] = { status: 'queued', attempts: 0, at: this.now() };
    this.queue.set(key, { record, next: this.now(), attempts: 0 });
    this.save();
    return true;
  }

  async process() {
    if (this.disposed || this.busy || this.now() < this.nextSend) return;
    const entry = [...this.queue.entries()].find(([, item]) => item.next <= this.now());
    if (!entry) return;
    const [key, item] = entry;
    this.busy = true;
    item.attempts++;
    const controller = new AbortController(); this.abort = controller;
    let timeout;
    try {
      const current = await this.current(item.record.blockUuid);
      if (this.disposed) return;
      if (!this.enabled() || !isActive(current) || keyOf(current) !== key || current.expiresAt > this.now()) {
        this.queue.delete(key);
        this.receipts[key] = { status: 'canceled', attempts: item.attempts, at: this.now() };
        return;
      }
      this.receipts[key] = { status: 'sending', attempts: item.attempts, at: this.now() };
      this.save();
      await Promise.race([this.send(current, controller.signal), new Promise((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('Timeout / 请求超时')); }, 10000);
      })]);
      if (this.disposed) return;
      this.queue.delete(key);
      this.receipts[key] = { status: 'sent', attempts: item.attempts, at: this.now() };
    } catch (error) {
      if (this.disposed) return;
      // Also bound failed freshness reads; otherwise a broken graph could retry forever.
      const delay = RETRY_DELAYS[item.attempts - 1];
      if (delay) item.next = this.now() + delay;
      else this.queue.delete(key);
      this.receipts[key] = { status: delay ? 'retry' : 'failed', attempts: item.attempts,
        at: this.now(), next: delay ? item.next : null,
        error: /^HTTP \d+$|^WeCom errcode: /.test(error.message) ? error.message : 'Delivery failed / 推送失败，请检查网络和设置' };
    } finally {
      clearTimeout(timeout); this.busy = false; this.abort = null;
      this.nextSend = this.now() + 3200;
      if (!this.disposed) this.save();
    }
  }

  dispose() { this.disposed = true; this.abort?.abort(); this.queue.clear(); }
}
