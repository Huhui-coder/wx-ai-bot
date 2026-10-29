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
    return { ...rest, timeZone: REMINDER_TIME_ZONE, localTime: reminderTime(item.dueAt) };
  }
  list() {
    return { timeZone: REMINDER_TIME_ZONE, currentTime: reminderTime(this.now()),
      reminders: this.items.slice().sort((a, b) => Number(active(b)) - Number(active(a)) || (active(a) ? Date.parse(a.dueAt) - Date.parse(b.dueAt) : Date.parse(b.dueAt) - Date.parse(a.dueAt))).map(item => this.view(item)) };
  }
  create({ text, dueAt, afterSeconds }, { requestId } = {}) {
    if (requestId) {
      const existing = this.items.find(item => item.requestId === requestId);
      if (existing) return this.view(existing);
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('提醒内容应为 1 到 1000 字');
    if ((dueAt !== undefined) === (afterSeconds !== undefined)) throw new Error('请选择具体日期 dueAt 或相对秒数 afterSeconds，不能同时填写');
    const now = this.now();
    if (afterSeconds !== undefined && (!Number.isInteger(afterSeconds) || afterSeconds < 1 || afterSeconds * 1000 > YEAR)) throw new Error('相对时间应为 1 秒到 366 天的整数秒数');
    const when = afterSeconds !== undefined ? now + afterSeconds * 1000 : parseTime(dueAt);
    if (when <= now) throw new Error('提醒时间已经过去，请确认北京时间的日期和时刻');
    if (when - now > YEAR) throw new Error('提醒最多可提前 366 天创建');
    if (this.items.filter(active).length >= 100) throw new Error('已有 100 条未完成提醒，请先取消或等待完成');
    const { wx, userId, botId } = this.binding();
    if (!wx.state.context) throw new Error('请先在微信给 Bot 发一条消息，再创建提醒');
    const item = { id: randomUUID(), text: this.store.redact(text.trim()), dueAt: new Date(when).toISOString(),
      status: 'scheduled', createdAt: new Date(now).toISOString(), userId, botId, ...(requestId ? { requestId } : {}) };
    this.items.push(item); this.save(); this.store.event('reminder_created', this.view(item));
    return this.view(item);
  }
  cancel(id) {
    const item = this.items.find(item => item.id === id);
    if (!item) throw new Error('提醒编号不存在');
    const wx = this.getWechat?.();
    const delivered = wx?.reminderDelivered(item.id);
    if (delivered) { item.status = 'sent'; item.sentAt = delivered.at; this.save(); }
    if (item.status === 'sent') throw new Error('这条提醒已经发送，无法取消');
    if (item.status === 'cancelled') return this.view(item);
    wx?.cancelReminder(item.id);
    item.status = 'cancelled'; item.cancelledAt = new Date(this.now()).toISOString(); delete item.lastError;
    this.save(); return this.view(item);
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
      const delivered = wx.reminderDelivered(item.id);
      if (delivered) { item.status = 'sent'; item.sentAt = delivered.at; delete item.lastError; changed = true; continue; }
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
        const delivered = wx.reminderDelivered(item.id);
        if (delivered) { item.status = 'sent'; item.sentAt = delivered.at; delete item.lastError; }
      }
    } catch (e) {
      this.retryAt = this.now() + Math.min(300000, 15000 * 2 ** Math.min(this.failures++, 5));
      for (const item of this.items.filter(item => item.status === 'queued')) item.lastError = this.store.redact(e.message) + '；等待重试';
    }
    this.save();
  }
}
