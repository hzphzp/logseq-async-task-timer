// Datalog pulls expose stored [[UUID]] links. Resolve only the titles needed by
// the reminder list, in indexed batches, without rewriting the original blocks.
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const refs = () => new RegExp(`\\[\\[(${UUID})\\]\\]|\\(\\((${UUID})\\)\\)`, 'gi');
const idsIn = text => [...String(text || '').matchAll(refs())].map(match => (match[1] || match[2]).toLowerCase());

export async function resolveRecordTitles(api, records) {
  const titles = new Map(), requested = new Set();
  let pending = new Set(records.flatMap(record => [...idsIn(record.blockContent), ...idsIn(record.pageName)]));
  for (let depth = 0; depth < 8 && pending.size; depth++) {
    const ids = [...pending]; pending = new Set();
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      batch.forEach(id => requested.add(id));
      const rows = await api.DB.datascriptQuery(`[:find (pull ?b [:block/uuid :block/title]) :where
        (or ${batch.map(id => `[?b :block/uuid #uuid "${id}"]`).join(' ')})]`);
      if (!Array.isArray(rows)) throw new Error('Unable to resolve reminder titles / 无法解析任务标题。');
      for (const [block] of rows) {
        if (!block?.uuid) continue;
        const title = block['full-title'] || block.fullTitle || block.title || '';
        titles.set(String(block.uuid).toLowerCase(), title);
        for (const id of idsIn(title)) if (!requested.has(id)) pending.add(id);
      }
    }
  }
  const resolve = (text, path = new Set()) => String(text || '').replace(refs(), (match, page, block) => {
    const id = (page || block).toLowerCase();
    if (path.has(id)) return `[循环引用 / cyclic: ${id.slice(0, 8)}]`;
    if (path.size >= 8) return match;
    if (!titles.has(id)) return requested.has(id) ? `[缺失引用 / missing: ${id.slice(0, 8)}]` : match;
    return resolve(titles.get(id), new Set([...path, id])).slice(0, 8000);
  });
  return records.map(record => ({ ...record, blockContent: resolve(record.blockContent), pageName: resolve(record.pageName) }));
}
