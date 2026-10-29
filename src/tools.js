import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { within } from './skills.js';

const field = (description, type = 'string') => ({ type, description });
const tool = (name, description, properties, required = []) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
} });
export const definitions = [
  tool('list_directory', '列出工作目录内的文件和文件夹。', { path: field('相对工作目录的路径，默认 .') }),
  tool('read_file', '读取工作目录内的文本文件。', { path: field('相对或绝对文件路径') }, ['path']),
  tool('write_file', '创建或覆盖工作目录内的文本文件。', { path: field('文件路径'), content: field('完整文件内容') }, ['path', 'content']),
  tool('run_command', '在本机执行 shell 命令，包括 npm、python、Skill 脚本。返回任务 ID，可继续查询。仅当用户要求操作时使用。', {
    command: field('完整 shell 命令'), cwd: field('工作目录内的相对路径，默认 .'),
  }, ['command']),
  tool('command_status', '查询任务结果或停止任务。', {
    id: field('任务 ID'), stop: field('是否停止任务，默认 false', 'boolean'),
    waitSeconds: field('等待结果秒数，0 到 10', 'number'),
  }, ['id']),
  tool('list_skills', '列出已安装 Skill 的名称和简介。安装新 Skill 后立即可用。', {}),
  tool('read_skill', '读取某个 Skill 的 SKILL.md 或附带的参考文件。使用 Skill 前必须读说明。', {
    name: field('已安装 Skill 名称'), file: field('Skill 内的相对路径，默认 SKILL.md'),
  }, ['name']),
  tool('install_skill', '从本地绝对目录或 GitHub HTTPS 仓库安装 Skill（目录必须含 SKILL.md）。只下载文件，不自动执行安装脚本。', {
    name: field('安装名称，字母数字与短横线'), source: field('本地绝对目录或 https://github.com/owner/repo'),
    subdir: field('仓库内 Skill 所在子目录，默认仓库根目录'),
  }, ['name', 'source']),
];

export class Tools {
  constructor(store, skills, processes) { this.store = store; this.skills = skills; this.processes = processes; this.pending = new Map(); }
  async resolvePath(input = '.', write = false) {
    if (typeof input !== 'string') throw new Error('路径必须是字符串');
    const root = await fs.realpath(this.store.config.workspace);
    const candidate = path.resolve(root, input);
    if (!within(root, candidate)) throw new Error('文件工具只访问设置的工作目录');
    let existing = candidate;
    if (write) {
      while (true) { try { await fs.lstat(existing); break; } catch (e) {
        if (e.code !== 'ENOENT') throw e; existing = path.dirname(existing);
      } }
    }
    const actual = await fs.realpath(existing);
    if (!within(root, actual)) throw new Error('符号链接指向工作目录之外');
    const privateRoot = await fs.realpath(this.store.dir);
    if (within(privateRoot, actual) || within(privateRoot, candidate)) throw new Error('不能通过文件工具访问应用凭据和内部状态');
    return candidate;
  }
  async permission(name, args, context) {
    if (this.store.config.allowMutations) return;
    const id = randomUUID().slice(0, 8);
    let resolve;
    const decision = new Promise(r => { resolve = r; });
    const info = { id, name, args, at: new Date().toISOString() };
    this.pending.set(id, { info, resolve });
    const cancel = () => resolve(false);
    context.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => resolve(false), 300_000);
    try {
      await context.notify({ type: 'approval', ...info });
      if (context.signal.aborted) resolve(false);
      if (!await decision) throw new Error('操作未获得授权或已取消，未执行');
      context.signal.throwIfAborted();
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', cancel); this.pending.delete(id); }
  }
  decide(id, approved) {
    const pending = this.pending.get(id);
    if (!pending) throw new Error('审批已结束或不存在');
    pending.resolve(approved); return { ok: true };
  }
  approvals() { return [...this.pending.values()].map(p => p.info); }
  async execute(name, args, context) {
    context.signal.throwIfAborted();
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
    if (!definitions.some(t => t.function.name === name)) throw new Error('不支持的工具：' + name);
    if (['run_command', 'write_file', 'install_skill'].includes(name)) await this.permission(name, args, context);
    context.signal.throwIfAborted();
    switch (name) {
      case 'list_directory': {
        const entries = await fs.readdir(await this.resolvePath(args.path), { withFileTypes: true });
        return entries.slice(0, 500).map(e => ({ name: e.name, directory: e.isDirectory() }));
      }
      case 'read_file': {
        const file = await this.resolvePath(args.path);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 128000) throw new Error('只读取不超过 128 KB 的文本文件');
        return await fs.readFile(file, 'utf8');
      }
      case 'write_file': {
        if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 128000) throw new Error('写入内容必须为不超过 128 KB 的文本');
        const file = await this.resolvePath(args.path, true);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, args.content, 'utf8');
        return { written: file, bytes: Buffer.byteLength(args.content) };
      }
      case 'run_command': {
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000) throw new Error('命令不能为空或过长');
        if (this.processes.list().filter(t => t.status === 'running').length >= 3) throw new Error('已有 3 个任务运行，请等待或停止已有任务');
        const cwd = await this.resolvePath(args.cwd || '.');
        const task = this.processes.start(args.command, cwd, { signal: context.signal, owner: context.owner });
        await Promise.race([task.done, new Promise(r => setTimeout(r, 1000))]);
        return this.processes.view(task.id);
      }
      case 'command_status': {
        if (args.stop) return this.processes.stop(args.id);
        const task = this.processes.tasks.get(args.id);
        if (!task) throw new Error('任务不存在');
        const wait = Math.min(10, Math.max(0, Number(args.waitSeconds) || 0));
        if (wait && task.status === 'running') await Promise.race([task.done, new Promise(r => setTimeout(r, wait * 1000))]);
        return this.processes.view(args.id);
      }
      case 'list_skills': return this.skills.list();
      case 'read_skill': return this.skills.read(args.name, args.file);
      case 'install_skill': return this.skills.install(args, context.signal);
    }
  }
}
