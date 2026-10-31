import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { within } from './skills.js';

const LABEL = 'com.weixin-lite.assistant';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE = 'WeixinLite';
// macOS privacy protection: a launchd job has no consent for these folders.
const PROTECTED_FOLDERS = ['Desktop', 'Documents', 'Downloads'];
const defaultExec = promisify(execFile);
const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchAgent(command, { workingDirectory, environment = {} }) {
  const strings = items => items.map(item => `    <string>${escapeXml(item)}</string>`).join('\n');
  const variables = Object.entries(environment).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(command)}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${variables}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
</dict>
</plist>
`;
}
export const runValue = command => command.map(part => `"${part}"`).slice(0, -2).concat(command.slice(-2)).join(' ');

// The launcher only starts the service at login; supervision stays in the program.
export class Autostart {
  constructor({ command, platform = process.platform, home = os.homedir(), env = process.env, exec = defaultExec } = {}) {
    Object.assign(this, { command, platform, home, env, exec });
    this.enabled = false;
    this.plist = path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist');
  }
  get supported() { return Boolean(this.command) && ['darwin', 'win32'].includes(this.platform); }
  view() { return { supported: this.supported, enabled: this.enabled }; }
  isProtected(target) {
    return this.platform === 'darwin' && PROTECTED_FOLDERS.some(name => within(path.join(this.home, name), target));
  }
  async refresh() {
    if (!this.supported) return this.view();
    try {
      if (this.platform === 'darwin') await fs.access(this.plist);
      else await this.exec('reg', ['query', RUN_KEY, '/v', VALUE], { windowsHide: true });
      this.enabled = true;
    } catch { this.enabled = false; }
    return this.view();
  }
  async set(enabled, { workingDirectory = process.cwd() } = {}) {
    if (!this.supported) throw new Error('当前系统不支持开机启动');
    // A protected program blocks forever at login with nobody to answer the prompt.
    if (enabled && this.command.some(part => path.isAbsolute(part) && this.isProtected(part))) throw new Error('程序位于桌面、文稿或下载文件夹，登录时 macOS 会阻止它启动。请改用安装版（~/.local/bin/weixin-lite）后再开启');
    if (this.platform === 'darwin') {
      if (enabled) {
        // launchd starts with a bare environment; keep the PATH the user's commands rely on.
        const environment = Object.fromEntries(['PATH', 'SHELL', 'WEIXIN_LITE_HOME'].filter(key => this.env[key]).map(key => [key, this.env[key]]));
        await fs.mkdir(path.dirname(this.plist), { recursive: true });
        const temp = this.plist + '.tmp';
        await fs.writeFile(temp, launchAgent(this.command, { workingDirectory, environment }), { mode: 0o644 });
        await fs.rename(temp, this.plist);
      } else await fs.rm(this.plist, { force: true });
    } else if (enabled) await this.exec('reg', ['add', RUN_KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', runValue(this.command), '/f'], { windowsHide: true });
    else await this.exec('reg', ['delete', RUN_KEY, '/v', VALUE, '/f'], { windowsHide: true }).catch(() => {});
    this.enabled = enabled;
    return { ...this.view(), ...(enabled && this.isProtected(workingDirectory) ? { warning: '已开启。工作目录在桌面、文稿或下载文件夹，登录后首次访问时 macOS 可能弹窗询问，请选择允许' } : {}) };
  }
}

export function keepAwakeCommand(pid, platform = process.platform) {
  // Both helpers end with the service, so a crash cannot leave the computer awake.
  if (platform === 'darwin') return { program: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'win32') return { program: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$k=Add-Type -PassThru -Name Power -Namespace WeixinLite -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';[void]$k::SetThreadExecutionState(2147483649);Wait-Process -Id ${pid}`] };
  return null;
}
export class KeepAwake {
  constructor({ pid = process.pid, platform = process.platform, spawner = spawn } = {}) {
    Object.assign(this, { pid, platform, spawner }); this.child = null; this.error = '';
  }
  apply(enabled) {
    if (!enabled) { this.child?.kill(); this.child = null; return; }
    if (this.child) return;
    const command = keepAwakeCommand(this.pid, this.platform);
    if (!command) { this.error = '当前系统不支持防止休眠'; return; }
    const child = this.spawner(command.program, command.args, { stdio: 'ignore', windowsHide: true });
    this.child = child; this.error = '';
    child.on('error', e => { this.error = '无法阻止休眠：' + e.message; if (this.child === child) this.child = null; });
    child.on('exit', () => { if (this.child === child) this.child = null; });
  }
}

export function screenshotCommand(file, platform = process.platform) {
  if (platform === 'darwin') return { executable: 'screencapture', args: ['-x', file] };
  if (platform === 'win32') return { executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height;$g=[System.Drawing.Graphics]::FromImage($i);$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);$i.Save('${file.replaceAll("'", "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`] };
  throw new Error('当前系统不支持截屏');
}
