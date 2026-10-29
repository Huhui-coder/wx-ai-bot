import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/weixin-lite.js', import.meta.url));
const variants = [{ name: 'Node CLI', program: process.execPath, prefix: [entry] }];
if (process.env.WEIXIN_LITE_TEST_BINARY) variants.push({ name: 'single binary', program: path.resolve(process.env.WEIXIN_LITE_TEST_BINARY), prefix: [] });
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
    const page = await (await fetch(url.origin)).text(); assert.match(page, /微信小助理/);
    assert.match(await (await fetch(url.origin + '/app.js')).text(), /sessionStorage/);
    assert.match(await (await fetch(url.origin + '/style.css')).text(), /:root/);
    const state = await (await fetch(url.origin + '/api/state', { headers })).json();
    assert.equal(await fs.realpath(state.config.workspace), await fs.realpath(f.work)); assert.equal(state.config.apiKey, undefined);
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
  test(`${variant.name}: invalid arguments and stale launcher lock are handled`, async t => {
    const f = await fixture(t, variant);
    assert.match((await f.run(['--help'])).stdout, /后台启动/);
    assert.equal((await f.run(['--version'])).stdout.trim(), '0.2.0');
    await assert.rejects(f.run(['--port', 'not-a-port']), /端口/);
    const lock = path.join(f.env.WEIXIN_LITE_HOME, 'start.lock');
    await fs.mkdir(lock, { recursive: true }); await fs.writeFile(path.join(lock, 'owner'), '2147483647');
    await f.run(['--no-open']); assert.equal((await f.record()).version, '0.2.0');
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
