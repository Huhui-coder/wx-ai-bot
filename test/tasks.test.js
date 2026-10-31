import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Processes } from '../src/processes.js';
import { Skills } from '../src/skills.js';
import { Tools } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { Wechat } from '../src/wechat.js';
import { Reminders, nextRepeat, repeatLabel, repeatRule } from '../src/reminders.js';
import { commandAllowed, commandPrefixes, suggestedPrefix } from '../src/grants.js';
import { createApp } from '../src/server.js';

const quote = value => "'" + String(value).replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
const shellCommand = (program, args) => (process.platform === 'win32' ? '& ' : '') + [program, ...args].map(quote).join(' ');
const reply = content => ({ role: 'assistant', content });
const call = (name, args, id = name) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const message = (text, id = text) => ({ message_id: id, from_user_id: 'owner', context_token: 'ctx', item_list: [{ type: 1, text_item: { text } }] });

async function fixture(t, script = () => reply('完成')) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-tasks-')));
  const store = new Store(path.join(root, 'private')); store.saveConfig({ workspace: root });
  store.write('wechat', { userId: 'owner', botId: 'bot', token: 'test-token' });
  let clock = Date.parse('2026-10-30T00:00:00Z'), wx; const sent = [], prompts = [], calls = [];
  const processes = new Processes();
  const reminders = new Reminders(store, { getWechat: () => wx, now: () => clock });
  const tools = new Tools(store, new Skills(store.dir, processes), processes, reminders, { getWechat: () => wx });
  const provider = { async complete(messages) { prompts.push(messages); return script(messages, prompts.length - 1); } };
  const agent = new Agent(store, provider, tools);
  const make = () => {
    wx = new Wechat(store, agent, { fetcher: async (url, request) => { sent.push(JSON.parse(request.body).msg.item_list[0].text_item.text); return Response.json({}); } });
    wx.status = 'connected'; wx.state.context ||= 'ctx'; return wx;
  };
  make();
  t.after(async () => { reminders.stop(); wx.stop(); processes.stopAll(); await fs.rm(root, { recursive: true, force: true }); });
  const settle = async () => { for (let i = 0; i < 200 && (wx.draining || agent.active || wx.state.inbox.some(j => j.status === 'pending')); i++) await delay(5); };
  return { root, store, tools, agent, reminders, processes, sent, prompts, calls, settle, make, get wx() { return wx; }, advance(ms) { clock += ms; }, now: () => clock };
}
const allowCreate = f => ({ signal: new AbortController().signal, owner: 'wechat', notify: async event => { f.tools.decide(event.id, true); } });

test('command prefixes cover plain commands only, so chaining can never ride along', () => {
  const allowed = ['npm test', 'git status'];
  for (const command of ['npm test', 'npm test --watch', '  git status  ']) assert.equal(commandAllowed(command, allowed), true, command);
  for (const command of ['npm testing', 'npm test; rm -rf ~', 'npm test && curl evil', 'npm test | sh', 'npm test > /etc/hosts', 'npm test $(whoami)', 'npm test `whoami`', 'npm test\nrm -rf ~', 'git status & calc', 'rm -rf ~', '', undefined])
    assert.equal(commandAllowed(command, allowed), false, String(command));
  assert.equal(suggestedPrefix('npm test --watch'), 'npm test');
  assert.equal(suggestedPrefix('rm -rf build'), 'rm -rf build');
  assert.equal(suggestedPrefix('npm test; rm x'), '');
  assert.deepEqual(commandPrefixes([' npm test ', '', 'npm test']), ['npm test']);
  assert.throws(() => commandPrefixes(['npm test; rm']), /不能包含/);
});

test('saved prefixes skip approval; everything else still asks', async t => {
  const f = await fixture(t); f.store.saveConfig({ allowedCommands: ['node --version'] });
  let asked = 0;
  const context = { signal: new AbortController().signal, owner: 'local', notify: async event => { asked++; f.tools.decide(event.id, false); } };
  await f.tools.execute('run_command', { command: 'node --version' }, context);
  assert.equal(asked, 0);
  await assert.rejects(f.tools.execute('run_command', { command: 'node --version; echo x' }, context), /未获得授权/);
  await assert.rejects(f.tools.execute('capture_screen', {}, context), /未获得授权/);
  assert.equal(asked, 2);
});

test('WeChat words approve the single pending request; ordinary chat is not hijacked', async t => {
  let step = 0;
  const f = await fixture(t, () => step++ ? reply('写好了') : call('write_file', { path: 'a.txt', content: '内容' }));
  await f.wx.ingest(message('写个文件')); const draining = f.wx.drain();
  for (let i = 0; i < 100 && !f.tools.approvals().length; i++) await delay(5);
  assert.equal(f.sent[0], '收到指令，正在处理。');
  assert.match(f.sent[1], /需要授权/); assert.match(f.sent[1], /写入 a\.txt/); assert.match(f.sent[1], /同意/);
  await f.wx.ingest(message('好的。', 'yes'));
  await draining; await f.settle();
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), '内容');
  assert.ok(f.sent.includes('已允许本次操作'));
  assert.equal(f.sent.at(-1), '写好了');
  // With nothing pending, "好的" is just a message for the model.
  await f.wx.ingest(message('好的', 'later')); await f.wx.drain(); await f.settle();
  assert.equal(f.store.history.filter(m => m.role === 'user').at(-1).content, '好的');
});

test('"始终" grants one prefix for this conversation and /new clears it', async t => {
  const f = await fixture(t); const ask = [];
  const context = { signal: new AbortController().signal, owner: 'wechat', notify: async event => { ask.push(event); f.tools.decide(event.id, true, true); } };
  await f.tools.execute('run_command', { command: 'node --version' }, context);
  assert.equal(ask[0].scope, 'node --version');
  await f.tools.execute('run_command', { command: 'node --version --x' }, context);
  assert.equal(ask.length, 1);
  await f.tools.execute('run_command', { command: 'node --help' }, context);
  assert.equal(ask.length, 2);
  f.agent.reset();
  await f.tools.execute('run_command', { command: 'node --version' }, context);
  assert.equal(ask.length, 3);
});

test('install_skill cannot be granted for a whole conversation', async t => {
  const f = await fixture(t); let failure;
  await assert.rejects(f.tools.execute('install_skill', { name: 'x', source: '/none' }, { signal: new AbortController().signal, notify: async event => {
    try { f.tools.decide(event.id, true, true); } catch (e) { failure = e; f.tools.decide(event.id, false); }
  } }), /未获得授权/);
  assert.match(failure.message, /只能允许一次/);
});

test('scheduled tasks need approval to create and run with the model at the due time', async t => {
  const f = await fixture(t, () => reply('今天一切正常'));
  await assert.rejects(f.tools.execute('schedule_task', { prompt: '检查', dueAt: '2026-10-30T09:00:00+08:00' }, { signal: new AbortController().signal, notify: async e => f.tools.decide(e.id, false) }), /未获得授权/);
  assert.equal(f.reminders.list().reminders.length, 0);
  const item = await f.tools.execute('schedule_task', { prompt: '检查服务状态', dueAt: '2026-10-30T09:00:00+08:00' }, allowCreate(f));
  assert.equal(item.kind, 'task'); assert.equal(f.prompts.length, 0);
  f.advance(3599000); await f.reminders.tick(); assert.equal(f.prompts.length, 0);
  f.advance(1000); await f.reminders.tick(); await f.settle();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].at(-1).content, /无人值守/); assert.match(f.prompts[0].at(-1).content, /检查服务状态/);
  assert.equal(f.sent.at(-1), '⏰ 定时任务结果：\n今天一切正常');
  await f.reminders.tick();
  assert.equal(f.reminders.list().reminders[0].status, 'sent');
  f.advance(86400000); await f.reminders.tick(); await f.settle();
  assert.equal(f.prompts.length, 1);
});

test('unattended runs get only what the task declared and cannot widen their own rights', async t => {
  const f = await fixture(t);
  f.tools.sessionCommands.add('node --help');
  const context = { signal: new AbortController().signal, owner: 'wechat', unattended: true, grants: { commands: ['node --version'], writes: false }, notify: async () => { throw new Error('must not ask'); } };
  assert.equal((await f.tools.execute('run_command', { command: 'node --version' }, context)).command, 'node --version');
  for (const [name, args] of [['run_command', { command: 'node --help' }], ['run_command', { command: 'node --version; echo x' }], ['write_file', { path: 'a.txt', content: 'x' }],
    ['install_skill', { name: 'x', source: '/none' }], ['capture_screen', {}], ['schedule_task', { prompt: 'x', afterSeconds: 60, allowedCommands: ['rm'] }]])
    await assert.rejects(f.tools.execute(name, args, context), /未预先获得/, name);
  await assert.rejects(fs.stat(path.join(f.root, 'a.txt')), { code: 'ENOENT' });
  assert.equal(f.tools.approvals().length, 0);
  assert.equal(f.reminders.list().reminders.length, 0);
  const writer = { ...context, grants: { commands: [], writes: true } };
  assert.equal((await f.tools.execute('write_file', { path: 'a.txt', content: 'x' }, writer)).bytes, 1);
});

test('a scheduled run reports a denied command honestly through the model', async t => {
  const f = await fixture(t, (messages, n) => n ? reply('任务未完成：' + messages.at(-1).content) : call('run_command', { command: 'npm publish' }));
  f.reminders.create({ text: '发布', kind: 'task', afterSeconds: 60 }, {});
  f.advance(60000); await f.reminders.tick(); await f.settle();
  assert.match(f.sent.at(-1), /未预先获得/); assert.equal(f.processes.list().length, 0);
});

test('quiet tasks stay silent when nothing happened but still report results and failures', async t => {
  let answer = '[无需通知]';
  const f = await fixture(t, () => { if (answer === 'boom') throw new Error('模型不可用'); return reply(answer); });
  f.reminders.create({ text: '检查', kind: 'task', quiet: true, repeat: 'interval', everyMinutes: 60 }, {});
  f.advance(3600000); await f.reminders.tick(); await f.settle(); await f.reminders.tick();
  assert.equal(f.prompts.length, 1); assert.deepEqual(f.sent, []);
  assert.match(f.prompts[0].at(-1).content, /\[无需通知\]/);
  answer = '磁盘快满了'; f.advance(3600000); await f.reminders.tick(); await f.settle(); await f.reminders.tick();
  assert.equal(f.sent.at(-1), '⏰ 定时任务结果：\n磁盘快满了');
  answer = 'boom'; f.advance(3600000); await f.reminders.tick(); await f.settle(); await f.reminders.tick();
  assert.match(f.sent.at(-1), /定时任务失败：模型不可用/);
  assert.equal(f.reminders.list().reminders[0].deliveryCount, 3);
});

test('interval rules stay anchored and an offline gap runs once, then resumes', async t => {
  const anchor = Date.parse('2026-10-30T00:00:00Z'), rule = repeatRule('interval', undefined, undefined, { everyMinutes: 30, anchor });
  assert.equal(nextRepeat(rule, anchor), '2026-10-30T00:30:00.000Z');
  assert.equal(nextRepeat(rule, anchor + 30 * 60000), '2026-10-30T01:00:00.000Z');
  assert.equal(nextRepeat(rule, anchor + 95 * 60000), '2026-10-30T02:00:00.000Z');
  assert.equal(repeatLabel(rule), '每 30 分钟');
  for (const everyMinutes of [14, 1441, 1.5, undefined]) assert.throws(() => repeatRule('interval', undefined, undefined, { everyMinutes, anchor }), /分钟/);
  const f = await fixture(t);
  f.reminders.create({ text: '巡检', kind: 'task', repeat: 'interval', everyMinutes: 60 }, {});
  f.advance(10 * 3600000); await f.reminders.tick(); await f.settle(); await f.reminders.tick();
  assert.equal(f.prompts.length, 1); assert.match(f.prompts[0].at(-1).content, /补跑/);
  await f.reminders.tick(); await f.settle();
  assert.equal(f.prompts.length, 1);
  assert.equal(Date.parse(f.reminders.list().reminders[0].dueAt), f.now() + 3600000);
});

test('a restart never repeats a started task and tells the user it was interrupted', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async () => { await waiting; return reply('x'); });
  f.reminders.create({ text: '生成报告', kind: 'task', afterSeconds: 60 }, {});
  f.advance(60000); await f.reminders.tick();
  for (let i = 0; i < 100 && !f.agent.active; i++) await delay(5);
  assert.equal(f.wx.state.inbox.at(-1).status, 'running');
  const restored = new Wechat(new Store(f.store.dir), f.agent, { fetcher: async () => Response.json({}) });
  assert.equal(restored.state.inbox.at(-1).status, 'interrupted');
  assert.match(restored.state.outbox.at(-1).text, /中断且不会自动重跑/); assert.match(restored.state.outbox.at(-1).text, /生成报告/);
  release(); await f.settle();
});

test('cancelling stops a queued occurrence and the whole series', async t => {
  const f = await fixture(t);
  f.agent.active = { controller: new AbortController() };
  const item = f.reminders.create({ text: '巡检', kind: 'task', repeat: 'interval', everyMinutes: 60 }, {});
  f.advance(3600000); await f.reminders.tick();
  assert.equal(f.wx.state.inbox.at(-1).status, 'pending');
  f.reminders.cancel(item.id);
  assert.equal(f.wx.state.inbox.at(-1).status, 'cancelled');
  f.agent.active = null; await f.settle();
  assert.equal(f.prompts.length, 0); assert.equal(f.reminders.list().reminders[0].status, 'cancelled');
});

test('task limits and rebinding protections match reminders', async t => {
  const f = await fixture(t);
  assert.throws(() => f.reminders.create({ text: 'x'.repeat(4001), kind: 'task', afterSeconds: 60 }, {}), /4000/);
  assert.throws(() => f.reminders.create({ text: 'x', kind: 'task', afterSeconds: 60, allowedCommands: ['a;b'] }, {}), /不能包含/);
  assert.equal(f.reminders.create({ text: 'x'.repeat(1001), kind: 'task', afterSeconds: 60 }, {}).kind, 'task');
  f.wx.account = { ...f.wx.account, userId: 'someone-else' };
  f.advance(60000); await f.reminders.tick(); await f.settle();
  assert.equal(f.prompts.length, 0); assert.equal(f.reminders.list().reminders[0].status, 'blocked');
});

test('long commands honor the requested limit, the user cap and report progress', async t => {
  const f = await fixture(t); f.store.saveConfig({ maxCommandMinutes: 5, allowMutations: true });
  const context = { signal: new AbortController().signal, owner: 'local', notify: async () => {} };
  await assert.rejects(f.tools.execute('run_command', { command: 'node --version', timeoutMinutes: 6 }, context), /上限 5 分钟/);
  await assert.rejects(f.tools.execute('run_command', { command: 'node --version', timeoutMinutes: 0 }, context), /正数/);
  assert.equal((await f.tools.execute('run_command', { command: 'node --version', timeoutMinutes: 4 }, context)).timeoutMs, 240000);
  assert.equal((await f.tools.execute('run_command', { command: 'node --version' }, context)).timeoutMs, 120000);
  assert.throws(() => f.store.saveConfig({ maxCommandMinutes: 721 }), /720/);
  const updates = [];
  const processes = new Processes(view => updates.push(view), { progressMs: 20 }); t.after(() => processes.stopAll());
  await processes.start('sleep', f.root, { executable: process.execPath, args: ['-e', "console.log('步骤一');setTimeout(()=>{},150)"] }).done;
  assert.ok(updates.some(view => view.progress)); assert.equal(updates.at(-1).status, 'done');
});

test('output keeps Chinese intact when a character is split across pipe chunks', async t => {
  const f = await fixture(t); const processes = new Processes(); t.after(() => processes.stopAll());
  const script = "const b=Buffer.from('中文');process.stdout.write(b.subarray(0,1),()=>setTimeout(()=>process.stdout.write(b.subarray(1)),40))";
  assert.equal((await processes.start('split', f.root, { executable: process.execPath, args: ['-e', script] }).done).output, '中文');
});

test('WeChat long tasks announce progress and a result that survives a disconnect', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-long-')));
  const store = new Store(path.join(root, 'private')); store.saveConfig({ workspace: root, allowMutations: true });
  store.write('wechat', { userId: 'owner', botId: 'bot', token: 'token' }); store.write('wechat-state', { context: 'ctx' });
  let online = false; const sent = [];
  const app = await createApp({ store, wechatOptions: { fetcher: async (url, request) => {
    if (!online) throw new Error('offline'); sent.push(JSON.parse(request.body).msg.item_list[0].text_item.text); return Response.json({});
  } }, autostart: { view: () => ({ supported: false, enabled: false }), refresh: async () => {} } });
  t.after(async () => { app.processes.stopAll(); await fs.rm(root, { recursive: true, force: true }); });
  app.wechat.status = 'connected'; app.processes.progressMs = 30;
  const task = app.processes.start('long', root, { owner: 'wechat', executable: process.execPath, args: ['-e', "console.log('进度输出');setTimeout(()=>{},200)"] });
  await task.done; await delay(20);
  assert.ok(app.wechat.state.outbox.some(item => /^后台任务完成：long\n\n进度输出/.test(item.text)));
  online = true; await app.wechat.flush();
  assert.ok(sent.some(text => text.includes('仍在运行'))); assert.match(sent.at(-1), /进度输出/);
});

async function noticeApp(t, config = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-notice-')));
  const store = new Store(path.join(root, 'private')); store.saveConfig({ workspace: root, ...config });
  store.write('wechat', { userId: 'owner', botId: 'bot', token: 'token' }); store.write('wechat-state', { context: 'ctx' });
  const sent = []; const model = { next: async () => ({ role: 'assistant', content: '好了' }) };
  const app = await createApp({ store, provider: { complete: messages => model.next(messages) }, wechatOptions: { fetcher: async (url, request) => {
    if (url.includes('sendmessage')) sent.push(JSON.parse(request.body).msg.item_list[0].text_item.text);
    return Response.json({});
  } }, autostart: { view: () => ({ supported: false, enabled: false }), refresh: async () => {} } });
  // Stopping the agent also releases an approval a failed assertion left waiting.
  t.after(async () => { app.agent.stop(); await fs.rm(root, { recursive: true, force: true }); });
  app.wechat.status = 'connected';
  // Delivers one message through the real inbox path, so reply order matches production.
  const say = async text => {
    app.wechat.state.inbox.push({ id: 'm' + app.wechat.state.inbox.length, status: 'pending', text });
    await app.wechat.drain(); await delay(40); await app.wechat.flush();
  };
  return { root, app, sent, model, say };
}
const callTool = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const nodeCommand = code => `"${process.execPath}" -e "${code}"`;
const scripted = (...steps) => async () => { const step = steps.shift(); return typeof step === 'function' ? step() : step ?? { role: 'assistant', content: '好了' }; };

test('commands the model has read produce only its reply, whether they pass or fail', async t => {
  const { app, sent, model, say } = await noticeApp(t, { allowMutations: true });
  model.next = scripted(callTool('run_command', { command: nodeCommand("console.log('quick')") }));
  await say('跑一下');
  model.next = scripted(callTool('run_command', { command: nodeCommand('process.exit(3)') }));
  await say('跑一个失败的');
  assert.deepEqual(sent, ['好了', '好了']);
  const [failed, passed] = app.store.history.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).reverse();
  assert.equal(failed.exitCode, 3); assert.equal('exitCode' in passed, false);
});

test('polling a command to its end counts as reading the result', async t => {
  const { app, sent, model, say } = await noticeApp(t, { allowMutations: true });
  model.next = scripted(callTool('run_command', { command: nodeCommand('setTimeout(()=>{},1200)') }),
    () => callTool('command_status', { id: app.processes.list()[0].id, waitSeconds: 5 }));
  await say('等它结束');
  assert.equal(app.processes.list()[0].status, 'done');
  assert.deepEqual(sent, ['好了']);
});

test('a command ending while the model writes "still running" is reported after that reply', async t => {
  const { app, sent, model, say } = await noticeApp(t, { allowMutations: true });
  model.next = scripted(callTool('run_command', { command: nodeCommand("setTimeout(()=>console.log('finished late'),1150)") }),
    async () => {
      // Wait for the actual exit: login-shell startup varies across CI runners.
      await app.processes.tasks.get(app.processes.list()[0].id).done;
      return { role: 'assistant', content: '已在后台运行' };
    });
  await say('跑久一点');
  assert.equal(sent.length, 2);
  assert.equal(sent[0], '已在后台运行');
  assert.match(sent[1], /^后台任务完成：.*\n\nfinished late$/s);
});

test('a task outliving its turn reports once in plain words; a stopped one stays quiet', async t => {
  const { root, app, sent } = await noticeApp(t);
  const stopped = app.processes.start('sleepy', root, { owner: 'wechat', executable: process.execPath, args: ['-e', 'setTimeout(()=>{},9000)'] });
  stopped.stop(); await stopped.done; await delay(30);
  const failed = app.processes.start('build', root, { owner: 'wechat', executable: process.execPath, args: ['-e', "console.log('boom');process.exit(2)"] });
  await failed.done; await delay(30); await app.wechat.flush();
  assert.deepEqual(sent, ['后台任务失败（退出码 2）：build\n\nboom']);
});

test('WeChat approval prompts name the action in plain words', async t => {
  const { app, sent, model } = await noticeApp(t);
  model.next = scripted(callTool('run_command', { command: 'echo hi' }), { role: 'assistant', content: '已取消' });
  app.wechat.state.inbox.push({ id: 'm1', status: 'pending', text: '运行一下' });
  const running = app.wechat.drain();
  for (let i = 0; i < 200 && !app.tools.pending.size; i++) await delay(5);
  await app.wechat.flush();
  assert.match(sent[0], /^需要授权：执行命令\necho hi/);
  app.tools.decide([...app.tools.pending.keys()][0], false);
  await running;
});

test('WeChat /tasks shows elapsed time and recent output for running commands', async t => {
  const f = await fixture(t);
  const task = f.processes.start(shellCommand(process.execPath, ['-v']), f.root, { executable: process.execPath, args: ['-e', "console.log('构建到 42%');setTimeout(()=>{},300)"] });
  await delay(150);
  await f.wx.ingest(message('/tasks')); await f.wx.drain();
  assert.match(f.sent.at(-1), /running 不足 1 分钟/); assert.match(f.sent.at(-1), /构建到 42%/);
  await task.done;
});
