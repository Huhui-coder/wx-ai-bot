import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = process.argv[2] || `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
if (!/^bun-(darwin|linux|windows)-(arm64|x64)(-baseline)?$/.test(target)) throw new Error('不支持的编译目标');
await fs.mkdir(path.join(root, 'dist'), { recursive: true });
const output = path.join(root, 'dist', 'weixin-lite-' + target.slice(4) + (target.includes('windows') ? '.exe' : ''));
const result = spawnSync('bun', ['build', '--compile', '--minify', '--env=disable', '--target=' + target,
  path.join(root, 'scripts/standalone.js'), '--outfile', output], { cwd: root, stdio: 'inherit' });
if (result.error) throw new Error('构建需要开发者安装 Bun，最终用户无需安装。' + result.error.message);
if (result.status !== 0) process.exit(result.status || 1);
const stat = await fs.stat(output);
console.log(`已生成 ${output}\n大小 ${(stat.size / 1024 / 1024).toFixed(1)} MB；内含运行时与网页，无需 Node/Python。`);
