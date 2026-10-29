import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Provider } from '../src/provider.js';
import { Processes } from '../src/processes.js';
import { Skills } from '../src/skills.js';
import { Tools } from '../src/tools.js';
import { Agent, recentHistory } from '../src/agent.js';
import { Wechat, parseWechatJSON, wechatURL } from '../src/wechat.js';
import { createApp } from '../src/server.js';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-lite-test-'));
  const workspace = path.join(dir, 'work'); await fs.mkdir(workspace);
  const store = new Store(path.join(dir, 'private')); store.saveConfig({ workspace });
  const processes = new Processes(); const skills = new Skills(store.dir, processes); const tools = new Tools(store, skills, processes);
  t.after(async () => { processes.stopAll(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, workspace, store, processes, skills, tools };
}
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const assistant = calls => ({ role: 'assistant', content: null, tool_calls: calls });
const quote = value => "'" + String(value).replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
const shellCommand = (program, args) => (process.platform === 'win32' ? '& ' : '') + [program, ...args].map(quote).join(' ');

test('config stays private, masks the API key and validates endpoints', async t => {
  const { store } = await setup(t);
  store.saveConfig({ apiKey: 'secret-test-123' });
  assert.equal(store.publicConfig().apiKey, undefined);
  assert.equal(store.publicConfig().hasApiKey, true);
  assert.equal(store.redact('key=secret-test-123'), 'key=[已隐藏密钥]');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(store.dir, 'config.json'))).mode & 0o777, 0o600);
  assert.throws(() => store.saveConfig({ baseUrl: 'http://example.com' }), /HTTPS/);
  assert.throws(() => store.saveConfig({ baseUrl: 'https://user:secret@example.com' }), /有效/);
});

test('OpenAI-compatible model request preserves DeepSeek reasoning during tool use', async t => {
  const { store } = await setup(t); store.saveConfig({ apiKey: 'test-key' });
  let request;
  const provider = new Provider(() => store.config, async (url, options) => {
    request = { url, ...options };
    return Response.json({ choices: [{ message: { ...assistant([call('list_skills', {})]), reasoning_content: 'opaque-provider-context' } }] });
  });
  const response = await provider.complete([{ role: 'user', content: '你好' }], [], new AbortController().signal);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer test-key');
  assert.equal(response.reasoning_content, 'opaque-provider-context');
  const denied = new Provider(() => store.config, async () => new Response('secret server detail', { status: 401 }));
  await assert.rejects(denied.complete([], []), /HTTP 401/);
});

test('file tools reject traversal, outside symlinks and private app state', async t => {
  const { workspace, store, tools } = await setup(t);
  await fs.symlink(store.dir, path.join(workspace, 'escape'), 'junction');
  await assert.rejects(tools.resolvePath('../private/config.json'), /工作目录/);
  await assert.rejects(tools.resolvePath('escape/config.json'), /符号链接/);
  await assert.rejects(tools.resolvePath('escape/new.txt', true), /符号链接/);
  store.saveConfig({ workspace: path.dirname(workspace) });
  await assert.rejects(tools.resolvePath('private/history.json'), /凭据/);
});

test('local Skill installs with YAML metadata and can be read on demand', async t => {
  const { dir, skills } = await setup(t); const source = path.join(dir, 'sample'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: sample\ndescription: >-\n  多行技能\n  说明\n---\n运行 scripts/test.js');
  await skills.install({ name: 'sample', source }, new AbortController().signal);
  assert.match((await skills.list())[0].description, /多行技能 说明/);
  assert.match(await skills.read('sample'), /运行 scripts/);
  await assert.rejects(skills.read('../private'), /名称/);
  await assert.rejects(skills.read('sample', '../../config.json'), /越界/);
  await assert.rejects(skills.install({ name: 'sample', source }), /已存在/);
});

test('Skill installer rejects symlinks and repository subdirectory escape', async t => {
  const { dir, skills } = await setup(t); const source = path.join(dir, 'unsafe'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'SKILL.md'), '# sample');
  await fs.symlink(dir, path.join(source, 'outside'), 'junction');
  await assert.rejects(skills.install({ name: 'bad', source }), /符号链接/);
  await assert.rejects(skills.install({ name: 'bad', source, subdir: '..' }), /越界/);
  await assert.rejects(skills.install({ name: 'bad', source: 'https://example.com/repo' }), /github.com/);
  assert.equal((await skills.list()).length, 0);
});

test('mutation approvals bind to a specific invocation; rejecting does not write', async t => {
  const { tools, workspace } = await setup(t); const signal = new AbortController().signal;
  const invoke = tools.execute('write_file', { path: 'approved.txt', content: 'ok' }, {
    signal, owner: 'local', notify: async event => tools.decide(event.id, true),
  });
  await invoke; assert.equal(await fs.readFile(path.join(workspace, 'approved.txt'), 'utf8'), 'ok');
  await assert.rejects(tools.execute('write_file', { path: 'denied.txt', content: 'bad' }, {
    signal, owner: 'local', notify: async event => tools.decide(event.id, false),
  }), /未获得授权/);
  await assert.rejects(fs.stat(path.join(workspace, 'denied.txt')), { code: 'ENOENT' });
  assert.equal(tools.approvals().length, 0);
});

test('stopping while waiting for approval unblocks the agent', async t => {
  const { tools } = await setup(t); const controller = new AbortController();
  await assert.rejects(tools.execute('run_command', { command: 'echo must-not-run' }, {
    signal: controller.signal, notify: async () => controller.abort(),
  }), /未获得授权/);
  assert.equal(tools.processes.list().length, 0);
});

test('command tools report real output, exit status and kill a timed out process', async t => {
  const { processes, workspace } = await setup(t);
  const task = processes.start('hello fixture', workspace, { executable: process.execPath, args: ['-e', "process.stdout.write('hello')"] });
  assert.equal((await task.done).output, 'hello'); assert.equal(processes.view(task.id).exitCode, 0);
  const failed = await processes.start('exit fixture', workspace, { executable: process.execPath, args: ['-e', 'process.exit(7)'] }).done; assert.equal(failed.exitCode, 7); assert.equal(failed.status, 'failed');
  const timed = await processes.start('sleep fixture', workspace, { executable: process.execPath, args: ['-e', 'setTimeout(()=>{},20000)'], timeoutMs: 150 }).done;
  assert.equal(timed.status, 'timeout');
});

test('full agent loop installs a Skill, reads its script, executes it and sees the result', async t => {
  const { dir, store, tools, workspace } = await setup(t); store.saveConfig({ allowMutations: true });
  const source = path.join(dir, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: demo\ndescription: 测试技能\n---\n运行 demo.cjs 并报告结果。');
  await fs.writeFile(path.join(source, 'demo.cjs'), "console.log('skill-e2e-ok')");
  let step = 0;
  const provider = { async complete(messages) {
    assert.match(messages[0].content, /当前配置模型直接处理/);
    switch (step++) {
      case 0: return assistant([call('install_skill', { name: 'demo', source })]);
      case 1: assert.match(messages.at(-1).content, /installed/); return assistant([call('read_skill', { name: 'demo' })]);
      case 2: assert.match(messages.at(-1).content, /demo.cjs/); return assistant([call('read_skill', { name: 'demo', file: 'demo.cjs' }, 'script')]);
      case 3: return assistant([call('run_command', { command: shellCommand(process.execPath, [path.join(tools.skills.dir, 'demo/demo.cjs')]), cwd: '.' })]);
      default: {
        const result = JSON.parse(messages.at(-1).content);
        if (result.status === 'running') return assistant([call('command_status', { id: result.id, waitSeconds: 10 }, 'poll-' + step)]);
        assert.equal(result.status, 'done');
        assert.match(messages.at(-1).content, /skill-e2e-ok/);
        return { role: 'assistant', content: '技能已安装并执行，输出 skill-e2e-ok。' };
      }
    }
  } };
  const agent = new Agent(store, provider, tools);
  assert.match(await agent.run('安装并运行 demo'), /skill-e2e-ok/);
  assert.ok(step >= 5); assert.equal(agent.active, null);
  assert.ok(store.history.filter(m => m.role === 'tool').length >= 4);
});

test('malformed model arguments return a tool error without executing commands', async t => {
  const { store, tools } = await setup(t); let step = 0;
  const provider = { async complete(messages) { if (!step++) return assistant([{ id: 'bad', type: 'function', function: { name: 'run_command', arguments: '{' } }]);
    assert.match(messages.at(-1).content, /error/); return { role: 'assistant', content: '参数错误，未执行。' }; } };
  await new Agent(store, provider, tools).run('test'); assert.equal(tools.processes.list().length, 0);
});

test('restart closes unfinished tool calls instead of replaying mutations', async t => {
  const { store } = await setup(t);
  store.add({ role: 'user', content: 'test' }); store.add(assistant([call('run_command', { command: 'echo no-replay' })]));
  const restored = new Store(store.dir);
  assert.equal(restored.history.at(-1).role, 'tool'); assert.match(restored.history.at(-1).content, /不要自动重放/);
});

test('context retention preserves complete tool call/result pairs', () => {
  const history = [{ role: 'user', content: 'old'.repeat(100) }, { role: 'assistant', content: 'old' },
    { role: 'user', content: 'new' }, assistant([call('list_skills', {})]), { role: 'tool', tool_call_id: 'list_skills', content: '[]' }];
  const recent = recentHistory(history, 280);
  assert.equal(recent[0].content, 'new'); assert.equal(recent.at(-1).role, 'tool'); assert.equal(recent.length, 3);
});

test('WeChat parser preserves uint64 identifiers and validates redirect domains', () => {
  const parsed = parseWechatJSON('{"msgs":[{"message_id":18446744073709551615,"text":"message_id: 1"}]}');
  assert.equal(parsed.msgs[0].message_id, '18446744073709551615');
  assert.equal(wechatURL('ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com');
  assert.throws(() => wechatURL('https://weixin.qq.com.evil.test'), /不受支持/);
  assert.throws(() => wechatURL('https://ilinkai.weixin.qq.com:444'), /不受支持/);
});

test('WeChat only admits the QR owner and deduplicates messages before execution', async t => {
  const { store, tools } = await setup(t); const processed = [], sent = [];
  const agent = { tools, active: null, async run(text) { processed.push(text); return 'done'; } };
  const wx = new Wechat(store, agent, { fetcher: async (url, req) => { sent.push(JSON.parse(req.body)); return Response.json({ ret: 0 }); } });
  wx.account = { token: 'wx-test', userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' }; wx.status = 'connected';
  const msg = { message_id: '1', from_user_id: 'owner', message_type: 1, context_token: 'ctx', item_list: [{ type: 1, text_item: { text: '运行任务' } }] };
  await wx.ingest({ ...msg, from_user_id: 'intruder' }); assert.equal(wx.state.inbox.length, 0);
  await wx.ingest(msg); await wx.ingest(msg); await wx.drain();
  assert.deepEqual(processed, ['运行任务']); assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.context_token, 'ctx');
  assert.equal(new Wechat(store, agent).state.seen.includes('1'), true);
});

test('WeChat approval commands bypass a busy model turn and unauthorized users cannot approve', async t => {
  const { store, tools } = await setup(t); let approved;
  const agent = { active: {}, tools: { ...tools, decide(id, decision) { approved = [id, decision]; } } };
  const wx = new Wechat(store, agent, { fetcher: async () => Response.json({ ret: 0 }) });
  wx.account = { userId: 'owner', token: 'test', baseUrl: 'https://ilinkai.weixin.qq.com' };
  const msg = { message_id: 'a', from_user_id: 'owner', context_token: 'ctx', item_list: [{ type: 1, text_item: { text: '/approve abc' } }] };
  await wx.ingest({ ...msg, from_user_id: 'intruder' }); assert.equal(approved, undefined);
  await wx.ingest(msg); assert.deepEqual(approved, ['abc', true]);
});

test('WeChat QR flow uses current POST login and binds confirmed owner without leaking token', async t => {
  const { store } = await setup(t); const requests = [];
  const wx = new Wechat(store, {}, { fetcher: async (url, req) => {
    requests.push({ url, req });
    if (url.includes('get_bot_qrcode')) return Response.json({ qrcode: 'ticket', qrcode_img_content: 'https://liteapp.weixin.qq.com/test' });
    return Response.json({ status: 'confirmed', bot_token: 'private-wx-token', ilink_user_id: 'owner', ilink_bot_id: 'bot', baseurl: 'https://ilinkai.weixin.qq.com' });
  } });
  wx.start = () => { wx.status = 'connected'; };
  await wx.login();
  for (let i = 0; i < 20 && wx.status !== 'connected'; i++) await delay(10);
  assert.equal(requests[0].req.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].req.body), { local_token_list: [] });
  assert.equal(wx.account.userId, 'owner'); assert.equal(wx.status, 'connected');
  assert.equal(JSON.stringify(wx.view()).includes('private-wx-token'), false);
});

test('HTTP API rejects cross-site and missing auth; model chat works through local mock API', async t => {
  const { store } = await setup(t);
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); assert.equal(body.model, 'test-model'); assert.equal(req.headers.authorization, 'Bearer test-http-key');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '本地接口闭环成功' } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => model.close(resolve)));
  store.saveConfig({ baseUrl: `http://127.0.0.1:${model.address().port}`, model: 'test-model', apiKey: 'test-http-key' });
  const app = await createApp({ store }); t.after(() => app.close());
  const link = await app.listen(0); const base = link.split('/#')[0];
  const headers = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  const state = await (await fetch(base + '/api/state', { headers })).json();
  assert.equal(JSON.stringify(state).includes('test-http-key'), false);
  assert.equal((await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ text: '你好' }) })).status, 202);
  for (let i = 0; i < 30 && app.agent.active; i++) await delay(10);
  assert.equal(store.history.at(-1).content, '本地接口闭环成功');
  assert.equal((await fetch(base + '/')).status, 200);
});
