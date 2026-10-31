import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { imageDirectory } from './images.js';
import { commandPrefixes } from './grants.js';

export const dataDirectory = () => path.resolve(process.env.WEIXIN_LITE_HOME || path.join(os.homedir(), '.weixin-lite'));
const HISTORY_LIMIT = 600, HISTORY_KEEP = 400;
// Windows scanners briefly hold files open; POSIX private files never hit these codes.
function retryBusy(action) {
  for (let attempt = 0; ; attempt++) {
    try { return action(); }
    catch (e) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 5) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

export class Store {
  constructor(dir = dataDirectory()) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    this.config = {
      baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '',
      workspace: process.cwd(), allowMutations: false, allowedCommands: [], vision: false,
      keepAwake: false, maxCommandMinutes: 30,
      systemPrompt: '用中文沟通，回答简洁，先完成任务再汇报真实结果。',
      ...this.read('config', {}),
    };
    this.config.imageDirectory ||= path.join(this.config.workspace, '微信收件箱');
    this.wechatToken = this.read('wechat', {}).token;
    this.events = [];
    this.history = this.read('history', []);
    // A restart must never replay a tool call whose execution status is unknown.
    const results = new Set(this.history.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    for (const m of [...this.history]) for (const call of m.tool_calls || []) {
      if (!results.has(call.id)) this.history.push({ role: 'tool', tool_call_id: call.id,
        content: '应用重启，本次工具结果未知。不要自动重放修改操作；先检查实际状态。' });
    }
    this.write('history', this.history);
  }
  read(name, fallback) {
    const file = path.join(this.dir, name + '.json');
    const parse = target => JSON.parse(retryBusy(() => fs.readFileSync(target, 'utf8')));
    try { return parse(file); }
    catch (e) {
      if (e.code === 'ENOENT') return fallback;
      try {
        const value = parse(file + '.bak');
        console.error(`${name}.json 已损坏，已恢复到上一次保存的内容`);
        return value;
      } catch { throw new Error(`${name}.json 无法读取，请检查本地数据文件`); }
    }
  }
  write(name, value) {
    const target = path.join(this.dir, name + '.json');
    const temp = target + '.' + randomUUID() + '.tmp';
    const handle = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(value, null, 2)); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
    // Keep the previous good version; a hard link costs nothing even for long histories.
    try { fs.rmSync(target + '.bak', { force: true }); fs.linkSync(target, target + '.bak'); } catch {}
    try { retryBusy(() => fs.renameSync(temp, target)); }
    catch (e) { fs.rmSync(temp, { force: true }); throw e; }
    if (name === 'wechat') this.wechatToken = value?.token;
  }
  saveConfig(patch) {
    const next = { ...this.config };
    for (const k of ['baseUrl', 'model', 'apiKey', 'workspace', 'systemPrompt', 'imageDirectory']) {
      if (typeof patch[k] === 'string') next[k] = patch[k].trim();
    }
    for (const k of ['allowMutations', 'vision', 'keepAwake']) {
      if (typeof patch[k] === 'boolean') next[k] = patch[k];
    }
    if (patch.allowedCommands !== undefined) next.allowedCommands = commandPrefixes(patch.allowedCommands);
    if (patch.maxCommandMinutes !== undefined) {
      if (!Number.isInteger(patch.maxCommandMinutes) || patch.maxCommandMinutes < 1 || patch.maxCommandMinutes > 720) throw new Error('命令最长运行时间应为 1 到 720 分钟的整数');
      next.maxCommandMinutes = patch.maxCommandMinutes;
    }
    const url = new URL(next.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型地址必须是有效 HTTP(S) 地址，不能包含密码、查询参数或片段');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程模型接口必须使用 HTTPS');
    if (!next.model || next.model.length > 160) throw new Error('请填写模型名称');
    next.workspace = fs.realpathSync(path.resolve(next.workspace));
    if (!fs.statSync(next.workspace).isDirectory()) throw new Error('工作目录不存在');
    next.imageDirectory = imageDirectory(next.imageDirectory, this.dir);
    // Validate existing aliases now; newly created folders are checked again at save time.
    if (fs.existsSync(next.imageDirectory)) {
      if (!fs.statSync(next.imageDirectory).isDirectory()) throw new Error('图片保存路径必须是文件夹');
      next.imageDirectory = imageDirectory(fs.realpathSync(next.imageDirectory), fs.realpathSync(this.dir));
    }
    this.write('config', next); this.config = next;
    return this.publicConfig();
  }
  publicConfig() {
    const { apiKey, ...rest } = this.config;
    return { ...rest, hasApiKey: Boolean(apiKey || process.env.DEEPSEEK_API_KEY) };
  }
  redact(value) {
    let result = String(value);
    for (const secret of [this.config.apiKey, process.env.DEEPSEEK_API_KEY, this.wechatToken]) {
      if (secret) result = result.split(secret).join('[已隐藏密钥]');
    }
    return result;
  }
  event(type, data) {
    this.events.push({ id: randomUUID(), type, at: new Date().toISOString(),
      ...JSON.parse(this.redact(JSON.stringify(data))) });
    this.events = this.events.slice(-120);
  }
  add(message) {
    this.history.push(message);
    // Cut at a user turn so a tool call is never separated from its result.
    if (this.history.length > HISTORY_LIMIT) {
      const start = this.history.findIndex((m, i) => i >= this.history.length - HISTORY_KEEP && m.role === 'user');
      if (start > 0) this.history = this.history.slice(start);
    }
    this.write('history', this.history);
  }
  clear() {
    this.history = []; this.write('history', []);
    fs.rmSync(path.join(this.dir, 'history.json.bak'), { force: true });
  }
}
