import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'yaml';

export function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function skillName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error('Skill 名称只允许字母、数字、短横线和下划线');
  return name;
}
export class Skills {
  constructor(dir, processes) { this.dir = path.join(dir, 'skills'); this.processes = processes; }
  async list() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.dir, { withFileTypes: true });
    const result = [];
    for (const item of entries) {
      if (!item.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.name)) continue;
      try {
        const text = await this.read(item.name);
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        const meta = match ? parse(match[1]) || {} : {};
        result.push({ name: item.name, description: String(meta.description || '').slice(0, 500),
          path: path.join(this.dir, item.name, 'SKILL.md') });
      } catch {}
    }
    return result;
  }
  async read(name, file = 'SKILL.md') {
    const root = await fs.realpath(path.join(this.dir, skillName(name)));
    const realDir = await fs.realpath(this.dir);
    if (!within(realDir, root)) throw new Error('Skill 路径越界');
    const target = await fs.realpath(path.resolve(root, file));
    if (!within(root, target)) throw new Error('Skill 文件路径越界');
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 128000) throw new Error('Skill 文件不是文本文件或过大');
    return await fs.readFile(target, 'utf8');
  }
  async install({ name, source, subdir = '' }, signal) {
    skillName(name);
    if (typeof source !== 'string' || !source.trim()) throw new Error('请提供本地 Skill 目录或 GitHub HTTPS 仓库地址');
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = path.join(this.dir, name);
    try { await fs.lstat(target); throw new Error('同名 Skill 已存在，请使用新名称'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-skill-'));
    try {
      let root;
      if (source.startsWith('https://')) {
        const url = new URL(source);
        if (url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) throw new Error('目前仅支持 github.com 的 HTTPS 仓库地址');
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 2 || !parts.every(p => /^[a-zA-Z0-9_.-]+$/.test(p))) throw new Error('请填写仓库根地址，子目录单独填写');
        root = path.join(temp, 'repo');
        const hooks = path.join(temp, 'empty-hooks'); await fs.mkdir(hooks);
        const task = this.processes.start(`下载 Skill：${url.href}`, temp, { signal, timeoutMs: 90000,
          executable: 'git', args: ['-c', 'core.hooksPath=' + hooks, 'clone', '--depth=1', '--', url.href, root] });
        const done = await task.done;
        if (done.exitCode !== 0 || done.status !== 'done') throw new Error('Skill 下载失败：' + done.output.slice(-1000));
      } else {
        if (!path.isAbsolute(source)) throw new Error('本地来源必须填写绝对路径');
        root = await fs.realpath(source);
      }
      const selected = await fs.realpath(path.resolve(root, subdir));
      if (!within(root, selected)) throw new Error('Skill 子目录越界');
      const stat = await fs.stat(path.join(selected, 'SKILL.md'));
      if (stat.size > 128000) throw new Error('SKILL.md 文件过大');
      // Copy documentation/scripts without executing installers or accepting symlink escapes.
      let count = 0, bytes = 0;
      const inspect = async dir => {
        for (const item of await fs.readdir(dir, { withFileTypes: true })) {
          if (item.name === '.git' || item.name === 'node_modules') continue;
          if (item.isSymbolicLink()) throw new Error('第一版不接受包含符号链接的 Skill');
          const itemPath = path.join(dir, item.name);
          if (++count > 5000) throw new Error('Skill 文件数量过多');
          if (item.isDirectory()) await inspect(itemPath);
          else { bytes += (await fs.stat(itemPath)).size; if (bytes > 30_000_000) throw new Error('Skill 超过 30 MB'); }
        }
      };
      await inspect(selected); signal?.throwIfAborted();
      // Stage under the same filesystem, then make the skill visible atomically.
      const staging = await fs.mkdtemp(path.join(this.dir, '.install-'));
      try {
        await fs.cp(selected, staging, { recursive: true, dereference: false,
          filter: p => !['.git', 'node_modules'].includes(path.basename(p)) });
        signal?.throwIfAborted();
        await fs.rename(staging, target);
      } catch (e) { await fs.rm(staging, { recursive: true, force: true }); throw e; }
      return { name, path: target, installed: true, note: '已安装说明和脚本；额外的软件依赖需按 Skill 说明另行安装。' };
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
}
