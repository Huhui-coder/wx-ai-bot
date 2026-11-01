import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { within } from './skills.js';
import { readDocument, decodeText } from './documents.js';
import { imageExtension, persistMedia } from './images.js';
import { commandAllowed, suggestedPrefix } from './grants.js';
import { screenshotCommand } from './system.js';
import { repeatLabel } from './reminders.js';
import { synthesize, voiceReady } from './voice.js';
import { checkImageKey, generateImage, imageDataURL } from './imagegen.js';
import { portraitPrompt, selfiePrompt } from './persona.js';
import { compactReference } from './shrink.js';
import { DIALOGUE_MAX_CHARS, REFERENCE_TARGET_BYTES, VOICE_SAMPLE_TEXT, checkVideoKey, generateVideo, videoPrompt, videoSeconds } from './video.js';

const VISION_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const VISION_MAX_BYTES = 5 * 1024 * 1024, VISION_MAX_IMAGES = 3;
const APPROVAL_TIMEOUT_MS = 900_000;
const GATED = ['run_command', 'write_file', 'install_skill', 'capture_screen', 'schedule_task'];
const GENERATED_FOLDER = 'AI生成';

const field = (description, type = 'string') => ({ type, description });
const tool = (name, description, properties, required = []) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
} });
export const definitions = [
  tool('create_reminder', '保存通过微信发送的提醒，支持一次性、每天、周一至周五、每周指定星期。所有时间按 Asia/Shanghai 北京时间理解。用户明确要求提醒时使用；成功后回复编号和具体北京时间。', {
    text: field('到点发送的提醒内容，最多 1000 字'), dueAt: field('绝对时间，完整 ISO 日期和时区，例如 2026-10-30T15:00:00+08:00；与 afterSeconds 二选一'),
    afterSeconds: field('一次性提醒的整数秒数，例如十分钟为 600。与 dueAt 二选一', 'integer'),
    repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly'], description: '重复规则：none 一次性（默认），daily 每天，weekdays 周一至周五（不计算节假日或调休），weekly 每周指定星期' },
    time: field('重复提醒的北京时间 HH:mm，例如 18:00；重复时必填，不填写 dueAt 或 afterSeconds，首次时间由程序计算'),
    weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: '仅 weekly 必填，1 周一到 7 周日，例如 [1,3,5]' },
  }, ['text']),
  tool('list_reminders', '查看提醒、发送状态及当前准确北京时间。需要确认当前日期和时间时也可调用。', {}),
  tool('cancel_reminder', '根据完整编号取消提醒；重复提醒取消整组后续发送。取消前如不知道编号，先查看提醒列表。', { id: field('提醒完整编号') }, ['id']),
  tool('schedule_task', '创建定时 AI 任务：到点由模型无人值守地执行一段指令，把结果发到微信。与只发固定文字的 create_reminder 不同。时间规则同 create_reminder，额外支持 repeat=interval 配合 everyMinutes。无人值守时用户无法审批，任务要用到的命令必须在 allowedCommands 中预先列出。', {
    prompt: field('到点要执行的完整指令，须自包含，不依赖当时的聊天上下文，最多 4000 字'), dueAt: field('一次性任务的绝对时间，带 +08:00 的完整 ISO 日期；与 afterSeconds 二选一'),
    afterSeconds: field('一次性任务的相对秒数', 'integer'),
    repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'interval'], description: '重复规则：none 一次性（默认），daily 每天，weekdays 周一至周五，weekly 每周指定星期，interval 固定间隔' },
    time: field('daily、weekdays、weekly 的北京时间 HH:mm'), weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: '仅 weekly 必填，1 周一到 7 周日' },
    everyMinutes: field('仅 interval 必填，15 到 1440 的整数分钟', 'integer'),
    quiet: field('true 时，正常无事可报就不发微信；模型须只回复 [无需通知]。失败仍会通知', 'boolean'),
    allowedCommands: { type: 'array', items: { type: 'string' }, description: '任务可自动执行的命令前缀，例如 ["npm test","git status"]；不含 shell 连接符或重定向' },
    allowWrites: field('是否允许任务写入工作目录内的文件，默认 false', 'boolean'),
  }, ['prompt']),
  tool('list_directory', '列出工作目录或微信收件目录内的文件和文件夹。', { path: field('相对工作目录的路径，或收件目录内的绝对路径，默认 .') }),
  tool('read_file', '读取工作目录或微信收件目录内的文本文件。PDF、Word、Excel、PPT 请用 read_document。', { path: field('相对或绝对文件路径') }, ['path']),
  tool('read_document', '提取工作目录或微信收件目录内文档的文字，支持 PDF、docx、xlsx、pptx 和文本文件。内容长时返回 nextOffset，用它继续读取。', {
    path: field('相对或绝对文件路径'), offset: field('从第几个字符开始，默认 0', 'integer'),
  }, ['path']),
  tool('view_image', '查看工作目录或微信收件目录内的图片（PNG、JPEG、GIF、WebP，最大 5 MB）。图片会附在下一轮消息中。', { path: field('相对或绝对文件路径') }, ['path']),
  tool('send_file', '把工作目录或微信收件目录内的文件发到用户绑定的微信，最大 25 MB。PNG、JPEG、GIF、WebP、BMP 以图片发送，其他以文件发送。', { path: field('相对或绝对文件路径') }, ['path']),
  tool('send_voice', '把一段话合成语音，以 mp3 语音文件发到用户绑定的微信，用户点开文件收听。微信目前不支持程序发语音条。', {
    text: field('要说的话，最多 200 字。只写念出来的内容，不写括号里的动作和表情'),
  }, ['text']),
  tool('generate_image', '生成一张图片并直接发到用户绑定的微信，不需要再调用 send_file。大约需要一到两分钟。', {
    prompt: field('画面描述：场景、动作、穿着、光线和氛围，最多 2000 字'),
    selfie: field('画面主角是你本人（自拍、生活照）时为 true，程序会用形象照保持长相一致；风景、美食等为 false', 'boolean'),
    orientation: { type: 'string', enum: ['square', 'portrait', 'landscape'], description: '画幅：square 方图（默认），portrait 竖图，landscape 横图' },
  }, ['prompt']),
  tool('send_video', '录一段你本人对着镜头说话的短视频发到用户绑定的微信。长相按形象照，声音按你的音色，大约需要两到四分钟，每条都会消耗视频额度。三个参数都要根据此刻的聊天现写，不能重复以前写过的内容。', {
    dialogue: field('你在视频里说的话，最多 60 字。口语，接得上刚才的聊天，只写念出来的内容'),
    acting: field('此刻的情绪、表情和动作，写具体，例如：先委屈地嘟嘴，歪头看着镜头，说到一半忍不住笑出来'),
    scene: field('你现在在哪、穿什么、光线怎样，要符合当前时间和聊天内容，例如：深夜窝在床上，穿着睡衣，只开了一盏暖黄的床头灯'),
  }, ['dialogue', 'acting', 'scene']),
  tool('remember', '把用户提到的、值得长期记住的事存入记忆，例如喜好、重要日子、约定。用户可在人格页查看和修改。不要存密码、密钥和验证码。', {
    text: field('一条完整的记忆，最多 200 字，例如：用户对花生过敏'),
  }, ['text']),
  tool('capture_screen', '截取电脑当前屏幕，保存到工作目录的「截图」文件夹并返回路径。需要给用户看时再调用 send_file。', {}),
  tool('write_file', '创建或覆盖工作目录内的文本文件。', { path: field('文件路径'), content: field('完整文件内容') }, ['path', 'content']),
  tool('run_command', '在本机执行 shell 命令，包括 npm、python、Skill 脚本。返回任务 ID，可继续查询。仅当用户要求操作时使用。', {
    command: field('完整 shell 命令'), cwd: field('工作目录内的相对路径，默认 .'),
    timeoutMinutes: field('最长运行分钟数，默认 2。编译、下载等长任务请设置；不能超过用户设置的上限', 'integer'),
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
  constructor(store, skills, processes, reminders, { getWechat, fetcher = fetch, pollOptions } = {}) {
    this.store = store; this.skills = skills; this.processes = processes; this.pending = new Map(); this.reminders = reminders; this.getWechat = getWechat; this.fetcher = fetcher; this.pollOptions = pollOptions;
    this.clearGrants();
  }
  clearGrants() { this.sessionCommands = new Set(); this.sessionWrites = false; }
  definitions() {
    const { config, persona } = this.store;
    const unavailable = new Set([...(config.vision ? [] : ['view_image']), ...(voiceReady(config) ? [] : ['send_voice']),
      ...(config.imageApiKey ? [] : ['generate_image']), ...(persona.enabled ? [] : ['remember']),
      ...(config.videoApiKey && persona.enabled ? [] : ['send_video'])]);
    return definitions.filter(t => !unavailable.has(t.function.name));
  }
  recentFiles() { return this.getWechat?.()?.state.received || []; }
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
  // Received files live outside the workspace by design, so reads may also reach the inbox.
  async resolveReadable(input = '.') {
    if (typeof input === 'string' && path.isAbsolute(input)) {
      const inbox = await fs.realpath(this.store.config.imageDirectory).catch(() => null);
      if (inbox && within(inbox, path.resolve(input))) {
        const actual = await fs.realpath(input);
        if (!within(inbox, actual)) throw new Error('符号链接指向收件目录之外');
        return actual;
      }
    }
    return this.resolvePath(input);
  }
  // Checked before calling a paid service, so nothing is generated that cannot be delivered.
  sendingWechat() {
    const wx = this.getWechat?.();
    if (!wx) throw new Error('微信服务尚未启动');
    wx.assertSendable();
    return wx;
  }
  keepGenerated(bytes, filename, signal) {
    return persistMedia(bytes, { directory: path.join(this.store.config.imageDirectory, GENERATED_FOLDER), privateDir: this.store.dir, filename, signal });
  }
  async imagePlatform(signal) {
    const key = this.store.config.imageApiKey;
    if (this.imageGroup?.key !== key) this.imageGroup = { key, platform: (await checkImageKey(key, { fetcher: this.fetcher, signal })).platform };
    return this.imageGroup.platform;
  }
  checkImageKey(signal) { return checkImageKey(this.store.config.imageApiKey, { fetcher: this.fetcher, signal }); }
  speak(text, signal) { return synthesize(text, this.store.config, { fetcher: this.fetcher, signal }); }
  checkVideoKey(signal) { return checkVideoKey(this.store.config.videoApiKey, { fetcher: this.fetcher, signal }); }
  // Cached per voice: the sample only tells the video model how she sounds.
  async voiceSample(signal) {
    const { config } = this.store;
    if (!voiceReady(config)) return null;
    const file = path.join(this.store.dir, `voice-sample-${createHash('sha256').update(config.doubaoVoice).digest('hex').slice(0, 16)}.mp3`);
    const saved = await fs.readFile(file).catch(() => null);
    if (saved) return saved;
    const bytes = await this.speak(VOICE_SAMPLE_TEXT, signal);
    await fs.writeFile(file, bytes, { mode: 0o600 });
    return bytes;
  }
  async film({ dialogue, acting, scene }, signal) {
    const portrait = await this.portrait();
    if (!portrait) throw new Error('还没有形象照，请用户先到人格页设定');
    return generateVideo({ apiKey: this.store.config.videoApiKey, prompt: videoPrompt({ dialogue, acting, scene, appearance: this.store.persona.appearance }), seconds: videoSeconds(dialogue),
      portrait: compactReference(portrait, REFERENCE_TARGET_BYTES), voiceSample: await this.voiceSample(signal).catch(() => null) }, { fetcher: this.fetcher, signal, ...this.pollOptions });
  }
  async paint({ prompt, orientation, reference, idempotencyKey, compact }, signal) {
    const apiKey = this.store.config.imageApiKey;
    if (!apiKey) throw new Error('请先在连接设置中填写生图 Key');
    return generateImage({ apiKey, platform: await this.imagePlatform(signal), prompt, orientation, reference, idempotencyKey, compact }, { fetcher: this.fetcher, signal, ...this.pollOptions });
  }
  portraitPath(candidate = false) { return path.join(this.store.dir, candidate ? 'portrait-candidate.img' : 'portrait.img'); }
  async portrait() { return fs.readFile(this.portraitPath()).catch(e => { if (e.code === 'ENOENT') return null; throw e; }); }
  async portraitView() { const bytes = await this.portrait(); return { image: bytes ? imageDataURL(bytes) : null }; }
  async draftPortrait(signal) {
    if (!this.store.persona.appearance) throw new Error('请先填写她的外貌');
    const bytes = await this.paint({ prompt: portraitPrompt(this.store.persona), orientation: 'portrait', compact: true }, signal);
    await fs.writeFile(this.portraitPath(true), bytes, { mode: 0o600 });
    return { image: imageDataURL(bytes) };
  }
  async uploadPortrait(dataUrl) {
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/(?:png|jpeg);base64,([A-Za-z\d+/]+={0,2})$/);
    if (!match) throw new Error('只支持 JPG 或 PNG 图片');
    const bytes = Buffer.from(match[1], 'base64');
    if (!['png', 'jpg'].includes(imageExtension(bytes))) throw new Error('只支持 JPG 或 PNG 图片');
    await fs.writeFile(this.portraitPath(), bytes, { mode: 0o600 });
    await fs.rm(this.portraitPath(true), { force: true });
    return this.portraitView();
  }
  async acceptPortrait() {
    try { await fs.rename(this.portraitPath(true), this.portraitPath()); }
    catch (e) { if (e.code === 'ENOENT') throw new Error('请先生成一张形象照'); throw e; }
    return this.portraitView();
  }
  covered(name, args, context) {
    const { commands = [], writes = false } = context.grants || {};
    if (name === 'run_command') return commandAllowed(args.command, [...this.store.config.allowedCommands, ...commands, ...(context.unattended ? [] : this.sessionCommands)]);
    return name === 'write_file' && (writes || (!context.unattended && this.sessionWrites));
  }
  summary(name, args) {
    if (name === 'run_command') return String(args.command).slice(0, 1000);
    if (name === 'write_file') return `写入 ${args.path}（${Buffer.byteLength(String(args.content))} 字节）\n${String(args.content).slice(0, 200)}`;
    if (name === 'install_skill') return `安装 ${args.name}，来源 ${args.source}${args.subdir ? '/' + args.subdir : ''}`;
    if (name === 'capture_screen') return '截取当前屏幕';
    if (name === 'schedule_task') {
      const when = args.repeat && args.repeat !== 'none' ? repeatLabel({ frequency: args.repeat, time: args.time, everyMinutes: args.everyMinutes, weekdays: args.weekdays || [] }) : args.dueAt || `${args.afterSeconds} 秒后`;
      return `定时任务（${when}）：${String(args.prompt).slice(0, 600)}\n可自动执行：${(args.allowedCommands || []).join('、') || '无'}\n可写文件：${args.allowWrites ? '是' : '否'}`;
    }
    return name;
  }
  async permission(name, args, context) {
    if (this.store.config.allowMutations || this.covered(name, args, context)) return;
    // Nobody is there to answer, and a running task must not widen its own rights.
    if (context.unattended) throw new Error('定时任务未预先获得此操作的授权，未执行：' + this.summary(name, args).slice(0, 200));
    const id = randomUUID().slice(0, 8);
    let resolve;
    const decision = new Promise(r => { resolve = r; });
    const info = { id, name, args, at: new Date().toISOString(), summary: this.summary(name, args),
      scope: name === 'run_command' ? suggestedPrefix(args.command) : name === 'write_file' ? '工作目录内的写入' : '' };
    this.pending.set(id, { info, resolve });
    const cancel = () => resolve(false);
    context.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => resolve(false), APPROVAL_TIMEOUT_MS);
    try {
      await context.notify({ type: 'approval', ...info });
      if (context.signal.aborted) resolve(false);
      if (!await decision) throw new Error('操作未获得授权或已取消，未执行');
      context.signal.throwIfAborted();
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', cancel); this.pending.delete(id); }
  }
  decide(id, approved, always = false) {
    const pending = this.pending.get(id);
    if (!pending) throw new Error('审批已结束或不存在');
    if (always && !pending.info.scope) throw new Error('这个操作只能允许一次');
    if (always && approved) {
      if (pending.info.name === 'run_command') this.sessionCommands.add(pending.info.scope);
      else this.sessionWrites = true;
    }
    pending.resolve(approved); return { ok: true };
  }
  approvals() { return [...this.pending.values()].map(p => p.info); }
  async execute(name, args, context) {
    context.signal.throwIfAborted();
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
    if (!definitions.some(t => t.function.name === name)) throw new Error('不支持的工具：' + name);
    if (GATED.includes(name)) await this.permission(name, args, context);
    context.signal.throwIfAborted();
    switch (name) {
      case 'schedule_task': {
        if (!this.reminders) throw new Error('提醒服务尚未启动');
        const { prompt, ...rule } = args;
        return this.reminders.create({ ...rule, text: prompt, kind: 'task' }, { requestId: context.invocationId });
      }
      case 'create_reminder':
        if (!this.reminders) throw new Error('提醒服务尚未启动');
        return this.reminders.create(args, { requestId: context.invocationId });
      case 'list_reminders':
        if (!this.reminders) throw new Error('提醒服务尚未启动');
        return this.reminders.list();
      case 'cancel_reminder':
        if (!this.reminders) throw new Error('提醒服务尚未启动');
        return this.reminders.cancel(args.id);
      case 'list_directory': {
        const entries = await fs.readdir(await this.resolveReadable(args.path), { withFileTypes: true });
        return entries.slice(0, 500).map(e => ({ name: e.name, directory: e.isDirectory() }));
      }
      case 'read_file': {
        const file = await this.resolveReadable(args.path);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 128000) throw new Error('只读取不超过 128 KB 的文本文件');
        const bytes = await fs.readFile(file);
        try { return decodeText(bytes); }
        catch { throw new Error('这不是文本文件；PDF、Word、Excel、PPT 请用 read_document'); }
      }
      case 'read_document': return readDocument(await this.resolveReadable(args.path), args.offset);
      case 'view_image': {
        if (!this.store.config.vision) throw new Error('当前未开启「模型支持看图」');
        const file = await this.resolveReadable(args.path);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > VISION_MAX_BYTES) throw new Error('图片须为不超过 5 MB 的文件');
        const bytes = await fs.readFile(file);
        const type = VISION_TYPES[imageExtension(bytes)];
        if (!type) throw new Error('模型只支持 PNG、JPEG、GIF 和 WebP 图片');
        context.images?.push(`data:${type};base64,${bytes.toString('base64')}`);
        context.images?.splice(0, Math.max(0, context.images.length - VISION_MAX_IMAGES));
        return { path: file, bytes: bytes.length, attached: true };
      }
      case 'send_file': {
        const wx = this.getWechat?.();
        if (!wx) throw new Error('微信服务尚未启动');
        return wx.sendFile(await this.resolveReadable(args.path), { signal: context.signal });
      }
      case 'send_voice': {
        const wx = this.sendingWechat();
        const audio = await this.speak(args.text, context.signal);
        const saved = await this.keepGenerated(audio, `voice-${randomUUID().slice(0, 12)}.mp3`, context.signal);
        const { enabled, name } = this.store.persona;
        return wx.sendFile(saved.path, { signal: context.signal, name: `${enabled ? name : '助手'}的语音.mp3` });
      }
      case 'generate_image': {
        if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 2000) throw new Error('画面描述应为 1 到 2000 字');
        const wx = this.sendingWechat();
        const reference = args.selfie === true ? await this.portrait() : null;
        const prompt = args.selfie === true ? selfiePrompt(this.store.persona, args.prompt.trim(), Boolean(reference)) : args.prompt.trim();
        const bytes = await this.paint({ prompt, orientation: args.orientation, reference, idempotencyKey: context.invocationId }, context.signal);
        const saved = await this.keepGenerated(bytes, `image-${randomUUID().slice(0, 12)}.${imageExtension(bytes)}`, context.signal);
        let sent;
        try { sent = await wx.sendFile(saved.path, { signal: context.signal }); }
        catch (e) { throw new Error(`图片已保存到 ${saved.path}，但发送失败：${e.message}`); }
        return { ...sent, path: saved.path, ...(args.selfie === true && !reference ? { note: '还没有形象照，这张的长相可能和之前不一致' } : {}) };
      }
      case 'send_video': {
        for (const key of ['dialogue', 'acting', 'scene']) if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 500) throw new Error('台词、表演和场景都要填写');
        if (Array.from(args.dialogue.trim()).length > DIALOGUE_MAX_CHARS) throw new Error(`台词最多 ${DIALOGUE_MAX_CHARS} 字`);
        const wx = this.sendingWechat();
        const bytes = await this.film({ dialogue: args.dialogue.trim(), acting: args.acting.trim(), scene: args.scene.trim() }, context.signal);
        const saved = await this.keepGenerated(bytes, `video-${randomUUID().slice(0, 12)}.mp4`, context.signal);
        try { return { ...await wx.sendFile(saved.path, { signal: context.signal, video: true }), path: saved.path }; }
        catch (e) { throw new Error(`视频已保存到 ${saved.path}，但发送失败：${e.message}`); }
      }
      case 'remember': return this.store.remember(args.text);
      case 'capture_screen': {
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const file = await this.resolvePath(path.join('截图', `screen-${stamp}.png`), true);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const { executable, args: command } = screenshotCommand(file);
        const task = this.processes.start('截取屏幕', path.dirname(file), { signal: context.signal, timeoutMs: 20000, executable, args: command });
        const done = await task.done;
        const size = await fs.stat(file).then(stat => stat.size, () => 0);
        if (done.status !== 'done' || !size) throw new Error('截屏失败，电脑可能已锁屏，或未授予屏幕录制权限：' + done.output.slice(-300));
        return { path: file, bytes: size };
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
        const limit = this.store.config.maxCommandMinutes;
        const minutes = args.timeoutMinutes === undefined ? Math.min(2, limit) : Number(args.timeoutMinutes);
        if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('timeoutMinutes 必须是正数');
        if (minutes > limit) throw new Error(`超过用户设置的命令上限 ${limit} 分钟，可在设置中调整`);
        const cwd = await this.resolvePath(args.cwd || '.');
        const task = this.processes.start(args.command, cwd, { signal: context.signal, owner: context.owner, timeoutMs: minutes * 60000 });
        await Promise.race([task.done, new Promise(r => setTimeout(r, 1000))]);
        return this.processes.observe(task.id);
      }
      case 'command_status': {
        if (args.stop) return this.processes.stop(args.id);
        const task = this.processes.tasks.get(args.id);
        if (!task) throw new Error('任务不存在');
        const wait = Math.min(10, Math.max(0, Number(args.waitSeconds) || 0));
        if (wait && task.status === 'running') await Promise.race([task.done, new Promise(r => setTimeout(r, wait * 1000))]);
        return this.processes.observe(args.id);
      }
      case 'list_skills': return this.skills.list();
      case 'read_skill': return this.skills.read(args.name, args.file);
      case 'install_skill': return this.skills.install(args, context.signal);
    }
  }
}
