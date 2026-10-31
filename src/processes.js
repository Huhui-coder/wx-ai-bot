import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export class Processes {
  constructor(onChange = () => {}, { progressMs = 300_000 } = {}) { this.tasks = new Map(); this.onChange = onChange; this.progressMs = progressMs; }
  start(command, cwd, { timeoutMs = 120_000, signal, owner = 'local', executable, args } = {}) {
    const id = randomUUID().slice(0, 8);
    const task = { id, owner, command, cwd, status: 'running', output: '', startedAt: new Date().toISOString(), timeoutMs };
    // Do not pass model credentials or unrelated service secrets to child processes.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)));
    env.GIT_TERMINAL_PROMPT = '0';
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
    const shellArgs = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);' + command]
      : ['-lc', command];
    const child = spawn(executable || shell, args || shellArgs, {
      cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    task.child = child; this.tasks.set(id, task);
    for (const stream of [child.stdout, child.stderr]) {
      // A chunk boundary can split a multi-byte character.
      const decoder = new StringDecoder('utf8');
      stream.on('data', data => { task.output = (task.output + decoder.write(data)).slice(-18000); });
    }
    let killTimer, progressTimer;
    const kill = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']).on('error', () => {});
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    task.stop = () => { if (task.status === 'running') { task.status = 'cancelled'; kill(); } };
    const abort = () => task.stop();
    task.done = new Promise(resolve => {
      let finished = false;
      const finish = (code, error) => {
        if (finished) return; finished = true;
        clearTimeout(killTimer); clearInterval(progressTimer); signal?.removeEventListener('abort', abort);
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
    progressTimer = setInterval(() => { if (task.status === 'running') this.onChange({ ...this.view(id), progress: true }); }, this.progressMs);
    progressTimer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) task.stop();
    this.onChange(this.view(id));
    return task;
  }
  view(id) {
    const t = this.tasks.get(id);
    if (!t) throw new Error('任务不存在');
    const { child, stop, done, seen, ...view } = t; return view;
  }
  // The model reports a result it has read, so only results it never saw need their own notice.
  observe(id) {
    const { exitCode, ...view } = this.view(id);
    if (view.status !== 'running') this.tasks.get(id).seen = true;
    // A clean exit adds nothing and only ends up quoted in the reply to the user.
    return exitCode === 0 ? view : { ...view, exitCode };
  }
  takeUnseen(owner) {
    const found = [...this.tasks.values()].filter(t => t.owner === owner && t.status !== 'running' && !t.seen);
    for (const t of found) t.seen = true;
    return found.map(t => this.view(t.id));
  }
  list() { return [...this.tasks.keys()].map(id => this.view(id)).reverse(); }
  stop(id) { const task = this.tasks.get(id); if (!task) throw new Error('任务不存在'); task.stop(); return this.view(id); }
  stopAll() { for (const task of this.tasks.values()) task.stop(); }
}
