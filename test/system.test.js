import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFS from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Provider } from '../src/provider.js';
import { recentHistory } from '../src/agent.js';
import { Wechat } from '../src/wechat.js';
import { Autostart, KeepAwake, keepAwakeCommand, launchAgent, runValue, screenshotCommand } from '../src/system.js';
import { persistMedia } from '../src/images.js';
import { createApp } from '../src/server.js';

async function dir(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-system-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const tool = (id, size) => ({ role: 'tool', tool_call_id: id, content: 'x'.repeat(size) });
const call = id => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });

test('a damaged data file falls back to the last good copy instead of stopping the service', async t => {
  const root = await dir(t); const store = new Store(root);
  store.write('reminders', [{ id: 'first' }]); store.write('reminders', [{ id: 'second' }]);
  await fs.writeFile(path.join(root, 'reminders.json'), '{"truncated":');
  assert.deepEqual(store.read('reminders', []), [{ id: 'first' }]);
  await fs.writeFile(path.join(root, 'reminders.json.bak'), 'also broken');
  assert.throws(() => store.read('reminders', []), /无法读取/);
  assert.deepEqual(store.read('missing', 'fallback'), 'fallback');
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
});

test('writes keep private permissions and /new leaves no old conversation behind', async t => {
  const root = await dir(t); const store = new Store(root);
  store.add({ role: 'user', content: '私密内容' }); store.add({ role: 'assistant', content: 'ok' });
  // Windows uses ACLs; Bun 1.2.17 also ignores node:test's skip option.
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, 'history.json.bak'))).mode & 0o777, 0o600);
  store.clear();
  assert.equal(syncFS.existsSync(path.join(root, 'history.json.bak')), false);
  assert.equal(await fs.readFile(path.join(root, 'history.json'), 'utf8'), '[]');
});

test('secrets are redacted without touching the disk, including after rebinding', async t => {
  const root = await dir(t); const store = new Store(root);
  store.write('wechat', { token: 'first-token' }); assert.equal(store.redact('a first-token b'), 'a [已隐藏密钥] b');
  await fs.rm(path.join(root, 'wechat.json'));
  assert.equal(store.redact('first-token'), '[已隐藏密钥]');
  store.write('wechat', { token: 'second-token' }); assert.equal(store.redact('second-token'), '[已隐藏密钥]');
  assert.equal(new Store(root).redact('second-token'), '[已隐藏密钥]');
});

test('history stays bounded and always restarts on a user turn', async t => {
  const root = await dir(t); const store = new Store(root);
  for (let i = 0; i < 300; i++) { store.history.push({ role: 'user', content: 'q' + i }, call('c' + i), { role: 'tool', tool_call_id: 'c' + i, content: 'r' }); }
  store.add({ role: 'assistant', content: 'end' });
  assert.ok(store.history.length <= 402); assert.equal(store.history[0].role, 'user');
  assert.equal(store.history.at(-1).content, 'end');
  assert.equal(new Store(root).history.length, store.history.length);
});

test('one oversized turn shrinks old tool results but keeps every call paired', () => {
  const history = [{ role: 'user', content: 'go' }, call('a'), tool('a', 60000), call('b'), tool('b', 60000), call('c'), tool('c', 30000)];
  const recent = recentHistory(history, 100000);
  assert.equal(recent.length, history.length);
  assert.equal(recent.filter(m => m.role === 'tool').length, 3);
  assert.ok(JSON.stringify(recent).length <= 100000);
  assert.match(recent[2].content, /已截断/); assert.equal(recent[6].content.length, 30000);
  assert.equal(history[2].content.length, 60000);
});

test('agent results say when they were cut instead of silently ending mid-file', async t => {
  const { Agent } = await import('../src/agent.js');
  const root = await dir(t); const store = new Store(path.join(root, 'private'));
  let step = 0;
  const provider = { async complete() { return step++ ? { role: 'assistant', content: 'ok' } : { ...call('a') }; } };
  const tools = { skills: { list: async () => [], dir: '' }, processes: { stopAll() {} }, recentFiles: () => [], definitions: () => [], execute: async () => 'y'.repeat(30000) };
  await new Agent(store, provider, tools).run('读');
  assert.match(store.history.find(m => m.role === 'tool').content, /已截断，共 \d+ 字符/);
});

test('transient model failures retry; permanent ones and user stops do not', async t => {
  const root = await dir(t); const store = new Store(root); store.saveConfig({ apiKey: 'k' });
  const ok = () => Response.json({ choices: [{ message: { role: 'assistant', content: '好' } }] });
  const run = async (responses, signal) => {
    let n = 0;
    const provider = new Provider(() => store.config, async () => { const next = responses[n++]; if (next instanceof Error) throw next; return next(); }, { retryMs: 1 });
    try { return { value: await provider.complete([], [], signal), calls: n }; } catch (e) { return { error: e.message, calls: n }; }
  };
  assert.deepEqual(await run([() => new Response('', { status: 503 }), () => new Response('', { status: 429 }), ok]), { value: { role: 'assistant', content: '好' }, calls: 3 });
  assert.equal((await run([new TypeError('fetch failed'), ok])).calls, 2);
  assert.equal((await run([() => new Response('not json'), ok])).calls, 2);
  const failed = await run([() => new Response('', { status: 500 }), () => new Response('', { status: 500 }), () => new Response('', { status: 500 }), ok]);
  assert.equal(failed.calls, 3); assert.match(failed.error, /HTTP 500/);
  for (const status of [400, 401, 403, 404]) assert.equal((await run([() => new Response('', { status }), ok])).calls, 1);
  const controller = new AbortController(); controller.abort();
  assert.equal((await run([() => new Response('', { status: 500 }), ok], controller.signal)).calls, 1);
  const vision = new Provider(() => store.config, async () => new Response('', { status: 400 }), { retryMs: 1 });
  await assert.rejects(vision.complete([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }], []), /看图/);
});

test('failed replies are retried by the poll loop without waiting for a new message', async t => {
  const root = await dir(t); const store = new Store(root); let online = false, polls = 0; const sent = [];
  const wx = new Wechat(store, { active: null, tools: {} }, { fetcher: async url => {
    if (url.includes('getupdates')) { polls++; return Response.json({}); }
    if (!online) throw new Error('offline'); sent.push(url); return Response.json({});
  } });
  wx.account = { userId: 'owner', botId: 'bot', token: 'token', baseUrl: 'https://ilinkai.weixin.qq.com' }; wx.state.context = 'ctx';
  await wx.send('晚到的回复').catch(() => {});
  assert.equal(wx.state.outbox.length, 1);
  online = true; wx.start();
  for (let i = 0; i < 100 && (wx.state.outbox.length || !polls); i++) await delay(5);
  wx.stop();
  assert.equal(wx.state.outbox.length, 0); assert.equal(sent.length, 1);
});

test('an unexpected failure in background WeChat work is recorded, not fatal', async t => {
  const root = await dir(t); const store = new Store(root);
  const wx = new Wechat(store, { active: null, tools: {} }, { fetcher: async () => Response.json({}) });
  wx.account = { userId: 'owner', botId: 'bot', token: 'token', baseUrl: 'https://ilinkai.weixin.qq.com' };
  store.write('wechat', wx.account);
  wx.background(Promise.reject(new Error('disk full: token')));
  await delay(5);
  assert.equal(wx.lastError, 'disk full: [已隐藏密钥]');
});

test('received files still save on drives without hard links', async t => {
  const root = await dir(t); const original = fs.link;
  fs.link = async () => { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); };
  try {
    const options = { directory: path.join(root, 'in'), filename: 'a.txt', day: '2026-10-30' };
    const saved = await persistMedia(Buffer.from('hello'), options);
    assert.equal(await fs.readFile(saved.path, 'utf8'), 'hello');
    await persistMedia(Buffer.from('hello'), options);
    await assert.rejects(persistMedia(Buffer.from('world'), options), /同名文件/);
  } finally { fs.link = original; }
});

test('macOS login item is a valid private plist with the environment commands need', async t => {
  const root = await dir(t); const command = ['/Users/a b/.local/bin/weixin-lite', 'start', '--no-open'];
  const autostart = new Autostart({ command, platform: 'darwin', home: root, env: { PATH: '/opt/homebrew/bin:/usr/bin', SHELL: '/bin/zsh', SECRET_API_KEY: 'never-copied' } });
  assert.deepEqual(await autostart.refresh(), { supported: true, enabled: false });
  assert.deepEqual(await autostart.set(true, { workingDirectory: '/Users/a b/工作 & 项目' }), { supported: true, enabled: true });
  const text = await fs.readFile(autostart.plist, 'utf8');
  assert.match(text, /<string>\/Users\/a b\/\.local\/bin\/weixin-lite<\/string>/); assert.match(text, /工作 &amp; 项目/);
  assert.match(text, /<key>RunAtLoad<\/key>\n  <true\/>/); assert.match(text, /\/opt\/homebrew\/bin/);
  assert.equal(text.includes('never-copied'), false);
  if (process.platform === 'darwin') await promisify(execFile)('plutil', ['-lint', autostart.plist]);
  assert.equal((await new Autostart({ command, platform: 'darwin', home: root }).refresh()).enabled, true);
  await autostart.set(false);
  assert.equal(syncFS.existsSync(autostart.plist), false); assert.equal(autostart.enabled, false);
  await autostart.set(false);
});

test('macOS refuses a login item that privacy protection would block, and warns about the workspace', async t => {
  const root = await dir(t);
  for (const folder of ['Desktop', 'Documents', 'Downloads']) {
    const blocked = new Autostart({ command: [path.join(root, folder, 'app', 'weixin-lite'), 'start', '--no-open'], platform: 'darwin', home: root });
    await assert.rejects(blocked.set(true), /桌面、文稿或下载/); assert.equal(blocked.enabled, false);
    assert.equal(syncFS.existsSync(blocked.plist), false);
    await blocked.set(false);
  }
  const dev = new Autostart({ command: ['/opt/node', path.join(root, 'Desktop', 'bin.js'), 'start', '--no-open'], platform: 'darwin', home: root });
  await assert.rejects(dev.set(true), /桌面、文稿或下载/);
  const installed = new Autostart({ command: [path.join(root, '.local', 'bin', 'weixin-lite'), 'start', '--no-open'], platform: 'darwin', home: root });
  assert.equal((await installed.set(true, { workingDirectory: path.join(root, 'Projects') })).warning, undefined);
  assert.match((await installed.set(true, { workingDirectory: path.join(root, 'Desktop', '项目') })).warning, /可能弹窗/);
  assert.equal(installed.enabled, true);
  assert.equal((await installed.set(false, { workingDirectory: path.join(root, 'Desktop', '项目') })).warning, undefined);
  const windows = new Autostart({ command: ['C:\\Users\\me\\Desktop\\a.exe', 'start', '--no-open'], platform: 'win32', home: 'C:\\Users\\me', exec: async () => {} });
  assert.equal((await windows.set(true)).enabled, true);
});

test('Windows login item uses the per-user Run key with a quoted path', async t => {
  const calls = []; let exists = false;
  const exec = async (program, args) => { calls.push([program, ...args]); if (args[0] === 'query' && !exists) throw new Error('missing'); };
  const autostart = new Autostart({ command: ['C:\\Program Files\\weixin-lite.exe', 'start', '--no-open'], platform: 'win32', home: 'C:\\Users\\me', exec });
  assert.equal((await autostart.refresh()).enabled, false);
  await autostart.set(true);
  assert.deepEqual(calls[1].slice(0, 3), ['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
  assert.equal(calls[1].at(-2), '"C:\\Program Files\\weixin-lite.exe" start --no-open');
  exists = true; assert.equal((await autostart.refresh()).enabled, true);
  await autostart.set(false); assert.equal(calls.at(-1)[1], 'delete');
  assert.equal(runValue(['node', 'C:\\a b\\cli.js', 'start', '--no-open']), '"node" "C:\\a b\\cli.js" start --no-open');
});

test('unsupported systems refuse autostart and keep-awake without crashing', async t => {
  const autostart = new Autostart({ command: ['x'], platform: 'linux' });
  assert.equal(autostart.view().supported, false); await assert.rejects(autostart.set(true), /不支持/);
  const awake = new KeepAwake({ platform: 'linux' }); awake.apply(true);
  assert.equal(awake.child, null); assert.match(awake.error, /不支持/);
  assert.equal(keepAwakeCommand(1, 'linux'), null); assert.throws(() => screenshotCommand('/a.png', 'linux'), /不支持/);
});

test('keep-awake is tied to the service process and tolerates a missing helper', () => {
  assert.deepEqual(keepAwakeCommand(42, 'darwin'), { program: 'caffeinate', args: ['-i', '-w', '42'] });
  assert.match(keepAwakeCommand(42, 'win32').args.at(-1), /Wait-Process -Id 42/);
  const children = [];
  const spawner = () => { const child = new EventEmitter(); child.kill = () => { child.killed = true; }; children.push(child); return child; };
  const awake = new KeepAwake({ pid: 42, platform: 'darwin', spawner });
  awake.apply(true); awake.apply(true); assert.equal(children.length, 1);
  awake.apply(false); assert.equal(children[0].killed, true); assert.equal(awake.child, null);
  awake.apply(true); children[1].emit('error', new Error('missing')); assert.equal(awake.child, null); assert.match(awake.error, /missing/);
  awake.apply(true); children[2].emit('exit'); assert.equal(awake.child, null);
});

test('screenshot commands stay silent and quote paths for PowerShell', () => {
  assert.deepEqual(screenshotCommand('/a b.png', 'darwin'), { executable: 'screencapture', args: ['-x', '/a b.png'] });
  assert.match(screenshotCommand("C:\\it's.png", 'win32').args.at(-1), /'C:\\it''s\.png'/);
});

test('settings and approvals work over the local API, including login start', async t => {
  const root = await dir(t); const store = new Store(path.join(root, 'private')); store.saveConfig({ workspace: root });
  const applied = [], toggles = [];
  const app = await createApp({ store, keepAwake: { apply(value) { applied.push(value); }, child: null, error: '' },
    autostart: { view: () => ({ supported: true, enabled: toggles.at(-1)?.enabled ?? false }), refresh: async () => {}, set: async (enabled, options) => { toggles.push({ enabled, ...options }); return { supported: true, enabled }; } } });
  t.after(() => app.close());
  const base = (await app.listen(0)).split('/#')[0];
  const post = async (route, body) => { const res = await fetch(base + '/api/' + route, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  assert.equal(applied[0], false);
  const saved = await post('config', { keepAwake: true, vision: true, allowedCommands: ['npm test', ''], maxCommandMinutes: 60 });
  assert.deepEqual(saved.body.allowedCommands, ['npm test']); assert.equal(saved.body.vision, true); assert.equal(applied.at(-1), true);
  assert.equal((await post('config', { allowedCommands: ['npm test; rm'] })).status, 400);
  assert.equal(new Store(store.dir).config.maxCommandMinutes, 60);
  assert.deepEqual((await post('autostart', { enabled: true })).body, { supported: true, enabled: true });
  assert.equal(toggles[0].workingDirectory, root);
  assert.equal(JSON.parse(await fs.readFile(path.join(store.dir, 'config.json'), 'utf8')).workspace, root);
  assert.equal((await post('autostart', {})).status, 400);
  const state = await (await fetch(base + '/api/state', { headers: { Authorization: 'Bearer ' + app.token } })).json();
  assert.equal(state.autostart.enabled, true); assert.equal(state.keepAwake.active, false);
});
