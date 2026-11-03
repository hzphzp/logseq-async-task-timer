export const MODES = ['active', 'paused', 'canceled', 'completed'];
export const STATUS_IDENT = 'logseq.property/status';
export const ident = value => String(value ?? '').replace(/^:/, '');
export const isFinished = status => ['logseq.property/status.done', 'logseq.property/status.canceled'].includes(ident(status));
export const isActive = record => record?.state === 'active' && !isFinished(record.taskStatus);
const time = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;

export function snapshot(record) {
  if (!record) return null;
  return { state: record.state, expiresAt: record.expiresAt ?? null,
    totalSeconds: record.totalSeconds, pausedSeconds: record.pausedSeconds ?? null,
    lastChecked: record.lastChecked ?? null, owner: record.owner || '', project: record.project || '',
    taskStatus: ident(record.taskStatus) };
}

export function validate(record) {
  if (!MODES.includes(record.state) || !Number.isSafeInteger(record.totalSeconds) || record.totalSeconds < 1 ||
      (record.state === 'active' && !time(record.expiresAt)) ||
      (record.expiresAt != null && !time(record.expiresAt)) ||
      (record.lastChecked != null && !time(record.lastChecked)) ||
      (record.state === 'paused' && (!Number.isSafeInteger(record.pausedSeconds) || record.pausedSeconds < 1)) ||
      typeof record.owner !== 'string' || typeof record.project !== 'string') {
    throw new Error('Invalid reminder properties / 提醒属性不完整，请恢复属性后重试。');
  }
  return record;
}

export function canUndo(record) {
  const last = record?.history?.events?.at(-1);
  return !!last && !['import', 'undo'].includes(last.action) &&
    JSON.stringify(snapshot(record)) === JSON.stringify(last.after);
}

export function transition(record, action, options = {}, now = Date.now()) {
  let next = snapshot(record);
  if (action === 'schedule') {
    if (!time(options.expiresAt) || options.expiresAt <= now) throw new Error('Choose a future time / 请选择未来时间。');
    if (isFinished(record?.taskStatus)) throw new Error('Reopen the task in Logseq first / 请先在 Logseq 中恢复任务状态。');
    next = { state: 'active', expiresAt: options.expiresAt,
      totalSeconds: Math.max(1, Math.ceil((options.expiresAt - now) / 1000)), pausedSeconds: null,
      lastChecked: record ? now : null, owner: record?.owner || '', project: record?.project || '',
      taskStatus: record?.taskStatus || '' };
  } else {
    if (!record) throw new Error('Reminder no longer exists / 提醒已不存在。');
    if (action === 'pause') {
      if (!isActive(record)) throw new Error('Only active reminders can be paused / 只能暂停正在运行的提醒。');
      next = { ...next, state: 'paused', pausedSeconds: Math.max(1, Math.ceil((record.expiresAt - now) / 1000)), expiresAt: null, lastChecked: now };
    } else if (action === 'resume') {
      if (record.state !== 'paused' || isFinished(record.taskStatus)) throw new Error('This reminder cannot resume / 此提醒无法恢复。');
      next = { ...next, state: 'active', expiresAt: now + record.pausedSeconds * 1000, pausedSeconds: null, lastChecked: now };
    } else if (action === 'cancel' || action === 'complete') {
      next = { ...next, state: action === 'complete' ? 'completed' : 'canceled', expiresAt: null, pausedSeconds: null, lastChecked: now };
      if (action === 'complete') next.taskStatus = 'logseq.property/status.done';
    } else if (action === 'metadata') {
      // Metadata edits deliberately leave reminder and task status unchanged.
    } else if (action === 'undo') {
      if (!canUndo(record)) throw new Error('The reminder changed; undo is no longer safe / 提醒已改变，无法撤销此操作。');
      next = record.history.events.at(-1).before || { ...next, state: 'canceled', expiresAt: null, pausedSeconds: null };
    } else throw new Error('Unknown reminder action');
  }
  for (const key of ['owner', 'project']) if (options[key] !== undefined) {
    next[key] = String(options[key]).trim();
    if (next[key].length > 120) throw new Error('Owner/project is too long (120 characters) / 负责人或项目最多 120 字。');
  }
  return validate(next);
}

export function nextMorning(kind, now = Date.now()) {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  if (kind === 'weekday') while ([0, 6].includes(date.getDay())) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function groupOf(record, now = Date.now()) {
  if (!isActive(record)) return record.state === 'paused' && !isFinished(record.taskStatus) ? 'paused' : 'history';
  if (record.expiresAt <= now) return 'overdue';
  const end = new Date(now); end.setHours(24, 0, 0, 0);
  return record.expiresAt < end.getTime() ? 'today' : 'later';
}

export function secondsFromMinutes(minutes) {
  const seconds = Math.round(minutes * 60);
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || !Number.isSafeInteger(seconds) || seconds < 1 ||
      Date.now() + seconds * 1000 > 8640000000000000) throw new Error('Enter a positive duration / 请输入大于零的有效时长。');
  return seconds;
}
