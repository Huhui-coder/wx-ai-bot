import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory } from './store.js';
import { VERSION } from './version.js';

const STARTUP_FAILED = 78;
const MAX_RESTARTS = 5, STABLE_MS = 300000, MAX_BACKOFF_MS = 60000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
const serviceFile = dir => path.join(dir, 'service.json');
// Windows reports EPERM while a deleted file is still closing, and a reader can race a
// shutting-down service; only a state that persists is a real error.
async function readService(dir) {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(await fs.readFile(serviceFile(dir), 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') return null;
      if (attempt >= 10) throw new Error('服务状态文件无法读取：' + serviceFile(dir));
      await delay(50);
    }
  }
}
// After a power loss the old PID can belong to an unrelated process; a record from
// before this boot can never describe a live service.
function staleRecord(record) {
  const started = Date.parse(record?.startedAt);
  return Number.isFinite(started) && started < Date.now() - os.uptime() * 1000;
}
function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function connection(record) {
  if (!record || !Number.isSafeInteger(record.pid) || !/^[a-f0-9]{32}$/.test(record.instanceId || '')) throw new Error('无效的服务状态');
  const url = new URL(record.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.username || url.password || !/^#[a-f0-9]{48}$/.test(url.hash)) throw new Error('无效的服务地址');
  return { base: url.origin, headers: { Authorization: 'Bearer ' + url.hash.slice(1) } };
}
export async function probe(record) {
  try {
    const { base, headers } = connection(record);
    const res = await fetch(base + '/api/runtime', { headers, signal: AbortSignal.timeout(1000), redirect: 'error' });
    if (!res.ok) return false;
    const data = await res.json();
    return data.app === 'weixin-lite' && data.instanceId === record.instanceId && data.pid === record.pid;
  } catch { return false; }
}
async function lock(dir) {
  const name = path.join(dir, 'start.lock');
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(name, { mode: 0o700 });
      // Publish the owner atomically: a concurrent launcher must not interpret
      // a briefly empty owner file as a dead process and remove a live lock.
      await fs.writeFile(path.join(name, 'owner.tmp'), String(process.pid), { mode: 0o600 });
      await fs.rename(path.join(name, 'owner.tmp'), path.join(name, 'owner'));
      return async () => fs.rm(name, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const raw = (await fs.readFile(path.join(name, 'owner'), 'utf8')).trim();
        if (/^[1-9]\d*$/.test(raw) && !isAlive(Number(raw))) { await fs.rm(name, { recursive: true, force: true }); continue; }
      } catch (readError) {
        if (readError.code === 'ENOENT') {
          try { if (Date.now() - (await fs.stat(name)).mtimeMs > 10000) await fs.rm(name, { recursive: true, force: true }); } catch {}
        } else throw readError;
      }
      await delay(100);
    }
  }
  throw new Error('另一个启动命令仍在处理，请稍后再试');
}
export async function openBrowser(url) {
  const program = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('浏览器未能自动打开')));
  });
}
function options(argv) {
  const result = { command: 'start', open: true, port: Number(process.env.PORT || 3210) };
  let verb = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-open') result.open = false;
    else if (arg === '--help' || arg === '-h') result.command = 'help';
    else if (arg === '--version' || arg === '-v') result.command = 'version';
    else if (arg === '--port') { const value = argv[++i]; result.port = value && /^\d+$/.test(value) ? Number(value) : NaN; }
    else if (['start', 'open', 'status', 'stop', 'logs', '__serve', '__supervise'].includes(arg) && !verb) { result.command = arg; verb = true; }
    else throw new Error('不支持的参数：' + arg + '。使用 weixin-lite --help 查看帮助');
  }
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error('端口应为 0 到 65535 的整数');
  return result;
}
async function tail(dir) {
  try {
    const handle = await fs.open(path.join(dir, 'service.log'), 'r');
    try {
      const size = (await handle.stat()).size;
      const bytes = Buffer.alloc(Math.min(size, 8000));
      await handle.read(bytes, 0, bytes.length, size - bytes.length);
      // The browser token is usable locally; keep it out of diagnostic output.
      return bytes.toString().replace(/#[a-f0-9]{48}/g, '#[本机访问令牌]');
    } finally { await handle.close(); }
  } catch (e) { if (e.code === 'ENOENT') return '暂无运行日志'; throw e; }
}
const entryArgs = compiled => compiled ? [] : [fileURLToPath(new URL('../bin/weixin-lite.js', import.meta.url))];
async function rotateLog(dir) {
  try {
    if ((await fs.stat(path.join(dir, 'service.log'))).size > LOG_LIMIT_BYTES) await fs.rename(path.join(dir, 'service.log'), path.join(dir, 'service.log.1'));
  } catch {}
}
// Restarts the service after a crash; a clean exit means "weixin-lite stop" was used.
async function supervise(dir, initialPort, compiled) {
  const token = randomBytes(24).toString('hex');
  let child, stopping = false, port = initialPort, failures = 0;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; if (child) child.kill(signal); else process.exit(0); });
  while (true) {
    const startedAt = Date.now();
    child = spawn(process.execPath, [...entryArgs(compiled), '__serve', '--port', String(port)], { stdio: 'inherit', windowsHide: true,
      env: { ...process.env, WEIXIN_LITE_HOME: dir, WEIXIN_LITE_SERVICE_TOKEN: token, WEIXIN_LITE_SUPERVISOR: String(process.pid), BUN_BE_BUN: '0' } });
    const { code, signal } = await new Promise(resolve => {
      child.once('error', () => resolve({ code: STARTUP_FAILED }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child = null;
    if (stopping || code === 0) return;
    if (code === STARTUP_FAILED) { process.exitCode = STARTUP_FAILED; return; }
    if (Date.now() - startedAt > STABLE_MS) failures = 0;
    if (++failures > MAX_RESTARTS) { console.error(`服务连续异常退出 ${MAX_RESTARTS} 次，已停止重启`); process.exitCode = 1; return; }
    // Keep the same address so a page that is already open keeps working.
    const last = await readService(dir).catch(() => null);
    if (last?.supervisor === process.pid) port = Number(new URL(last.url).port);
    const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures);
    console.error(`服务异常退出（${signal || '退出码 ' + code}），${wait / 1000} 秒后重启`);
    await delay(wait);
  }
}
async function serve(dir, port, assets, compiled) {
  const { createApp } = await import('./server.js');
  const instanceId = randomBytes(16).toString('hex');
  const token = process.env.WEIXIN_LITE_SERVICE_TOKEN || undefined;
  const supervisor = Number(process.env.WEIXIN_LITE_SUPERVISOR) || undefined;
  delete process.env.WEIXIN_LITE_SERVICE_TOKEN; delete process.env.WEIXIN_LITE_SUPERVISOR;
  let app, stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    // Exit 0 even on a slow close: a requested stop must never look like a crash.
    const timer = setTimeout(() => process.exit(0), 5000); timer.unref();
    try {
      await app?.close();
      const current = await readService(dir);
      if (current?.instanceId === instanceId) await fs.unlink(serviceFile(dir));
    } finally { process.exit(0); }
  };
  const { Autostart } = await import('./system.js');
  const autostart = new Autostart({ command: [process.execPath, ...entryArgs(compiled), 'start', '--no-open'] });
  app = await createApp({ instanceId, assets, onShutdown: shutdown, token, autostart });
  let url;
  try { url = await app.listen(port); }
  catch (e) {
    // An unrelated program may occupy the default port. Select an available port.
    if (e.code !== 'EADDRINUSE' || port !== 3210) throw e;
    if (app.wechat.account.token) throw new Error('默认端口被占用且已有微信绑定，请先停止旧版服务，避免重复连接同一个 Bot');
    url = await app.listen(0);
  }
  const record = { pid: process.pid, instanceId, url, startedAt: new Date().toISOString(), version: VERSION, ...(supervisor ? { supervisor } : {}) };
  const temp = serviceFile(dir) + '.' + instanceId + '.tmp';
  await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
  await fs.rename(temp, serviceFile(dir));
  console.log(`微信小助理 ${VERSION} 后台服务已就绪，PID ${process.pid}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown());
  // Saved state is atomic, so restarting is safer than running on in an unknown state.
  for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => {
    console.error(`${new Date().toISOString()} 未处理的错误：`, app.store.redact(error?.stack || error));
    app.processes.stopAll(); process.exit(1);
  });
}

export async function main(argv = [], { compiled = false, assets } = {}) {
  const opts = options(argv);
  if (opts.command === 'help') {
    console.log(`微信小助理 ${VERSION}\n\n用法：weixin-lite [命令] [选项]\n\n  weixin-lite          后台启动并自动打开网页；已运行时打开原页面\n  weixin-lite status   查看运行状态\n  weixin-lite stop     停止后台服务和当前任务\n  weixin-lite logs     查看最近的运行日志\n\n选项：\n  --no-open           启动但不打开浏览器\n  --port <端口>       设置端口，默认 3210；0 表示自动选择\n  --version           查看版本\n  --help              查看帮助\n\n配置和微信登录保存在 ~/.weixin-lite，关闭网页和终端不影响服务。\n电脑休眠或关机期间无法响应；可在网页设置中开启登录后自动启动和防止休眠。`); return;
  }
  if (opts.command === 'version') { console.log(VERSION); return; }
  const dir = dataDirectory();
  if (opts.command === '__supervise') { await supervise(dir, opts.port, compiled); return; }
  if (opts.command === '__serve') {
    try { await serve(dir, opts.port, assets, compiled); }
    catch (e) { console.error('微信小助理：' + e.message); process.exit(STARTUP_FAILED); }
    return;
  }
  if (opts.command === 'logs') { console.log(await tail(dir)); return; }
  if (opts.command === 'status' || opts.command === 'stop') {
    const record = await readService(dir);
    if (!await probe(record)) {
      if (record && !staleRecord(record)) {
        if (isAlive(record.pid)) throw new Error('服务进程仍存在但暂时无法连接，请稍后重试；未操作该进程');
        if (isAlive(record.supervisor)) {
          if (opts.command === 'status') { console.log('微信小助理正在重启'); return; }
          process.kill(record.supervisor, 'SIGTERM');
          for (let i = 0; i < 30 && isAlive(record.supervisor); i++) await delay(100);
        }
      }
      console.log('微信小助理未运行'); return;
    }
    if (opts.command === 'status') { console.log(`微信小助理运行中 · PID ${record.pid}\n${record.url}\n数据目录：${dir}`); return; }
    const { base, headers } = connection(record);
    const res = await fetch(base + '/api/shutdown', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!res.ok) throw new Error('服务拒绝停止，请查看日志');
    for (let i = 0; i < 60; i++) {
      if (!await probe(record) && (await readService(dir))?.instanceId !== record.instanceId) {
        // The installer replaces the program next; Windows cannot do that while it is still running.
        for (let j = 0; j < 30 && isAlive(record.supervisor); j++) await delay(100);
        console.log('微信小助理已停止'); return;
      }
      await delay(100);
    }
    throw new Error('服务尚未完成退出，请稍后使用 status 查看');
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700);
  const release = await lock(dir);
  let record, reused = false;
  try {
    record = await readService(dir);
    if (await probe(record)) reused = true;
    else {
      if (record && !staleRecord(record) && (isAlive(record.pid) || isAlive(record.supervisor))) throw new Error('已有服务进程暂时无法连接，请稍后重试，避免重复启动微信连接');
      if (record) await fs.unlink(serviceFile(dir));
      await rotateLog(dir);
      const log = await fs.open(path.join(dir, 'service.log'), 'a', 0o600);
      const child = spawn(process.execPath, [...entryArgs(compiled), '__supervise', '--port', String(opts.port)], {
        cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, WEIXIN_LITE_HOME: dir, BUN_BE_BUN: '0' },
      });
      await log.close();
      let error, exited = false;
      child.once('error', e => { error = e; }); child.once('exit', () => { exited = true; }); child.unref();
      for (let i = 0; i < 120; i++) {
        if (error) throw error;
        record = await readService(dir);
        if (record?.supervisor === child.pid && await probe(record)) break;
        if (exited) throw new Error('服务启动失败：\n' + await tail(dir));
        await delay(100);
      }
      if (!record || !await probe(record)) throw new Error('启动超时，可用 weixin-lite logs 查看原因');
    }
  } finally { await release(); }
  console.log(`${reused ? '微信小助理已在运行，打开原页面' : '微信小助理已在后台启动'}\n${record.url}\n停止：weixin-lite stop`);
  if (opts.open) {
    try { await openBrowser(record.url); }
    catch { console.log('浏览器未能自动打开，请复制上面的完整链接。'); }
  }
}
