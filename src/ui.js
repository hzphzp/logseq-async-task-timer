import { canUndo, groupOf, isActive, isFinished, nextMorning, secondsFromMinutes } from './reminder.js';
import { cleanTimerTitle, recordToken } from './db-store.js';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const GROUPS = { overdue: ['已到期', 'Overdue'], today: ['今天', 'Today'], later: ['以后', 'Later'], paused: ['已暂停', 'Paused'], history: ['历史', 'History'] };
const ACTIONS = { schedule: ['设置 / 延后', 'Scheduled / snoozed'], pause: ['暂停', 'Paused'], resume: ['恢复', 'Resumed'],
  cancel: ['取消提醒', 'Canceled'], complete: ['完成任务', 'Completed'], undo: ['撤销', 'Undone'], import: ['升级导入', 'Imported'], metadata: ['更新负责人 / 项目', 'Metadata changed'] };

export class TimerView {
  constructor(root, { records, receipt, run, lang = 'zh' }) {
    Object.assign(this, { root, records, receipt, run, lang });
    this.rows = new Map(); this.selected = new Set(); this.group = 'all'; this.search = ''; this.project = '';
    this.busy = false; this.mode = null; this.banner = ''; this.notice = '';
    root.addEventListener('click', event => this.click(event));
    root.addEventListener('input', event => {
      const target = event.target;
      if (target.id === 'search') { this.search = target.value; this.update(); }
      const form = target.closest('.editor'); if (form) form.dataset.dirty = 'true';
    });
    root.addEventListener('change', event => {
      const target = event.target;
      if (target.id === 'project-filter') { this.project = target.value; this.update(); }
      if (target.matches('[data-select]')) { target.checked ? this.selected.add(target.dataset.select) : this.selected.delete(target.dataset.select); this.updateSelection(); }
      if (target.id === 'select-all') {
        this.visible.filter(isActive).forEach(r => target.checked ? this.selected.add(r.blockUuid) : this.selected.delete(r.blockUuid));
        this.updateSelection();
      }
    });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.run('close');
      if (event.key === 'Enter' && event.target.matches('[name="minutes"], [name="when"]')) {
        event.preventDefault(); event.target.parentElement.querySelector('button').click();
      }
    });
  }
  t(zh, en) { return this.lang === 'zh' ? zh : en; }
  date(value) { return value ? new Date(value).toLocaleString(this.lang === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
  duration(seconds) {
    seconds = Math.max(0, Math.ceil(seconds));
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}${this.t('天', 'd')} ${Math.floor(seconds % 86400 / 3600)}${this.t('小时', 'h')}`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}${this.t('小时', 'h')} ${Math.floor(seconds % 3600 / 60)}${this.t('分', 'm')}`;
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  button(action, label, extra = '') { return `<button type="button" data-action="${action}" ${extra}>${label}</button>`; }
  editor(record) {
    return `<div class="editor" data-expected="${escapeHtml(recordToken(record))}" data-dirty="false" hidden>
      <p class="editor-hint">${this.t('下次跟进时间（保持任务原状态）', 'Next follow-up (preserves task status)')}</p>
      <div class="presets">${[5, 15, 30, 60].map(n => this.button('schedule', `${n}${this.t('分钟', ' min')}`, `data-minutes="${n}"`)).join('')}
        ${this.button('schedule', this.t('明天 09:00', 'Tomorrow 09:00'), 'data-preset="tomorrow"')}
        ${this.button('schedule', this.t('下个工作日 09:00', 'Next weekday 09:00'), 'data-preset="weekday"')}</div>
      <div class="form-grid"><label>${this.t('自定义分钟数', 'Minutes')}<span class="input-action"><input name="minutes" type="number" min="0.017" step="any" placeholder="30" aria-label="${this.t('自定义分钟数', 'Minutes')}">${this.button('schedule', this.t('设定', 'Set'), 'data-input="minutes"')}</span></label>
        <label>${this.t('指定日期和时间', 'Date and time')}<span class="input-action"><input name="when" type="datetime-local" aria-label="${this.t('指定日期和时间', 'Date and time')}">${this.button('schedule', this.t('设定', 'Set'), 'data-input="when"')}</span></label>
        <label>${this.t('负责人', 'Owner')}<input name="owner" maxlength="120" value="${escapeHtml(record?.owner || '')}"></label>
        <label>${this.t('项目', 'Project')}<input name="project" maxlength="120" value="${escapeHtml(record?.project || '')}"></label></div>
      <div class="editor-footer">${this.button('metadata', this.t('只保存负责人 / 项目', 'Save owner / project'))}${this.button('reset-form', this.t('重置输入', 'Reset inputs'))}
        <span class="conflict" role="status"></span></div>
    </div>`;
  }
  showPanel() {
    this.mode = 'panel';
    if (!this.panel) {
      const panel = document.createElement('div'); panel.className = 'overlay';
      panel.innerHTML = `<section class="dialog panel-dialog" role="dialog" aria-modal="true" aria-label="${this.t('异步任务提醒', 'Async reminders')}">
        <header><div><div class="eyebrow">ASYNC TASK TIMER · 2.1</div><h1>${this.t('下一次跟进', 'Your next follow-up')}</h1><p class="subtitle"></p></div>
          <div class="header-actions">${this.button('permission', this.t('系统通知权限', 'System notifications'))}${this.button('test', this.t('测试企业微信', 'Test WeCom'))}${this.button('close', '×', `class="close" aria-label="${this.t('关闭', 'Close')}"`)}</div></header>
        <div class="banner" role="status" hidden></div><div class="notice" role="status" hidden></div>
        <div class="filters"><input type="search" id="search" placeholder="${this.t('搜索任务、负责人或页面…', 'Search tasks, owners or pages…')}" aria-label="${this.t('搜索任务', 'Search tasks')}"><select id="project-filter" aria-label="${this.t('按项目筛选', 'Filter by project')}"></select></div>
        <nav class="tabs">${this.button('group', this.t('跟进中', 'Following up'), 'data-group="all"')}${Object.entries(GROUPS).map(([key, label]) => this.button('group', this.t(...label), `data-group="${key}"`)).join('')}</nav>
        <div class="bulk"><label><input type="checkbox" id="select-all"> ${this.t('选择当前列表', 'Select visible')}</label><span class="selection-count"></span>
          <select id="bulk-delay" aria-label="${this.t('批量延后时间', 'Bulk follow-up time')}"><option value="60">${this.t('1 小时后', 'In 1 hour')}</option><option value="tomorrow">${this.t('明天 09:00', 'Tomorrow 09:00')}</option><option value="weekday">${this.t('下个工作日 09:00', 'Next weekday 09:00')}</option></select>${this.button('bulk', this.t('批量延后', 'Snooze selected'))}</div>
        <div class="groups">${Object.entries(GROUPS).map(([key, label]) => `<section class="group" data-group-section="${key}"><h2>${this.t(...label)} <span></span></h2><div class="cards"></div></section>`).join('')}</div>
        <div class="empty" hidden>${this.t('这里没有提醒。可在任务块输入 /异步任务计时，设置下一次跟进。', 'No reminders here. Use /Async Timer on a block to schedule a follow-up.')}</div>
        <footer>${this.t('暂停与取消只影响提醒 · 关闭 Logseq 后不发送提醒 · 工作日预设按周一至周五计算', 'Pause/cancel only affect reminders · Logseq must be running · Weekdays mean Monday–Friday')}</footer>
      </section>`;
      this.panel = panel;
    }
    this.root.replaceChildren(this.panel); this.update();
  }
  showPicker(uuid, title, record) {
    this.mode = 'picker'; this.pickerUuid = uuid;
    const panel = document.createElement('div'); panel.className = 'overlay';
    panel.innerHTML = `<section class="dialog picker-dialog" role="dialog" aria-modal="true" aria-label="${this.t('设置提醒', 'Set reminder')}" data-uuid="${escapeHtml(uuid)}">
      <header><div><div class="eyebrow">ASYNC TASK TIMER</div><h1>${this.t('安排下一次跟进', 'Schedule a follow-up')}</h1></div>${this.button('close', '×', 'class="close" aria-label="Close"')}</header>
      <p class="picker-title"></p><div class="notice" role="status" hidden></div>${this.editor(record)}
      <p class="muted">${this.t('使用本机时区；设置提醒不会自动改成 Doing。', 'Uses your local timezone; scheduling does not change the task to Doing.')}</p></section>`;
    panel.querySelector('.picker-title').textContent = cleanTimerTitle(title || '');
    panel.querySelector('.editor').hidden = false;
    panel.querySelector('[data-action="metadata"]').hidden = !record;
    this.root.replaceChildren(panel);
  }
  setNotice(text, error = false) {
    this.notice = text; this.noticeError = error;
    for (const element of this.root.querySelectorAll('.notice')) { element.textContent = text; element.hidden = !text; element.classList.toggle('error', error); }
  }
  setBanner(text) { this.banner = text; this.update(); }
  row(record) {
    let row = this.rows.get(record.blockUuid);
    if (row) return row;
    row = document.createElement('article'); row.className = 'reminder-card'; row.dataset.uuid = record.blockUuid;
    row.innerHTML = `<div class="card-top"><input type="checkbox" data-select="${escapeHtml(record.blockUuid)}" aria-label="${this.t('选择提醒', 'Select reminder')}"><div class="card-main">
      ${this.button('navigate', '', 'class="task-title"')}<div class="meta"></div></div><div class="timing"><div class="clock"></div><div class="deadline"></div></div></div>
      <div class="card-bottom"><div class="delivery"></div><div class="actions">
      ${this.button('complete', this.t('完成任务', 'Complete'))}${this.button('edit', this.t('跟进 / 改时间', 'Follow up'))}
      ${this.button('pause', this.t('暂停', 'Pause'))}${this.button('resume', this.t('恢复', 'Resume'))}${this.button('cancel', this.t('取消提醒', 'Cancel reminder'))}
      ${this.button('undo', this.t('撤销上一步', 'Undo last action'))}${this.button('retry', this.t('重试推送', 'Retry push'))}</div></div>
      ${this.editor(record)}<details class="history"><summary></summary><ol></ol></details>`;
    this.rows.set(record.blockUuid, row); return row;
  }
  update() {
    if (this.mode !== 'panel' || !this.panel) return;
    const all = [...this.records().values()], now = Date.now();
    const counts = Object.fromEntries(Object.keys(GROUPS).map(key => [key, all.filter(r => groupOf(r, now) === key).length]));
    this.panel.querySelector('.subtitle').textContent = this.t(`${all.filter(isActive).length} 项待跟进 · ${counts.paused} 项暂停 · ${counts.history} 项历史`, `${all.filter(isActive).length} active · ${counts.paused} paused · ${counts.history} archived`);
    const banner = this.panel.querySelector('.banner'); banner.textContent = this.banner; banner.hidden = !this.banner;
    this.setNotice(this.notice, this.noticeError);
    const projects = [...new Set(all.map(r => r.project).filter(Boolean))].sort();
    const select = this.panel.querySelector('#project-filter');
    const options = `<option value="">${this.t('所有项目', 'All projects')}</option>` + projects.map(project => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`).join('');
    if (select.innerHTML !== options) { select.innerHTML = options; select.value = this.project; }
    if (this.project && !projects.includes(this.project)) { this.project = ''; select.value = ''; }
    for (const button of this.panel.querySelectorAll('[data-action="group"]')) {
      const key = button.dataset.group;
      button.classList.toggle('active', key === this.group); button.setAttribute('aria-pressed', String(key === this.group));
      const label = key === 'all' ? this.t('跟进中', 'Following up') : this.t(...GROUPS[key]);
      button.textContent = `${label} ${key === 'all' ? all.length - counts.history : counts[key]}`;
    }
    this.visible = all.filter(r => (this.group === 'all' ? groupOf(r, now) !== 'history' : groupOf(r, now) === this.group) &&
      (!this.project || r.project === this.project) && `${cleanTimerTitle(r.blockContent)} ${r.owner} ${r.pageName} ${r.project}`.toLocaleLowerCase().includes(this.search.toLocaleLowerCase()));
    this.visible.sort((a, b) => (a.expiresAt || Number.MAX_SAFE_INTEGER) - (b.expiresAt || Number.MAX_SAFE_INTEGER) || a.blockUuid.localeCompare(b.blockUuid));
    for (const [uuid, row] of this.rows) if (!all.some(r => r.blockUuid === uuid)) { row.remove(); this.rows.delete(uuid); }
    const visibleIds = new Set(this.visible.map(r => r.blockUuid));
    for (const [uuid, row] of this.rows) if (!visibleIds.has(uuid)) row.remove();
    for (const section of this.panel.querySelectorAll('[data-group-section]')) {
      const records = this.visible.filter(r => groupOf(r, now) === section.dataset.groupSection);
      section.hidden = !records.length; section.querySelector('h2 span').textContent = records.length;
      const cards = section.querySelector('.cards');
      let index = 0;
      for (const record of records) {
        const row = this.row(record); this.updateRow(row, record);
        // Keep the original elements (including focus, typed values and open details).
        if (cards.children[index] !== row) cards.insertBefore(row, cards.children[index] || null);
        index++;
      }
    }
    this.panel.querySelector('.empty').hidden = !!this.visible.length;
    this.updateSelection(); this.tick();
  }
  updateRow(row, record) {
    row.querySelector('.task-title').textContent = cleanTimerTitle(record.blockContent).split('\n')[0] || this.t('(无标题)', '(Untitled)');
    const nativeStatus = record.taskStatus.split('.').at(-1);
    const statuses = { todo: ['待办', 'Todo'], doing: ['进行中', 'Doing'], done: ['完成', 'Done'], canceled: ['已取消任务', 'Canceled task'] };
    const status = nativeStatus ? this.t(...(statuses[nativeStatus] || [nativeStatus, nativeStatus])) : this.t('未设置任务状态', 'No task status');
    row.querySelector('.meta').textContent = [record.project, record.owner, record.pageName, status,
      record.lastChecked ? this.t('最近检查 ', 'Last checked ') + this.date(record.lastChecked) : ''].filter(Boolean).join(' · ');
    const form = row.querySelector('.editor');
    if (form.hidden && form.dataset.dirty !== 'true') this.resetForm(form, record);
    form.querySelector('.conflict').textContent = form.dataset.expected !== recordToken(record) && !form.hidden ? this.t('记录已更新；重置输入后再保存。', 'Record changed; reset inputs before saving.') : '';
    const active = isActive(record), paused = record.state === 'paused' && !isFinished(record.taskStatus);
    row.querySelector('[data-select]').hidden = !active;
    row.querySelector('[data-action="complete"]').hidden = !(active || paused);
    row.querySelector('[data-action="pause"]').hidden = !active;
    row.querySelector('[data-action="resume"]').hidden = !paused;
    row.querySelector('[data-action="cancel"]').hidden = !(active || paused);
    row.querySelector('[data-action="undo"]').hidden = !canUndo(record);
    const receipt = this.receipt(record);
    const labels = { queued: this.t('等待推送', 'Push queued'), sending: this.t('推送中', 'Sending'), sent: this.t('企业微信已接收', 'Accepted by WeCom'),
      retry: this.t('推送失败，稍后重试', 'Push failed; retry pending'), failed: this.t('推送失败', 'Push failed'), canceled: this.t('推送已取消', 'Push canceled') };
    row.querySelector('.delivery').textContent = receipt ? `${labels[receipt.status] || ''}${['retry', 'failed'].includes(receipt.status) ? ` (${receipt.attempts}/3) · ${receipt.error}` : ''}` : '';
    row.querySelector('.delivery').classList.toggle('error', ['retry', 'failed'].includes(receipt?.status));
    row.querySelector('[data-action="retry"]').hidden = !(active && record.expiresAt <= Date.now() && receipt?.status === 'failed');
    const history = row.querySelector('.history'); const events = record.history.events;
    history.hidden = !events.length; history.querySelector('summary').textContent = this.t(`操作历史 · ${events.length}`, `History · ${events.length}`);
    const signature = events.map(event => event.id).join(',');
    if (history.dataset.signature !== signature) {
      history.dataset.signature = signature;
      history.querySelector('ol').innerHTML = events.slice().reverse().map(event => `<li><span>${escapeHtml(this.date(event.at))}</span><strong>${escapeHtml(this.t(...(ACTIONS[event.action] || [event.action, event.action])))}</strong><span>${escapeHtml(`${this.date(event.before?.expiresAt)} → ${this.date(event.after?.expiresAt)}`)}</span></li>`).join('');
    }
    for (const button of row.querySelectorAll('button')) button.disabled = this.busy || (button.dataset.action === 'edit' && isFinished(record.taskStatus));
  }
  resetForm(form, record) {
    form.dataset.dirty = 'false'; form.dataset.expected = recordToken(record);
    form.querySelector('[name="owner"]').value = record?.owner || '';
    form.querySelector('[name="project"]').value = record?.project || '';
    form.querySelector('[name="minutes"]').value = '';
    const date = new Date(record?.expiresAt || nextMorning('tomorrow'));
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    form.querySelector('[name="when"]').value = local;
    form.querySelector('.conflict').textContent = '';
  }
  updateSelection() {
    if (this.mode !== 'panel' || !this.panel) return;
    const selectable = new Set((this.visible || []).filter(isActive).map(r => r.blockUuid));
    for (const id of this.selected) if (!selectable.has(id)) this.selected.delete(id);
    this.panel.querySelector('.selection-count').textContent = this.t(`已选 ${this.selected.size} 项`, `${this.selected.size} selected`);
    const selectAll = this.panel.querySelector('#select-all'); selectAll.checked = !!selectable.size && selectable.size === this.selected.size;
    selectAll.indeterminate = this.selected.size > 0 && this.selected.size < selectable.size;
    for (const input of this.panel.querySelectorAll('[data-select]')) input.checked = this.selected.has(input.dataset.select);
    this.panel.querySelector('[data-action="bulk"]').disabled = this.busy || !this.selected.size;
    this.panel.querySelector('[data-action="test"]').disabled = this.busy;
  }
  tick() {
    if (this.mode !== 'panel') return;
    for (const record of this.visible || []) {
      const element = this.rows.get(record.blockUuid)?.querySelector('.clock'); if (!element) continue;
      const group = groupOf(record); element.classList.toggle('overdue', group === 'overdue');
      element.textContent = isActive(record)
        ? `${record.expiresAt <= Date.now() ? this.t('已到期 ', 'Overdue ') : ''}${this.duration(Math.abs(record.expiresAt - Date.now()) / 1000)}`
        : isFinished(record.taskStatus) || record.state === 'completed' ? this.t('任务已结束', 'Task finished')
          : record.state === 'paused' ? this.t('已暂停 · ', 'Paused · ') + this.duration(record.pausedSeconds)
            : this.t('已取消提醒', 'Reminder canceled');
      element.title = this.date(record.expiresAt);
      element.parentElement.querySelector('.deadline').textContent = record.expiresAt ? this.date(record.expiresAt) : '';
    }
  }
  async click(event) {
    const button = event.target.closest('button[data-action]'); if (!button || button.disabled || this.busy) return;
    const action = button.dataset.action;
    const holder = button.closest('[data-uuid]'), uuid = holder?.dataset.uuid;
    const record = this.records().get(uuid) || null;
    const form = holder?.querySelector('.editor');
    if (action === 'group') { this.group = button.dataset.group; this.update(); return; }
    if (action === 'edit') { form.hidden = !form.hidden; if (!form.hidden && form.dataset.dirty !== 'true') this.resetForm(form, record); return; }
    if (action === 'reset-form') { this.resetForm(form, record); return; }
    if (action === 'close') { this.run('close'); return; }
    this.busy = true; this.setNotice(''); this.updateSelection();
    try {
      let options = { expected: recordToken(record) };
      if (action === 'schedule' || action === 'metadata') {
        options = { expected: form.dataset.expected, owner: form.querySelector('[name="owner"]').value, project: form.querySelector('[name="project"]').value };
        if (action === 'schedule') {
          if (button.dataset.preset) options.expiresAt = nextMorning(button.dataset.preset);
          else if (button.dataset.input === 'when') options.expiresAt = new Date(form.querySelector('[name="when"]').value).getTime();
          else options.expiresAt = Date.now() + secondsFromMinutes(Number(button.dataset.minutes || form.querySelector('[name="minutes"]').value)) * 1000;
        }
      }
      if (action === 'bulk') options = { ids: [...this.selected], preset: this.panel.querySelector('#bulk-delay').value };
      await this.run(action, uuid, options);
      if (form && ['schedule', 'metadata'].includes(action)) this.resetForm(form, this.records().get(uuid));
    } catch (error) { this.setNotice(error.message || String(error), true); }
    finally { this.busy = false; this.update(); }
  }
}
