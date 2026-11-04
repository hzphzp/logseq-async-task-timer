// logseq.ready means the plugin bridge is ready. In 2.0.2 the DB worker can
// still be starting, especially immediately after an application restart.
export const isDatabaseStarting = error => /db-worker has not been initialized/i.test(String(error?.message || error));
// SDK call numbers identify a timed-out bridge request, not a task or graph id.
export const isBridgeTimeout = error => !!error?.bridgeTimeout || /\[deferred timeout\]/i.test(String(error?.message || error));
export const isDatabaseUnavailable = error => isDatabaseStarting(error) || isBridgeTimeout(error) || !!error?.databaseStarting;
const PROBE = '[:find ?e :where [?e :db/ident :logseq.class/Root]]';

export async function waitForDatabase(api, { assertCurrent = () => {}, attempts = 60,
  wait = () => new Promise(resolve => setTimeout(resolve, 1000)), onWaiting = () => {} } = {}) {
  for (let index = 0; index < attempts; index++) {
    assertCurrent();
    try {
      const rows = await api.DB.datascriptQuery(PROBE);
      assertCurrent();
      if (Array.isArray(rows)) return;
      // During graph restoration the bridge may resolve before a repo exists.
      if (rows != null) throw new Error('Database readiness query failed / 数据库就绪检查失败。');
    } catch (error) {
      assertCurrent();
      if (!isDatabaseStarting(error)) throw error;
    }
    if (!index) onWaiting();
    if (index + 1 < attempts) await wait();
  }
  const error = new Error('Database is still starting / 数据库仍在启动，插件会自动重试。');
  error.databaseStarting = true;
  throw error;
}
