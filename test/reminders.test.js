import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Reminders, reminderTime, REMINDER_TIME_ZONE } from '../src/reminders.js';
import { Wechat } from '../src/wechat.js';
import { createApp } from '../src/server.js';

async function fixture(t, { fetcher } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-reminders-'));
  const store = new Store(path.join(root, 'private'));
  store.write('wechat', { userId: 'owner', botId: 'bot', token: 'private-test-token' });
  store.write('wechat-state', { context: 'context-test' });
  let clock = Date.parse('2026-10-29T06:59:59Z'); const requests = [];
  const wx = new Wechat(store, { active: null, tools: {}, stop() { return '已停止'; } }, { fetcher: async (url, request) => {
    requests.push(JSON.parse(request.body));
    return fetcher ? fetcher(url, request) : Response.json({ ret: 0 });
  } });
  wx.status = 'connected';
  const reminders = new Reminders(store, { getWechat: () => wx, now: () => clock });
  wx.agent.tools.reminders = reminders;
  t.after(async () => { reminders.stop(); wx.stop(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, wx, reminders, requests, now: () => clock, advance(ms) { clock += ms; } };
}

test('all absolute and relative reminders use Shanghai time and validate real future dates', async t => {
  const f = await fixture(t);
  assert.equal(REMINDER_TIME_ZONE, 'Asia/Shanghai');
  const r = f.reminders.create({ text: '总结日报', dueAt: '2026-10-29T15:00:00+08:00' });
  assert.equal(r.dueAt, '2026-10-29T07:00:00.000Z'); assert.match(r.localTime, /15:00:00.*北京时间/);
  assert.equal(r.timeZone, 'Asia/Shanghai'); assert.equal(r.userId, undefined);
  const relative = f.reminders.create({ text: '开会', afterSeconds: 600 });
  assert.equal(Date.parse(relative.dueAt), f.now() + 600000);
  assert.match(f.reminders.list().currentTime, /14:59:59.*北京时间/);
  assert.match(reminderTime('2026-10-29T16:30:00Z'), /2026.*10.*30.*00:30:00/);
  for (const dueAt of ['2026-10-29T15:00:00', '2026-10-29T14:00:00+08:00', '2027-02-29T15:00:00+08:00', '2026-13-01T15:00:00+08:00', '2026-10-29T25:00:00+08:00']) assert.throws(() => f.reminders.create({ text: 'bad', dueAt }), /时间|日期/);
  for (const afterSeconds of [0, -1, 0.5, '10', 400 * 86400]) assert.throws(() => f.reminders.create({ text: 'bad', afterSeconds }), /相对时间/);
  assert.throws(() => f.reminders.create({ text: '', afterSeconds: 10 }), /内容/);
  assert.throws(() => f.reminders.create({ text: 'bad', dueAt: r.dueAt, afterSeconds: 1 }), /不能同时/);
});

test('reminder creation needs a bound conversation and the same invocation is idempotent', async t => {
  const f = await fixture(t); const r = f.reminders.create({ text: 'test', afterSeconds: 10 }, { requestId: 'request-1' });
  assert.equal(f.reminders.create({ text: 'test', afterSeconds: 10 }, { requestId: 'request-1' }).id, r.id);
  assert.equal(new Reminders(f.store).items.length, 1);
  f.wx.account.token = ''; assert.throws(() => f.reminders.create({ text: 'test', afterSeconds: 10 }), /绑定微信/);
  f.wx.account.token = 'token'; delete f.wx.state.context;
  assert.throws(() => f.reminders.create({ text: 'test', afterSeconds: 10 }), /发一条消息/);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.store.dir, 'reminders.json'))).mode & 0o777, 0o600);
});

test('due reminders use the real WeChat sender once, without model calls, and persist accepted delivery', async t => {
  const f = await fixture(t); const r = f.reminders.create({ text: '日报总结', afterSeconds: 1 });
  await f.reminders.tick(); assert.equal(f.requests.length, 0);
  f.advance(1000); await Promise.all([f.reminders.tick(), f.reminders.tick(), f.reminders.tick()]);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].msg.to_user_id, 'owner');
  assert.equal(f.requests[0].msg.client_id, 'reminder-' + r.id + '-0');
  assert.match(f.requests[0].msg.item_list[0].text_item.text, /日报总结.*\n时间.*15:00:00.*北京时间/);
  assert.equal(f.reminders.list().reminders[0].status, 'sent');
  await f.reminders.tick(); assert.equal(f.requests.length, 1);
  const restored = new Reminders(new Store(f.store.dir), { getWechat: () => f.wx, now: f.now });
  await restored.tick(); assert.equal(f.requests.length, 1); assert.equal(restored.list().reminders[0].status, 'sent');
});

test('failed sends remain queued and retry with the same client ID after backoff', async t => {
  let succeed = false;
  const f = await fixture(t, { fetcher: async () => { if (!succeed) throw new Error('network offline'); return Response.json({}); } });
  const r = f.reminders.create({ text: 'retry', afterSeconds: 1 }); f.advance(1000);
  await f.reminders.tick(); assert.equal(f.reminders.list().reminders[0].status, 'queued');
  assert.match(f.reminders.list().reminders[0].lastError, /等待重试/);
  assert.equal(f.wx.state.outbox.length, 1); assert.equal(f.wx.reminderDelivered(r.id), undefined);
  await f.reminders.tick(); assert.equal(f.requests.length, 1);
  succeed = true; f.advance(15000); await f.reminders.tick();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].msg.client_id, f.requests[1].msg.client_id);
  assert.equal(f.wx.state.outbox.length, 0); assert.equal(f.reminders.list().reminders[0].status, 'sent');
  assert.equal(f.reminders.list().reminders[0].lastError, undefined);
});

test('restart reconciles a sent receipt even if the reminder status was not yet committed', async t => {
  const f = await fixture(t); const r = f.reminders.create({ text: 'crash window', afterSeconds: 1 }); f.advance(1000);
  const item = f.reminders.items.find(i => i.id === r.id); item.status = 'queued'; f.reminders.save();
  f.wx.queueReminder(item, f.now()); await f.wx.flush(); // Crash before Reminders records status=sent.
  const wx = new Wechat(new Store(f.store.dir), {}, { fetcher: async () => { throw new Error('must not replay'); } }); wx.status = 'connected';
  const restored = new Reminders(new Store(f.store.dir), { getWechat: () => wx, now: f.now });
  await restored.tick(); assert.equal(restored.list().reminders[0].status, 'sent'); assert.equal(f.requests.length, 1);
});

test('overdue reminders survive restart and paused connections, then send one marked catch-up notice', async t => {
  const f = await fixture(t); f.reminders.create({ text: 'wake up', afterSeconds: 1 }); f.advance(3600000);
  f.wx.status = 'stopped';
  const restored = new Reminders(new Store(f.store.dir), { getWechat: () => f.wx, now: f.now });
  await restored.tick(); assert.equal(f.requests.length, 0);
  f.wx.status = 'connected'; await restored.tick();
  assert.equal(f.requests.length, 1); assert.match(f.requests[0].msg.item_list[0].text_item.text, /补发，原定/);
  await restored.tick(); assert.equal(f.requests.length, 1);
});

test('cancel removes scheduled and queued reminders durably; sent reminders cannot be cancelled', async t => {
  const f = await fixture(t); const r = f.reminders.create({ text: 'cancel', afterSeconds: 1 });
  f.reminders.cancel(r.id); f.advance(1000); await f.reminders.tick(); assert.equal(f.requests.length, 0);
  assert.equal(new Reminders(f.store).items.find(i => i.id === r.id).status, 'cancelled');
  assert.throws(() => f.reminders.cancel('unknown'), /不存在/);
  const q = f.reminders.create({ text: 'queued cancel', afterSeconds: 1 });
  f.wx.queueReminder(f.reminders.items.find(i => i.id === q.id), f.now()); f.reminders.cancel(q.id);
  assert.equal(f.wx.state.outbox.length, 0);
  const sent = f.reminders.create({ text: 'sent', afterSeconds: 1 }); f.advance(1000); await f.reminders.tick();
  assert.throws(() => f.reminders.cancel(sent.id), /已经发送/);
});

test('in-flight sends reject cancellation and concurrent flush callers await the same receipt', async t => {
  let release, started;
  const ready = new Promise(r => { started = r; });
  const f = await fixture(t, { fetcher: async () => { started(); await new Promise(r => { release = r; }); return Response.json({}); } });
  const r = f.reminders.create({ text: 'in flight', afterSeconds: 1 }); f.advance(1000);
  const tick = f.reminders.tick(); await ready;
  assert.throws(() => f.reminders.cancel(r.id), /正在发送/);
  let resolved = false; const flushing = f.wx.flush().then(() => { resolved = true; });
  await delay(5); assert.equal(resolved, false); assert.equal(f.wx.reminderDelivered(r.id), undefined);
  release(); await Promise.all([tick, flushing]); assert.equal(f.requests.length, 1); assert.equal(resolved, true);
});

test('changing the bound owner or bot blocks old reminders; queued receipts never go to a new owner', async t => {
  const f = await fixture(t); const r = f.reminders.create({ text: 'private reminder', afterSeconds: 1 });
  f.wx.queueReminder(f.reminders.items.find(i => i.id === r.id), f.now());
  f.wx.account.userId = 'another-owner'; f.advance(1000); await f.reminders.tick(); await f.wx.flush();
  assert.equal(f.requests.length, 0); assert.equal(f.reminders.list().reminders[0].status, 'blocked');
  assert.equal(f.wx.state.outbox.length, 0);
});

test('ordinary reply queue limits cannot evict pending reminder receipts', async t => {
  const f = await fixture(t); const r = f.reminders.create({ text: 'retained reminder', afterSeconds: 1 });
  f.wx.queueReminder(f.reminders.items.find(i => i.id === r.id), f.now());
  for (let n = 0; n < 40; n++) f.wx.state.outbox.push({ id: 'normal-' + n, text: 'text' });
  f.wx.trimOutbox(); assert.equal(f.wx.state.outbox.length, 31);
  assert.equal(f.wx.state.outbox[0].reminderId, r.id);
});

test('owner-only reminder controls bypass a busy model; /stop does not delete reminders', async t => {
  const f = await fixture(t); const r = f.reminders.create({ text: 'control', afterSeconds: 10 }); f.wx.agent.active = {};
  const msg = (id, text, from_user_id = 'owner') => ({ message_id: id, from_user_id, context_token: 'ctx', item_list: [{ type: 1, text_item: { text } }] });
  await f.wx.ingest(msg('bad', '/cancel ' + r.id, 'intruder')); assert.equal(f.reminders.items[0].status, 'scheduled');
  await f.wx.ingest(msg('list', '/reminders')); assert.match(f.requests[0].msg.item_list[0].text_item.text, /control.*待提醒/);
  await f.wx.ingest(msg('stop', '/stop')); assert.equal(f.reminders.items[0].status, 'scheduled');
  await f.wx.ingest(msg('cancel', '/cancel ' + r.id)); assert.equal(f.reminders.items[0].status, 'cancelled');
});

test('model tool loop creates a durable Shanghai reminder, HTTP lists/cancels it, and scheduler starts with app', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-reminder-api-'));
  const store = new Store(path.join(root, 'private')); let calls = 0;
  const app = await createApp({ store, provider: { async complete(messages, definitions) {
    calls++; assert.match(messages[0].content, /Asia\/Shanghai/); assert.match(messages[0].content, /北京时间/);
    assert.equal(definitions.some(d => d.function.name === 'create_reminder'), true);
    if (calls === 1) return { role: 'assistant', content: null, tool_calls: [{ id: 'create-real', type: 'function', function: { name: 'create_reminder', arguments: JSON.stringify({ text: '日报总结', afterSeconds: 60 }) } }] };
    const result = JSON.parse(messages.at(-1).content); assert.equal(result.status, 'scheduled');
    return { role: 'assistant', content: `已创建：${result.localTime}，编号 ${result.id}` };
  } } });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const link = new URL(await app.listen(0));
  app.wechat.account = { token: 'test', userId: 'owner', botId: 'bot' }; app.wechat.state.context = 'ctx';
  const result = await app.agent.run('一分钟后提醒我总结日报'); assert.match(result, /已创建.*北京时间/);
  assert.ok(app.reminders.timer); assert.equal(app.reminders.items.length, 1);
  const headers = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
  const state = await (await fetch(link.origin + '/api/state', { headers })).json();
  assert.equal(state.reminders.timeZone, 'Asia/Shanghai'); assert.equal(state.reminders.reminders.length, 1);
  const cancel = await fetch(link.origin + '/api/reminders/cancel', { method: 'POST', headers, body: JSON.stringify({ id: state.reminders.reminders[0].id }) });
  assert.equal((await cancel.json()).status, 'cancelled'); assert.equal(calls, 2);
});

test('the live interval delivers a due reminder without another chat or model turn', async t => {
  const f = await fixture(t); f.reminders.create({ text: 'automatic tick', afterSeconds: 1 });
  f.reminders.start(); await f.reminders.running; f.advance(1000);
  for (let i = 0; i < 150 && f.reminders.items[0].status !== 'sent'; i++) await delay(20);
  assert.equal(f.requests.length, 1); assert.equal(f.reminders.items[0].status, 'sent');
});
