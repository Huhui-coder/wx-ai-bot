import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION } from '../src/version.js';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/weixin-lite.js', import.meta.url));
const variants = [{ name: 'Node CLI', program: process.execPath, prefix: [entry] }];
if (process.env.WEIXIN_LITE_TEST_BINARY) variants.push({ name: 'single binary', program: path.resolve(process.env.WEIXIN_LITE_TEST_BINARY), prefix: [] });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function fixture(t, variant) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-cli-'));
  const work = path.join(root, 'project with spaces'); await fs.mkdir(work);
  const env = { ...process.env, WEIXIN_LITE_HOME: path.join(root, 'private'), PORT: '0' };
  const run = (args, override = {}) => {
    const childEnv = { ...env, ...override };
    if (Object.hasOwn(override, 'PATH')) for (const key of Object.keys(childEnv)) {
      if (key.toLowerCase() === 'path' && key !== 'PATH') delete childEnv[key];
    }
    return exec(variant.program, [...variant.prefix, ...args], { cwd: work, env: childEnv, timeout: 25000 });
  };
  const record = () => fs.readFile(path.join(env.WEIXIN_LITE_HOME, 'service.json'), 'utf8').then(JSON.parse);
  t.after(async () => { try { await run(['stop']); } catch {} await fs.rm(root, { recursive: true, force: true }); });
  return { root, work, env, run, record };
}
for (const variant of variants) {
  test(`${variant.name}: background lifecycle, concurrency, reuse and embedded assets`, { timeout: 40000 }, async t => {
    const f = await fixture(t, variant);
    const results = await Promise.all([f.run(['--no-open']), f.run(['--no-open']), f.run(['--no-open'])]);
    assert.equal(results.filter(r => /已在后台启动/.test(r.stdout)).length, 1);
    const record = await f.record(); const url = new URL(record.url);
    const headers = { Authorization: 'Bearer ' + url.hash.slice(1) };
    const page = await (await fetch(url.origin)).text(); assert.match(page, /微信小助理/); assert.match(page, /id="imageDirectory"/); assert.match(page, /page-reminders/); assert.match(page, /每周指定星期/); assert.match(page, /微信图片与附件保存目录/);
    assert.match(await (await fetch(url.origin + '/app.js')).text(), /sessionStorage/);
    assert.match(await (await fetch(url.origin + '/style.css')).text(), /:root/);
    const state = await (await fetch(url.origin + '/api/state', { headers })).json();
    assert.equal(await fs.realpath(state.config.workspace), await fs.realpath(f.work)); assert.equal(state.config.apiKey, undefined);
    assert.equal(state.reminders.timeZone, 'Asia/Shanghai'); assert.deepEqual(state.reminders.reminders, []);
    const imageDirectory = path.join(await fs.realpath(f.work), '图片 收件箱');
    const saved = await (await fetch(url.origin + '/api/config', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ imageDirectory }) })).json();
    assert.equal(saved.imageDirectory, imageDirectory);
    assert.equal((await (await fetch(url.origin + '/api/state', { headers })).json()).config.imageDirectory, imageDirectory);
    assert.match((await f.run(['status'])).stdout, new RegExp('PID ' + record.pid));
    await f.run(['start', '--no-open']); assert.equal((await f.record()).instanceId, record.instanceId);
    assert.match((await f.run(['stop'])).stdout, /已停止/);
    assert.match((await f.run(['status'])).stdout, /未运行/);
    await f.run(['--no-open']); assert.notEqual((await f.record()).instanceId, record.instanceId);
  });
  test(`${variant.name}: opens the default browser automatically`, { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t, variant); const fakeBin = path.join(f.root, 'bin'); await fs.mkdir(fakeBin);
    const browserLog = path.join(f.root, 'browser.txt');
    const opener = path.join(fakeBin, process.platform === 'darwin' ? 'open' : 'xdg-open');
    await fs.writeFile(opener, '#!/bin/sh\nprintf "%s" "$1" > "$WEIXIN_TEST_BROWSER_LOG"\n', { mode: 0o755 });
    await f.run([], { PATH: fakeBin + path.delimiter + process.env.PATH, WEIXIN_TEST_BROWSER_LOG: browserLog });
    assert.equal(await fs.readFile(browserLog, 'utf8'), (await f.record()).url);
  });
  test(`${variant.name}: a crash restarts on the same address; stop then ends the supervisor`, { timeout: 30000 }, async t => {
    const f = await fixture(t, variant); await f.run(['--no-open']);
    const first = await f.record();
    assert.ok(alive(first.supervisor)); assert.notEqual(first.supervisor, first.pid);
    process.kill(first.pid, 'SIGKILL');
    let next = first;
    for (let i = 0; i < 100 && next.instanceId === first.instanceId; i++) { await delay(100); next = await f.record(); }
    assert.notEqual(next.instanceId, first.instanceId); assert.equal(next.url, first.url); assert.equal(next.supervisor, first.supervisor);
    const url = new URL(next.url);
    assert.equal((await fetch(url.origin + '/api/runtime', { headers: { Authorization: 'Bearer ' + url.hash.slice(1) } })).status, 200);
    assert.match((await f.run(['stop'])).stdout, /已停止/);
    assert.equal(alive(next.pid), false); assert.equal(alive(next.supervisor), false);
  });
  test(`${variant.name}: stop during a restart wait cancels the restart`, { timeout: 30000 }, async t => {
    const f = await fixture(t, variant); await f.run(['--no-open']);
    const record = await f.record();
    process.kill(record.pid, 'SIGKILL');
    for (let i = 0; i < 50 && alive(record.pid); i++) await delay(20);
    assert.match((await f.run(['status'])).stdout, /重启/);
    await assert.rejects(f.run(['--no-open']), /暂时无法连接/);
    // A compiled CLI can take long enough to launch that the service has restarted.
    // Both stop paths must end the supervisor and prevent another restart.
    assert.match((await f.run(['stop'])).stdout, /未运行|已停止/);
    assert.equal(alive(record.supervisor), false);
    await delay(2500);
    assert.match((await f.run(['status'])).stdout, /未运行/);
  });
  test(`${variant.name}: a broken configuration is reported at once, not retried forever`, { timeout: 30000 }, async t => {
    const f = await fixture(t, variant); await fs.mkdir(f.env.WEIXIN_LITE_HOME, { recursive: true });
    await fs.writeFile(path.join(f.env.WEIXIN_LITE_HOME, 'config.json'), '{broken');
    await assert.rejects(f.run(['--no-open']), /无法读取/);
    assert.match((await f.run(['status'])).stdout, /未运行/);
  });
  test(`${variant.name}: a record from before this boot cannot block startup`, async t => {
    const f = await fixture(t, variant); await fs.mkdir(f.env.WEIXIN_LITE_HOME, { recursive: true });
    await fs.writeFile(path.join(f.env.WEIXIN_LITE_HOME, 'service.json'), JSON.stringify({ pid: process.pid, supervisor: process.pid, instanceId: 'a'.repeat(32),
      url: 'http://127.0.0.1:9/#' + 'b'.repeat(48), startedAt: '2001-01-01T00:00:00.000Z' }));
    assert.match((await f.run(['status'])).stdout, /未运行/);
    assert.match((await f.run(['--no-open'])).stdout, /已在后台启动/);
  });
  test(`${variant.name}: oversized logs rotate on start`, async t => {
    const f = await fixture(t, variant); await fs.mkdir(f.env.WEIXIN_LITE_HOME, { recursive: true });
    const log = path.join(f.env.WEIXIN_LITE_HOME, 'service.log');
    await fs.writeFile(log, Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    await f.run(['--no-open']);
    assert.ok((await fs.stat(log)).size < 5 * 1024 * 1024); assert.equal((await fs.stat(log + '.1')).size, 5 * 1024 * 1024 + 1);
  });
  test(`${variant.name}: invalid arguments and stale launcher lock are handled`, async t => {
    const f = await fixture(t, variant);
    assert.match((await f.run(['--help'])).stdout, /后台启动/);
    assert.equal((await f.run(['--version'])).stdout.trim(), VERSION);
    await assert.rejects(f.run(['--port', 'not-a-port']), /端口/);
    const lock = path.join(f.env.WEIXIN_LITE_HOME, 'start.lock');
    await fs.mkdir(lock, { recursive: true }); await fs.writeFile(path.join(lock, 'owner'), '2147483647');
    await f.run(['--no-open']); assert.equal((await f.record()).version, VERSION);
  });
}

test('standalone binary starts with no Node or Python on PATH', { skip: !process.env.WEIXIN_LITE_TEST_BINARY }, async t => {
  const variant = variants.at(-1); const f = await fixture(t, variant);
  const fakeBin = path.join(f.root, 'empty-path'); await fs.mkdir(fakeBin);
  await f.run(['--no-open'], { PATH: fakeBin });
  assert.match((await f.run(['status'], { PATH: fakeBin })).stdout, /运行中/);
  const url = new URL((await f.record()).url);
  assert.equal((await fetch(url.origin)).status, 200);
});
