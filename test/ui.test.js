import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TimerView } from '../src/ui.js';
const active = id => ({ blockUuid: id, blockContent: 'Task ' + id, taskStatus: '', state: 'active', expiresAt: Date.now() + 600000,
  totalSeconds: 600, owner: 'Alice', project: 'Project A', history: { version: 1, events: [] } });
function fixture() {
  const dom = new JSDOM('<div id="app"></div>'); globalThis.document = dom.window.document;
  const records = new Map([['a', active('a')], ['b', active('b')]]); const calls = [];
  const view = new TimerView(document.getElementById('app'), { records: () => records, receipt: () => null, run: async (...args) => calls.push(args) });
  view.showPanel(); return { dom, view, records, calls, root: document.getElementById('app') };
}
test('DB refresh and countdown updates preserve typed input, focus and expanded history', () => {
  const f = fixture(); const row = f.root.querySelector('[data-uuid="a"]');
  row.querySelector('[data-action="edit"]').click();
  const input = row.querySelector('[name="owner"]'); input.value = 'Unsaved name'; input.focus();
  input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  row.querySelector('details').open = true;
  f.records.get('a').blockContent = 'Changed remotely';
  f.records.get('a').expiresAt += 1000;
  f.view.update(); f.view.tick();
  assert.equal(f.root.querySelector('[data-uuid="a"]'), row);
  assert.equal(document.activeElement, input); assert.equal(input.value, 'Unsaved name');
  assert.equal(row.querySelector('.editor').hidden, false); assert.equal(row.querySelector('details').open, true);
  assert.equal(row.querySelector('.task-title').textContent, 'Changed remotely');
  assert.match(row.querySelector('.conflict').textContent, /更新/);
});
test('search, project filtering and selection stay consistent during updates', () => {
  const f = fixture(); f.records.get('b').project = 'Project B'; f.view.update();
  const select = f.root.querySelector('#select-all'); select.checked = true; select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  assert.equal(f.view.selected.size, 2);
  const search = f.root.querySelector('#search'); search.value = 'Task a'; search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  assert.equal(f.view.visible.length, 1); assert.equal(f.view.selected.size, 1);
  f.view.project = 'Project B'; f.view.update(); assert.equal(f.view.visible.length, 0); assert.equal(f.view.selected.size, 0);
});
test('stored titles and project names cannot inject executable markup', () => {
  const f = fixture(); f.records.get('a').blockContent = '<img src=x onerror=alert(1)>';
  f.records.get('a').project = '"><img src=x>';
  f.view.update(); assert.equal(f.root.querySelectorAll('img').length, 0);
});
