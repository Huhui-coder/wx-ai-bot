import html from '../public/index.html' with { type: 'text' };
import javascript from '../public/app.js' with { type: 'text' };
import css from '../public/style.css' with { type: 'text' };
import { main } from '../src/launcher.js';

try {
  await main(process.argv.slice(2), { compiled: true,
    assets: { 'index.html': html, 'app.js': javascript, 'style.css': css } });
} catch (error) { console.error('微信小助理：' + error.message); process.exitCode = 1; }
