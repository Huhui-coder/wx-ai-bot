import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { Store } from './store.js';
import { Provider } from './provider.js';
import { Processes } from './processes.js';
import { Skills } from './skills.js';
import { Tools } from './tools.js';
import { Agent } from './agent.js';
import { Wechat } from './wechat.js';
import { Reminders } from './reminders.js';

export async function createApp({ store = new Store(), provider, wechatOptions,
  token = randomBytes(24).toString('hex'), assets: suppliedAssets, instanceId = randomBytes(16).toString('hex'), onShutdown } = {}) {
  let wechat;
  const processes = new Processes(task => {
    store.event('task', { task });
    if (task.owner === 'wechat' && task.status !== 'running' && wechat?.status === 'connected') {
      void wechat.send(`任务 ${task.id}：${task.status}\n退出码：${task.exitCode ?? '无'}\n${task.output.slice(-1600)}`).catch(e => { wechat.lastError = store.redact(e.message); });
    }
  });
  const skills = new Skills(store.dir, processes);
  const reminders = new Reminders(store, { getWechat: () => wechat });
  const tools = new Tools(store, skills, processes, reminders);
  provider ||= new Provider(() => store.config);
  const agent = new Agent(store, provider, tools);
  wechat = new Wechat(store, agent, wechatOptions);
  const assets = new Map();
  for (const [name, type] of [['index.html', 'text/html'], ['app.js', 'text/javascript'], ['style.css', 'text/css']]) {
    assets.set(name, { type, body: suppliedAssets?.[name] ?? await fs.readFile(new URL('../public/' + name, import.meta.url)) });
  }
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(store.redact(JSON.stringify(data)));
  };
  async function body(req) {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 256000) throw new Error('请求过大'); chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式不正确');
    return value;
  }
  const sameToken = value => {
    const a = Buffer.from(value || ''), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const address = server.address();
      const expected = `127.0.0.1:${address.port}`;
      if (req.headers.host !== expected && req.headers.host !== `localhost:${address.port}`) return json(res, 403, { error: '无效访问地址' });
      if (req.headers.origin && ![`http://${expected}`, `http://localhost:${address.port}`].includes(req.headers.origin)) return json(res, 403, { error: '不接受跨站请求' });
      const url = new URL(req.url, `http://${expected}`);
      if (!url.pathname.startsWith('/api/')) {
        const asset = assets.get(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (req.method !== 'GET' || !asset) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': asset.type + '; charset=utf-8' }); return res.end(asset.body);
      }
      if (!sameToken(req.headers.authorization?.replace(/^Bearer /, ''))) return json(res, 401, { error: '请使用启动时提供的完整本机链接打开应用' });
      if (req.method === 'GET' && url.pathname === '/api/runtime') {
        return json(res, 200, { app: 'weixin-lite', instanceId, pid: process.pid });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const messages = store.history.filter(m => ['user', 'assistant'].includes(m.role) && m.content)
          .slice(-60).map(m => ({ role: m.role, text: m.content }));
        return json(res, 200, { config: store.publicConfig(), wechat: wechat.view(), busy: Boolean(agent.active),
          skills: await skills.list(), tasks: processes.list(), approvals: tools.approvals(), messages,
          events: store.events.slice(-30), reminders: reminders.list(), dataDir: store.dir });
      }
      if (req.method !== 'POST') return json(res, 405, { error: '不支持的请求' });
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求' });
      const input = await body(req);
      switch (url.pathname) {
        case '/api/shutdown':
          if (!onShutdown) throw new Error('当前服务不由命令行管理');
          json(res, 200, { ok: true });
          setImmediate(() => void onShutdown());
          return;
        case '/api/config':
          if (agent.active || processes.list().some(t => t.status === 'running')) throw new Error('任务运行中，请先停止再修改设置');
          return json(res, 200, store.saveConfig(input));
        case '/api/model/test': return json(res, 200, { text: await provider.test(new AbortController().signal) });
        case '/api/chat': {
          if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000) throw new Error('消息应为 1 到 16000 字符');
          if (agent.active) return json(res, 409, { error: '正在处理，请等待或点击停止' });
          void agent.run(input.text.trim()).catch(() => {});
          return json(res, 202, { ok: true });
        }
        case '/api/stop': wechat.mediaController?.abort(); return json(res, 200, { text: agent.stop() });
        case '/api/new':
          if (agent.active) throw new Error('请先停止当前处理');
          store.clear(); return json(res, 200, { ok: true });
        case '/api/approve': return json(res, 200, tools.decide(input.id, input.approved === true));
        case '/api/skills/install': {
          if (agent.active) throw new Error('请等当前处理完成');
          return json(res, 200, await skills.install(input, new AbortController().signal));
        }
        case '/api/wechat/login': return json(res, 200, await wechat.login());
        case '/api/wechat/verify': wechat.verify(input.code); return json(res, 200, { ok: true });
        case '/api/wechat/start': wechat.start(); return json(res, 200, wechat.view());
        case '/api/wechat/stop': wechat.stop(); return json(res, 200, wechat.view());
        case '/api/wechat/retry': await wechat.flush(); return json(res, 200, wechat.view());
        case '/api/wechat/qr': {
          if (!wechat.loginState?.qrContent) throw new Error('请先生成二维码');
          return json(res, 200, { image: await QRCode.toDataURL(wechat.loginState.qrContent, { width: 280, margin: 2 }) });
        }
        case '/api/reminders/cancel': return json(res, 200, reminders.cancel(input.id));
        case '/api/task/stop': return json(res, 200, processes.stop(input.id));
        default: return json(res, 404, { error: '接口不存在' });
      }
    } catch (e) { if (!res.headersSent) json(res, 400, { error: store.redact(e.message) }); else res.end(); }
  });
  server.requestTimeout = 150000;
  return { server, store, provider, agent, tools, skills, processes, wechat, reminders, token,
    async listen(port = Number(process.env.PORT || 3210)) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      if (wechat.account.token) wechat.start();
      reminders.start();
      return `http://127.0.0.1:${server.address().port}/#${token}`;
    },
    async close() {
      reminders.stop(); agent.stop(); wechat.stop(); wechat.loginController?.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

