import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export class Processes {
  constructor(onChange = () => {}) { this.tasks = new Map(); this.onChange = onChange; }
  start(command, cwd, { timeoutMs = 120_000, signal, owner = 'local', executable, args } = {}) {
    const id = randomUUID().slice(0, 8);
    const task = { id, owner, command, cwd, status: 'running', output: '', startedAt: new Date().toISOString() };
    // Do not pass model credentials or unrelated service secrets to child processes.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)));
    env.GIT_TERMINAL_PROMPT = '0';
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
    const shellArgs = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
      : ['-lc', command];
    const child = spawn(executable || shell, args || shellArgs, {
      cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    task.child = child; this.tasks.set(id, task);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      task.output = (task.output + data.toString()).slice(-18000);
    });
    let killTimer;
    const kill = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    task.stop = () => { if (task.status === 'running') { task.status = 'cancelled'; kill(); } };
    const abort = () => task.stop();
    task.done = new Promise(resolve => {
      let finished = false;
      const finish = (code, error) => {
        if (finished) return; finished = true;
        clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
        if (task.status === 'running') task.status = code === 0 ? 'done' : 'failed';
        task.exitCode = code; task.endedAt = new Date().toISOString();
        if (error) task.output += '\n' + error;
        this.onChange(this.view(id)); resolve(this.view(id));
        // Keep bounded output and task metadata in memory.
        if (this.tasks.size > 50) for (const [key, t] of this.tasks) {
          if (this.tasks.size <= 50) break;
          if (t.status !== 'running') this.tasks.delete(key);
        }
      };
      child.on('error', e => finish(null, e.message));
      child.on('close', code => finish(code));
    });
    killTimer = setTimeout(() => { if (task.status === 'running') { task.status = 'timeout'; kill(); } }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) task.stop();
    this.onChange(this.view(id));
    return task;
  }
  view(id) {
    const t = this.tasks.get(id);
    if (!t) throw new Error('任务不存在');
    const { child, stop, done, ...view } = t; return view;
  }
  list() { return [...this.tasks.keys()].map(id => this.view(id)).reverse(); }
  stop(id) { const task = this.tasks.get(id); if (!task) throw new Error('任务不存在'); task.stop(); return this.view(id); }
  stopAll() { for (const task of this.tasks.values()) task.stop(); }
}
