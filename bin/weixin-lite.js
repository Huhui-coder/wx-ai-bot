#!/usr/bin/env node
import { main } from '../src/launcher.js';
try { await main(process.argv.slice(2)); }
catch (error) { console.error('微信小助理：' + error.message); process.exitCode = 1; }
