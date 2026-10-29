import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { saveImage, mediaDay } from './images.js';
import { saveAttachment } from './attachments.js';
import { reminderTime, reminderDeliveryId } from './reminders.js';

const API = 'https://ilinkai.weixin.qq.com';
const VERSION = '2.4.10';
export function wechatURL(value) {
  const url = new URL(value.startsWith('https://') ? value : 'https://' + value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('微信服务返回了不受支持的接口地址');
  return url.origin;
}
export function parseWechatJSON(text) {
  return JSON.parse(text, (key, value, context) => {
    if (['message_id', 'msg_id', 'svr_id'].includes(key) && typeof value === 'number') {
      if (context?.source) return context.source;
      if (!Number.isSafeInteger(value)) throw new Error('当前 Node 版本不能无损读取微信消息 ID，请使用 Node 22.13+');
      return String(value);
    }
    return value;
  });
}
export function inboundText(msg) {
  return (msg.item_list || []).map(item => item.type === 1 ? item.text_item?.text || '' :
    item.type === 3 ? item.voice_item?.text || '' : '').filter(Boolean).join('\n').trim();
}
export class Wechat {
  constructor(store, agent, { fetcher = fetch } = {}) {
    this.store = store; this.agent = agent; this.fetcher = fetcher;
    this.account = store.read('wechat', {});
    this.state = { cursor: '', seen: [], inbox: [], outbox: [], deliveredReminders: [], ...store.read('wechat-state', {}) };
    for (const job of this.state.inbox) {
      if (job.images) { job.media = job.images.map(item => ({ type: 'image', item })); job.savedMedia = job.savedImages || []; delete job.images; delete job.savedImages; }
      if (job.status === 'running') job.status = job.media ? 'pending' : 'interrupted';
    }
    this.status = this.account.token ? 'stopped' : 'unbound';
    this.lastError = ''; this.loginState = null; this.draining = false;
  }
  save() { this.store.write('wechat-state', this.state); }
  view() {
    return { status: this.status, accountId: this.account.botId || '', bound: Boolean(this.account.token),
      imageSaving: Boolean(this.mediaController && !this.mediaController.signal.aborted),
      lastError: this.lastError, pendingReplies: this.state.outbox.length,
      login: this.loginState ? { status: this.loginState.status, qr: this.loginState.qrContent,
        error: this.loginState.error || '' } : null };
  }
  async request(endpoint, body, { base = this.account.baseUrl || API, token = this.account.token,
    signal, method = 'POST', timeout = 40000, metadata = true } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10) };
    if (method === 'POST') Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) });
    const res = await this.fetcher(`${wechatURL(base)}/${endpoint}`, { method, headers,
      redirect: 'error', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeout)]),
      ...(body !== undefined ? { body: JSON.stringify({ ...body,
        ...(metadata ? { base_info: { channel_version: VERSION, bot_agent: 'WeixinLite/0.5.1' } } : {}) }) } : {}),
    });
    if (!res.ok) throw new Error(`微信接口 HTTP ${res.status}`);
    const data = parseWechatJSON(await res.text());
    if (data.ret || data.errcode) {
      const code = data.errcode || data.ret;
      const error = new Error(`微信接口错误 ${code}`); error.code = code; throw error;
    }
    return data;
  }
  async login() {
    if (this.agent.active) throw new Error('请先停止当前处理，再重新绑定微信');
    this.stop();
    this.loginController?.abort();
    const controller = new AbortController(); this.loginController = controller;
    const qr = await this.request('ilink/bot/get_bot_qrcode?bot_type=3',
      { local_token_list: this.account.token ? [this.account.token] : [] },
      { base: API, token: '', metadata: false, signal: controller.signal });
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('微信没有返回二维码');
    const state = { status: 'wait', qrcode: qr.qrcode, qrContent: qr.qrcode_img_content, base: API };
    this.loginState = state;
    void this.pollLogin(state, controller.signal);
    return this.view();
  }
  verify(code) {
    if (!this.loginState || this.loginState.status !== 'need_verifycode') throw new Error('当前无需验证码');
    if (typeof code !== 'string' || !/^\d{1,12}$/.test(code)) throw new Error('请输入手机微信显示的数字');
    this.loginState.verifyCode = code; this.loginState.status = 'wait';
  }
  async pollLogin(state, signal) {
    const deadline = Date.now() + 300000;
    try {
      while (!signal.aborted && Date.now() < deadline) {
        if (state.status === 'need_verifycode' && !state.verifyCode) { await delay(500, undefined, { signal }); continue; }
        const suffix = state.verifyCode ? '&verify_code=' + encodeURIComponent(state.verifyCode) : '';
        let data;
        try { data = await this.request('ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(state.qrcode) + suffix,
          undefined, { method: 'GET', base: state.base, token: '', signal }); }
        catch (e) { if (signal.aborted) return; state.error = e.message; await delay(2000, undefined, { signal }); continue; }
        state.error = ''; state.status = data.status;
        if (data.status === 'scaned_but_redirect') { state.base = wechatURL(data.redirect_host); }
        if (data.status === 'scaned') state.verifyCode = '';
        if (data.status === 'need_verifycode') state.verifyCode = '';
        if (data.status === 'confirmed') {
          if (!data.bot_token || !data.ilink_user_id || !data.ilink_bot_id) throw new Error('扫码成功但缺少用户绑定信息，请重新扫码');
          this.stop();
          this.account = { token: data.bot_token, userId: data.ilink_user_id, botId: data.ilink_bot_id,
            baseUrl: wechatURL(data.baseurl || API) };
          this.state = { cursor: '', seen: [], inbox: [], outbox: [] }; this.save();
          this.store.write('wechat', this.account);
          this.start(); return;
        }
        if (data.status === 'binded_redirect') {
          if (!this.account.token) throw new Error('此 Bot 已绑定，但本机没有凭据，请在微信解除旧绑定后重试');
          this.start(); return;
        }
        if (['expired', 'verify_code_blocked'].includes(data.status)) return;
        await delay(1000, undefined, { signal });
      }
      if (!signal.aborted) state.status = 'expired';
    } catch (e) { if (!signal.aborted) { state.status = 'error'; state.error = e.message; } }
  }
  start() {
    if (!this.account.token) throw new Error('请先扫码绑定微信');
    this.pollController?.abort(); const controller = new AbortController(); this.pollController = controller;
    this.status = 'connected'; this.lastError = '';
    void this.poll(controller.signal); void this.drain();
  }
  stop() { if (this.mediaController) { this.mediaController.resumeAfterStop = true; this.mediaController.abort(); } this.pollController?.abort(); this.status = this.account.token ? 'stopped' : 'unbound'; }
  async poll(signal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const data = await this.request('ilink/bot/getupdates', { get_updates_buf: this.state.cursor }, { signal });
        if (signal.aborted) return;
        for (const msg of data.msgs || []) await this.ingest(msg);
        if (data.get_updates_buf) this.state.cursor = data.get_updates_buf;
        this.save(); this.status = 'connected'; this.lastError = ''; failures = 0;
        void this.drain();
        // Prevent a tight loop if a server responds immediately with no messages.
        await delay(250, undefined, { signal });
      } catch (e) {
        if (signal.aborted) return;
        if ([-14, -13].includes(e.code)) { this.status = 'expired'; this.lastError = '微信登录已失效，请重新扫码'; return; }
        if (['TimeoutError', 'AbortError'].includes(e.name)) continue;
        this.status = 'reconnecting'; this.lastError = this.store.redact(e.message);
        try { await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal }); } catch { return; }
      }
    }
  }
  async ingest(msg) {
    // Ownership applies before commands, context updates, history and model calls.
    if (msg.from_user_id !== this.account.userId || msg.message_type === 2) return;
    const id = String(msg.message_id || msg.msg_id || '');
    if (!id) { this.lastError = '收到缺少消息 ID 的消息，未执行'; return; }
    if (this.state.seen.includes(id)) return;
    if (msg.context_token) this.state.context = msg.context_token;
    const text = inboundText(msg);
    const media = (msg.item_list || []).flatMap(item => item.type === 2 ? [{ type: 'image', item: item.image_item || {} }] : item.type === 4 ? [{ type: 'file', item: item.file_item || {} }] : []);
    this.state.seen.push(id); this.state.seen = this.state.seen.slice(-2000);
    if ((!text && !media.length) || text.length > 16000) { this.save(); return; }
    if (this.state.inbox.filter(j => ['pending', 'running'].includes(j.status)).length >= 10 && (media.length || !text.startsWith('/'))) {
      this.save(); await this.send('等待处理的消息较多，请稍后再发。').catch(() => {}); return;
    }
    if (media.length > 9) { this.save(); await this.send('一条消息最多保存 9 个图片或附件，请分批发送。').catch(() => {}); return; }
    const job = { id, text, status: 'pending', ...(media.length ? { media, savedMedia: [],
      directory: this.store.config.imageDirectory, day: mediaDay() } : {}) };
    this.state.inbox.push(job);
    this.state.inbox = this.state.inbox.filter(j => ['pending', 'running'].includes(j.status)).concat(
      this.state.inbox.filter(j => !['pending', 'running'].includes(j.status)).slice(-30));
    this.save();
    // Control messages bypass the agent queue so a waiting tool can be approved/stopped.
    if (!media.length && /^\/(approve|deny|stop|help|tasks|skills|new|reminders|cancel)(?:\s|$)/.test(text)) {
      job.status = 'running'; this.save();
      let reply;
      try { reply = await this.control(text); job.status = 'done'; }
      catch (e) { reply = this.store.redact(e.message); job.status = 'failed'; }
      this.save(); await this.send(reply).catch(e => { this.lastError = e.message; });
    }
  }
  async control(text) {
    const [name, id] = text.trim().split(/\s+/);
    if (name === '/approve' || name === '/deny') { this.agent.tools.decide(id, name === '/approve'); return name === '/approve' ? '已允许本次操作' : '已拒绝本次操作'; }
    if (name === '/stop') {
      for (const job of this.state.inbox) if (job.status === 'pending') job.status = 'cancelled';
      this.mediaController?.abort();
      this.save(); return this.agent.stop();
    }
    if (name === '/new') {
      if (this.agent.active) throw new Error('请先 /stop，再开始新会话');
      this.store.clear(); return '已开始新会话';
    }
    if (name === '/reminders') {
      const items = this.agent.tools.reminders.list().reminders.filter(r => ['scheduled', 'queued', 'blocked'].includes(r.status));
      return items.map(r => `${r.id}\n${r.repeat ? r.repeatLabel + '\n下一次：' : ''}${r.localTime} · ${r.text} · ${r.status === 'blocked' ? '绑定改变，未发送' : r.status === 'queued' ? '等待发送' : '待提醒'}`).join('\n\n') || '暂无未完成提醒（所有时间均为北京时间）';
    }
    if (name === '/cancel') { const item = this.agent.tools.reminders.cancel(id); return `已取消${item.repeat ? '整组重复' : ''}提醒：${item.text}\n编号：${item.id}`; }
    if (name === '/skills') return (await this.agent.tools.skills.list()).map(s => `${s.name}：${s.description}`).join('\n') || '尚未安装 Skill';
    if (name === '/tasks') return this.agent.tools.processes.list().map(t => `${t.id} ${t.status} ${t.command}`).join('\n') || '暂无任务';
    return '直接聊天即可使用配置的模型。发图片或文件会自动保存到本机，并回复保存位置。\n/skills 已安装技能\n/tasks 任务状态\n/reminders 查看提醒（北京时间）\n/cancel 编号 取消提醒\n/stop 停止任务\n/new 新会话\n/approve 编号 允许操作\n/deny 编号 拒绝操作';
  }
  async drain() {
    if (this.draining || this.status === 'stopped' || this.status === 'unbound') return;
    this.draining = true;
    try {
      while (!['stopped', 'unbound', 'expired'].includes(this.status)) {
        const job = this.state.inbox.find(j => j.status === 'pending');
        if (!job) break;
        if (job.media) { await this.receiveMedia(job); continue; }
        if (this.agent.active) { await delay(500); continue; }
        job.status = 'running'; this.save();
        try {
          const answer = await this.agent.run(job.text, { owner: 'wechat', requestId: job.id, notify: async event => {
            if (event.type === 'approval') await this.send(`需要允许一次操作：${event.name}\n${JSON.stringify(event.args).slice(0, 1100)}\n允许：/approve ${event.id}\n拒绝：/deny ${event.id}`);
          } });
          job.status = 'done'; this.save();
          await this.send(answer);
        } catch (e) {
          if (job.status === 'running') { job.status = 'failed'; this.save(); await this.send('处理未完成：' + e.message).catch(() => {}); }
          this.lastError = this.store.redact(e.message);
        }
      }
    } finally { this.draining = false; }
  }
  async receiveMedia(job) {
    const controller = new AbortController(); this.mediaController = controller;
    job.status = 'running'; this.save();
    for (let index = job.savedMedia.length; index < job.media.length; index++) {
      try {
        controller.signal.throwIfAborted();
        const entry = job.media[index];
        const saved = await (entry.type === 'file' ? saveAttachment : saveImage)(entry.item, { directory: job.directory, privateDir: this.store.dir,
          messageId: job.id, index, day: job.day, fetcher: this.fetcher, signal: controller.signal });
        // A pause or rebind may arrive while the atomic file commit is finishing.
        controller.signal.throwIfAborted();
        job.savedMedia.push(saved); this.save();
        this.store.event(entry.type === 'file' ? 'attachment_saved' : 'image_saved', { path: saved.path, bytes: saved.bytes });
      } catch (e) {
        if (controller.signal.aborted) {
          job.status = controller.resumeAfterStop ? 'pending' : 'cancelled'; this.save(); this.mediaController = null; return;
        }
        // Keep one slot per media item, including failures, so recovery preserves indexes.
        job.savedMedia.push({ error: e.message }); this.save();
      }
    }
    const paths = job.savedMedia.filter(result => result.path).map(result => result.path);
    const errors = job.savedMedia.flatMap((result, index) => result.error ? [`第 ${index + 1} ${job.media[index].type === 'image' ? '张' : '个文件'}：${result.error}`] : []);
    const allImages = job.media.every(entry => entry.type === 'image');
    const noun = allImages ? '图片' : '文件';
    const reply = [paths.length ? `已保存 ${paths.length} ${allImages ? '张图片' : '个文件'}：\n${paths.join('\n')}` : '',
      errors.length ? `${noun}保存失败：\n` + errors.join('\n') : ''].filter(Boolean).join('\n\n');
    job.status = errors.length ? 'failed' : 'done';
    delete job.media; // Expiring CDN tickets and decryption keys stay out of completed history.
    // Persist receipt and completion together, before attempting delivery.
    this.state.outbox.push({ id: randomUUID(), text: this.store.redact(reply) });
    this.trimOutbox(); this.save();
    this.mediaController = null;
    await this.flush().catch(e => { this.lastError = this.store.redact(e.message); });
  }
  async send(text) {
    const item = { id: randomUUID(), text: this.store.redact(text).slice(0, 10000) };
    this.state.outbox.push(item); this.trimOutbox(); this.save();
    return this.flush();
  }
  trimOutbox() {
    // Keep every pending reminder; bound ordinary replies independently.
    const ordinary = new Set(this.state.outbox.filter(item => !item.reminderId).slice(-30).map(item => item.id));
    this.state.outbox = this.state.outbox.filter(item => item.reminderId || ordinary.has(item.id));
  }
  reminderDelivered(id) { return this.state.deliveredReminders?.find(item => item.id === id); }
  queueReminder(item, now) {
    const occurrenceId = reminderDeliveryId(item);
    if (this.reminderDelivered(occurrenceId) || this.state.outbox.some(reply => (reply.occurrenceId || reply.reminderId) === occurrenceId)) return;
    const late = now - Date.parse(item.dueAt) >= 60000;
    this.state.outbox.push({ id: 'reminder-' + occurrenceId, reminderId: item.id, occurrenceId,
      userId: item.userId, botId: item.botId,
      text: this.store.redact(`⏰ 提醒：${item.text}\n${late ? '补发，原定' : '时间'}：${reminderTime(item.dueAt)}`) });
    this.save();
  }
  cancelReminder(id) {
    if (this.sendingReminderId === id) throw new Error('这条提醒正在发送，无法取消，请稍后查看发送结果');
    this.state.outbox = this.state.outbox.filter(item => item.reminderId !== id); this.save();
  }
  async flush() {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushOutbox();
    try { return await this.flushPromise; } finally { this.flushPromise = null; }
  }
  async flushOutbox() {
    this.sending = true;
    try {
      while (this.state.outbox.length) {
        if (!this.state.context) throw new Error('请先在微信给 Bot 发一条消息');
        const item = this.state.outbox[0];
        if (item.reminderId && (item.userId !== this.account.userId || item.botId !== this.account.botId)) {
          this.state.outbox.shift(); this.save(); continue;
        }
        if (item.reminderId && ['stopped', 'unbound', 'expired'].includes(this.status)) throw new Error('微信连接已暂停或失效，提醒等待恢复后发送');
        item.offset ||= 0;
        const chunk = Array.from(item.text).slice(item.offset, item.offset + 1500).join('');
        this.sendingReminderId = item.reminderId;
        await this.request('ilink/bot/sendmessage', { msg: {
          from_user_id: '', to_user_id: this.account.userId, client_id: `${item.id}-${item.offset}`,
          message_type: 2, message_state: 2, run_id: item.id, context_token: this.state.context,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        } }, { timeout: 20000 });
        item.offset += Array.from(chunk).length;
        if (item.offset >= Array.from(item.text).length) {
          this.state.outbox = this.state.outbox.filter(reply => reply.id !== item.id);
          if (item.reminderId) {
            this.state.deliveredReminders ||= [];
            this.state.deliveredReminders.push({ id: item.occurrenceId || item.reminderId, at: new Date().toISOString() });
            this.state.deliveredReminders = this.state.deliveredReminders.slice(-500);
          }
        }
        this.save(); this.sendingReminderId = null;
      }
    } finally { this.sending = false; this.sendingReminderId = null; }
  }
}
