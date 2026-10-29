import { randomUUID } from 'node:crypto';

export const REMINDER_TIME_ZONE = 'Asia/Shanghai';
const YEAR = 366 * 86400000;
const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: REMINDER_TIME_ZONE, year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const active = item => ['scheduled', 'queued'].includes(item.status);
export function reminderTime(value) {
  return formatter.format(new Date(value)) + '（北京时间）';
}
function parseTime(value) {
  const parts = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!parts) throw new Error('提醒时间必须是带时区的完整日期，例如 2026-10-30T15:00:00+08:00');
  const [, y, m, d, h, min, sec, zone] = parts;
  if (+m < 1 || +m > 12 || +d < 1 || +d > new Date(Date.UTC(+y, +m, 0)).getUTCDate() || +h > 23 || +min > 59 || +sec > 59 ||
    (zone !== 'Z' && (+zone.slice(1, 3) > 14 || +zone.slice(4) > 59 || (+zone.slice(1, 3) === 14 && +zone.slice(4) !== 0)))) throw new Error('提醒日期或时间无效');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('提醒日期或时间无效');
  return ms;
}

export function repeatRule(frequency, time, weekdays) {
  if (!['daily', 'weekdays', 'weekly'].includes(frequency)) throw new Error('重复规则只支持 daily、weekdays 或 weekly');
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('重复提醒时间须为北京时间 HH:mm，例如 18:00');
  let days;
  if (frequency === 'weekly') {
    if (!Array.isArray(weekdays) || !weekdays.length || weekdays.length > 7 || weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7)) throw new Error('每周提醒须指定 weekdays，1 为周一，7 为周日');
    days = [...new Set(weekdays)].sort((a, b) => a - b);
  } else if (weekdays !== undefined) throw new Error('只有 weekly 规则需要填写 weekdays');
  return { frequency, time, ...(days ? { weekdays: days } : {}) };
}
export function nextRepeat(rule, after) {
  const shanghai = new Date(after + 8 * 3600000);
  const [hour, minute] = rule.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const local = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + offset, hour, minute));
    const weekday = local.getUTCDay() || 7;
    const when = local.getTime() - 8 * 3600000;
    const eligible = rule.frequency === 'daily' || (rule.frequency === 'weekdays' ? weekday <= 5 : rule.weekdays.includes(weekday));
    if (eligible && when > after) return new Date(when).toISOString();
  }
  throw new Error('无法计算下一次提醒时间');
}
export function repeatLabel(rule) {
  if (!rule) return '一次性提醒';
  const days = ['一', '二', '三', '四', '五', '六', '日'];
  const label = rule.frequency === 'daily' ? '每天' : rule.frequency === 'weekdays' ? '周一至周五' : '每周' + rule.weekdays.map(d => days[d - 1]).join('、');
  return label + ' ' + rule.time + '（北京时间）';
}
export const reminderDeliveryId = item => item.repeat ? `${item.id}-${Date.parse(item.dueAt)}` : item.id;

export class Reminders {
  constructor(store, { getWechat, now = Date.now } = {}) {
    this.store = store; this.getWechat = getWechat; this.now = now;
    this.items = store.read('reminders', []);
    this.retryAt = 0; this.failures = 0; this.running = null;
  }
  save() {
    const completed = this.items.filter(item => !active(item)).slice(-200);
    this.items = this.items.filter(active).concat(completed);
    this.store.write('reminders', this.items);
  }
  binding() {
    const wx = this.getWechat?.();
    if (!wx?.account.token || !wx.account.userId || !wx.account.botId) throw new Error('请先扫码绑定微信，再创建微信提醒');
    return { wx, userId: wx.account.userId, botId: wx.account.botId };
  }
  view(item) {
    const { userId, botId, requestId, ...rest } = item;
    return { ...rest, timeZone: REMINDER_TIME_ZONE, localTime: reminderTime(item.dueAt), repeatLabel: repeatLabel(item.repeat) };
  }
  list() {
    return { timeZone: REMINDER_TIME_ZONE, currentTime: reminderTime(this.now()),
      reminders: this.items.slice().sort((a, b) => Number(active(b)) - Number(active(a)) || (active(a) ? Date.parse(a.dueAt) - Date.parse(b.dueAt) : Date.parse(b.dueAt) - Date.parse(a.dueAt))).map(item => this.view(item)) };
  }
  create({ text, dueAt, afterSeconds, repeat, time, weekdays }, { requestId } = {}) {
    if (requestId) {
      const existing = this.items.find(item => item.requestId === requestId);
      if (existing) return this.view(existing);
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('提醒内容应为 1 到 1000 字');
    const now = this.now();
    const recurring = repeat !== undefined && repeat !== 'none';
    let rule, when;
    if (recurring) {
      if (dueAt !== undefined || afterSeconds !== undefined) throw new Error('重复提醒请填写 repeat 和 time，不填写 dueAt 或 afterSeconds');
      rule = repeatRule(repeat, time, weekdays); when = Date.parse(nextRepeat(rule, now));
    } else {
      if (time !== undefined || weekdays !== undefined) throw new Error('一次性提醒不使用 time 或 weekdays');
      if ((dueAt !== undefined) === (afterSeconds !== undefined)) throw new Error('请选择具体日期 dueAt 或相对秒数 afterSeconds，不能同时填写');
      if (afterSeconds !== undefined && (!Number.isInteger(afterSeconds) || afterSeconds < 1 || afterSeconds * 1000 > YEAR)) throw new Error('相对时间应为 1 秒到 366 天的整数秒数');
      when = afterSeconds !== undefined ? now + afterSeconds * 1000 : parseTime(dueAt);
    }
    if (when <= now) throw new Error('提醒时间已经过去，请确认北京时间的日期和时刻');
    if (when - now > YEAR) throw new Error('提醒最多可提前 366 天创建');
    if (this.items.filter(active).length >= 100) throw new Error('已有 100 条未完成提醒，请先取消或等待完成');
    const { wx, userId, botId } = this.binding();
    if (!wx.state.context) throw new Error('请先在微信给 Bot 发一条消息，再创建提醒');
    const item = { id: randomUUID(), text: this.store.redact(text.trim()), dueAt: new Date(when).toISOString(),
      status: 'scheduled', ...(rule ? { repeat: rule } : {}), createdAt: new Date(now).toISOString(), userId, botId, ...(requestId ? { requestId } : {}) };
    this.items.push(item); this.save(); this.store.event('reminder_created', this.view(item));
    return this.view(item);
  }
  cancel(id) {
    const item = this.items.find(item => item.id === id);
    if (!item) throw new Error('提醒编号不存在');
    const wx = this.getWechat?.();
    if (wx && this.reconcile(item, wx)) this.save();
    if (item.status === 'sent') throw new Error('这条提醒已经发送，无法取消');
    if (item.status === 'cancelled') return this.view(item);
    wx?.cancelReminder(item.id);
    item.status = 'cancelled'; item.cancelledAt = new Date(this.now()).toISOString(); delete item.lastError;
    this.save(); return this.view(item);
  }
  reconcile(item, wx) {
    const delivered = wx.reminderDelivered(reminderDeliveryId(item));
    if (!delivered) return false;
    delete item.lastError;
    if (item.repeat) {
      item.lastSentAt = delivered.at; item.lastDueAt = item.dueAt;
      item.deliveryCount = (item.deliveryCount || 0) + 1;
      item.dueAt = nextRepeat(item.repeat, Math.max(this.now(), Date.parse(item.dueAt)));
      item.status = 'scheduled';
    } else { item.status = 'sent'; item.sentAt = delivered.at; }
    return true;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(e => this.store.event('reminder_error', { error: e.message })), 1000);
    this.timer.unref();
    void this.tick().catch(e => this.store.event('reminder_error', { error: e.message }));
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async tick() {
    if (this.running) return this.running;
    this.running = this.processDue();
    try { return await this.running; } finally { this.running = null; }
  }
  async processDue() {
    const wx = this.getWechat?.(); if (!wx) return;
    let changed = false, queued = false;
    for (const item of this.items.filter(active)) {
      if (this.reconcile(item, wx)) { changed = true; continue; }
      if (Date.parse(item.dueAt) > this.now()) continue;
      if (!wx.account.token || item.userId !== wx.account.userId || item.botId !== wx.account.botId) {
        wx.cancelReminder(item.id);
        item.status = 'blocked'; item.lastError = '微信绑定已改变，未向其他账号发送；请重新创建提醒'; changed = true; continue;
      }
      if (['stopped', 'unbound', 'expired'].includes(wx.status) || !wx.state.context) continue;
      if (item.status !== 'queued') { item.status = 'queued'; changed = true; }
      wx.queueReminder(item, this.now()); queued = true;
    }
    if (changed) this.save();
    if (!queued || this.now() < this.retryAt) return;
    try {
      await wx.flush(); this.failures = 0; this.retryAt = 0;
      for (const item of this.items.filter(active)) {
        this.reconcile(item, wx);
      }
    } catch (e) {
      this.retryAt = this.now() + Math.min(300000, 15000 * 2 ** Math.min(this.failures++, 5));
      for (const item of this.items.filter(item => item.status === 'queued')) item.lastError = this.store.redact(e.message) + '；等待重试';
    }
    this.save();
  }
}
