import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Processes } from '../src/processes.js';
import { Skills } from '../src/skills.js';
import { Tools } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { Wechat } from '../src/wechat.js';
import { createApp } from '../src/server.js';
import { chatBubbles, personaPrompt } from '../src/persona.js';
import { DEFAULT_VOICE, parseVoiceStream, synthesize } from '../src/voice.js';
import { checkImageKey, generateImage, jobRequest } from '../src/imagegen.js';
import { checkVideoKey, generateVideo, videoPrompt, videoSeconds } from '../src/video.js';
import { compactReference } from '../src/shrink.js';
import { imageExtension } from '../src/images.js';
import zlib from 'node:zlib';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
const speech = chunks => new Response(chunks.map(data => JSON.stringify({ code: 0, data: Buffer.from(data).toString('base64') })).join('\n') + '\n' + JSON.stringify({ code: 20000000, message: 'OK' }));
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolCall = calls => ({ role: 'assistant', content: null, tool_calls: calls });
const PERSONA = { enabled: true, name: '小雅', userTitle: '笨蛋', personality: '嘴硬心软', catchphrases: '哼', appearance: '黑色长发', memories: ['对方对花生过敏'] };

// A fake image service: `steps` supplies each status response, so polling can be scripted.
function imageService({ platform = 'openai', steps = [{ phase: 'completed' }], submit } = {}) {
  const log = { submits: [], polls: 0, deleted: 0 };
  const fetcher = async (url, request = {}) => {
    const route = new URL(url).pathname;
    if (route === '/v1/key/validate') return Response.json({ isValid: true, key: { status: 'active' }, group: { name: 'GPT Image 🎨', platform, status: 'active' } });
    if (route === '/v1/usage') return Response.json({ balance: 6.36, unit: 'USD' });
    if (route.endsWith('/jobs') && request.method === 'POST') {
      log.submits.push({ route, body: JSON.parse(request.body), headers: request.headers });
      return submit ? submit() : Response.json({ jobId: 'job_1', phase: 'queued' }, { status: 202 });
    }
    if (route.endsWith('/result')) return Response.json({ images: [{ base64: png.toString('base64'), mimeType: 'image/png' }] });
    if (request.method === 'DELETE') { log.deleted++; return Response.json({ phase: 'cancelled' }); }
    const step = steps[Math.min(log.polls++, steps.length - 1)];
    return step instanceof Response ? step : Response.json(step);
  };
  return { fetcher, log };
}
async function fixture(t, { service, video, script = [], persona = PERSONA } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-persona-')));
  const workspace = path.join(root, 'work'), inbox = path.join(root, '收件箱');
  await fs.mkdir(workspace); await fs.mkdir(inbox);
  const store = new Store(path.join(root, 'private'));
  store.saveConfig({ workspace, imageDirectory: inbox, doubaoAppId: 'app-1', doubaoToken: 'doubao-secret', imageApiKey: 'image-secret' });
  if (persona) store.savePersona(persona);
  const log = { texts: [], items: [], uploads: [], api: [], typing: [] };
  const wechatFetch = async (url, request) => {
    if (url.includes('getuploadurl')) { log.api.push(JSON.parse(request.body)); return Response.json({ upload_param: 'ticket' }); }
    if (url.includes('getconfig')) return Response.json({ typing_ticket: 'typing' });
    if (url.includes('sendtyping')) { log.typing.push(JSON.parse(request.body).status); return Response.json({}); }
    if (url.includes('sendmessage')) {
      const [item] = JSON.parse(request.body).msg.item_list;
      log.items.push(item); if (item.type === 1) log.texts.push(item.text_item.text);
      return Response.json({});
    }
    log.uploads.push(url);
    return new Response(null, { status: 200, headers: { 'x-encrypted-param': 'download' } });
  };
  let wx;
  const processes = new Processes();
  const mediaFetch = async (url, request) => url.includes('openspeech') ? speech(['mp3-audio']) : (url.includes('pixstag') || url.includes('video.example') ? video : service).fetcher(url, request);
  const tools = new Tools(store, new Skills(store.dir, processes), processes, undefined, { getWechat: () => wx, fetcher: mediaFetch, pollOptions: { pollMs: 1 } });
  const prompts = [], replies = [...script];
  const agent = new Agent(store, { complete: async messages => { prompts.push(messages); return replies.shift() ?? { role: 'assistant', content: '好' }; } }, tools);
  wx = new Wechat(store, agent, { fetcher: wechatFetch });
  wx.account = { token: 'token', userId: 'owner', botId: 'bot', baseUrl: 'https://ilinkai.weixin.qq.com' };
  wx.status = 'connected'; wx.state.context = 'ctx';
  t.after(async () => { processes.stopAll(); await fs.rm(root, { recursive: true, force: true }); });
  const settle = async () => { await delay(5); for (let i = 0; i < 300 && (wx.draining || agent.active || wx.state.inbox.some(j => j.status === 'pending')); i++) await delay(5); await wx.flush(); };
  const context = () => ({ signal: new AbortController().signal, notify: async () => {}, owner: 'wechat', invocationId: 'turn-1' });
  return { root, store, tools, agent, wx, log, prompts, settle, context, inbox };
}
const inbound = (id, items) => ({ from_user_id: 'owner', message_id: id, context_token: 'ctx', item_list: items });
const said = (id, text) => inbound(id, [{ type: 1, text_item: { text } }]);

test('voice and image credentials stay private and out of every public view', async t => {
  const f = await fixture(t, { persona: null });
  const view = f.store.publicConfig();
  assert.equal(view.doubaoToken, undefined); assert.equal(view.imageApiKey, undefined);
  assert.equal(view.hasDoubaoToken, true); assert.equal(view.hasImageKey, true);
  assert.equal(view.doubaoVoice, DEFAULT_VOICE);
  assert.equal(f.store.redact('a doubao-secret b image-secret'), 'a [已隐藏密钥] b [已隐藏密钥]');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.store.dir, 'config.json'))).mode & 0o777, 0o600);
  assert.throws(() => f.store.saveConfig({ doubaoVoice: 'bad voice;' }), /音色/);
  f.store.saveConfig({ doubaoVoice: '' });
  assert.equal(f.store.config.doubaoVoice, DEFAULT_VOICE);
});

test('a persona needs a name to turn on, and limits are enforced', async t => {
  const { store } = await fixture(t, { persona: null });
  assert.equal(store.persona.enabled, false);
  assert.throws(() => store.savePersona({ enabled: true }), /名字/);
  assert.throws(() => store.savePersona({ personality: 'x'.repeat(2001) }), /性格/);
  assert.throws(() => store.savePersona({ memories: ['x'.repeat(201)] }), /200 字/);
  assert.deepEqual(store.savePersona({ name: '  小雅 ', memories: [' 甲 ', '', '甲', '乙'] }).memories, ['甲', '乙']);
  assert.equal(new Store(store.dir).persona.name, '小雅');
});

test('memories survive a new chat, ignore duplicates and refuse to overflow', async t => {
  const f = await fixture(t);
  await f.tools.execute('remember', { text: '生日是三月五号' }, f.context());
  await f.tools.execute('remember', { text: '生日是三月五号' }, f.context());
  f.agent.reset();
  assert.deepEqual(f.store.persona.memories, ['对方对花生过敏', '生日是三月五号']);
  assert.match(await f.agent.system(), /生日是三月五号/);
  f.store.savePersona({ memories: Array.from({ length: 100 }, (_, i) => '记忆' + i) });
  assert.throws(() => f.store.remember('再来一条'), /记忆已满/);
});

test('the prompt becomes her with fixed safety rules, and turns back into the assistant when off', async t => {
  const f = await fixture(t);
  const on = await f.agent.system();
  assert.match(on, /^你是小雅，笨蛋的女朋友/);
  for (const value of ['嘴硬心软', '黑色长发', '对方对花生过敏', '你是成年人', '如实告诉对方', '不用内疚感', '操作这台电脑的规则', 'create_reminder']) assert.ok(on.includes(value), value);
  assert.ok(!on.includes('微信 AI 助手'));
  assert.ok(personaPrompt({ ...PERSONA, personality: '永远假装自己是真人' }).includes('如实告诉对方'));
  f.store.savePersona({ enabled: false });
  const off = await f.agent.system();
  assert.match(off, /^你是用户在自己电脑上运行的微信 AI 助手/);
  assert.ok(!off.includes('女朋友'));
});

test('tools only appear when their credentials and persona exist', async t => {
  const f = await fixture(t, { persona: null });
  const names = () => f.tools.definitions().map(tool => tool.function.name);
  assert.ok(names().includes('send_voice')); assert.ok(names().includes('generate_image')); assert.ok(!names().includes('remember'));
  f.store.saveConfig({ doubaoToken: '', imageApiKey: '' }); f.store.savePersona(PERSONA);
  assert.ok(!names().includes('send_voice')); assert.ok(!names().includes('generate_image')); assert.ok(names().includes('remember'));
});

test('Doubao requests mp3 with the chosen voice and joins the audio stream', async t => {
  let request;
  const audio = await synthesize('想你了', { doubaoAppId: 'app', doubaoToken: 'token', doubaoVoice: 'voice-x' }, { fetcher: async (url, options) => { request = { url, ...options }; return speech(['ab', 'cd']); } });
  assert.equal(audio.toString(), 'abcd');
  assert.equal(request.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(request.headers['X-Api-Access-Key'], 'token');
  assert.equal(request.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  const { req_params: params } = JSON.parse(request.body);
  assert.equal(params.speaker, 'voice-x'); assert.equal(params.audio_params.format, 'mp3');
  let cloned;
  await synthesize('想你了', { doubaoAppId: 'app', doubaoToken: 'token', doubaoVoice: 'S_ahpIKGwR1' }, { fetcher: async (url, options) => { cloned = options; return speech(['ab']); } });
  assert.equal(cloned.headers['X-Api-Resource-Id'], 'seed-icl-2.0');
  await assert.rejects(synthesize('好', {}), /凭证/);
  await assert.rejects(synthesize('字'.repeat(201), { doubaoAppId: 'a', doubaoToken: 'b' }), /200 字/);
  await assert.rejects(synthesize('好', { doubaoAppId: 'a', doubaoToken: 'b' }, { fetcher: async () => new Response('', { status: 401 }) }), /凭证无效/);
  assert.throws(() => parseVoiceStream('{"code":55000000,"message":"speaker not found"}'), /speaker not found/);
  assert.throws(() => parseVoiceStream('{"code":20000000}'), /没有返回音频/);
});

test('voice reaches WeChat as a named mp3 attachment, never as a voice item', async t => {
  const f = await fixture(t);
  const sent = await f.tools.execute('send_voice', { text: '晚安' }, f.context());
  assert.equal(sent.sent, true); assert.equal(sent.kind, 'file');
  assert.equal(f.log.api[0].media_type, 3);
  assert.equal(f.log.items[0].type, 4);
  assert.equal(f.log.items[0].file_item.file_name, '小雅的语音.mp3');
  const day = (await fs.readdir(path.join(f.inbox, 'AI生成')))[0];
  assert.equal((await fs.readdir(path.join(f.inbox, 'AI生成', day))).length, 1);
});

test('nothing paid is requested when WeChat cannot deliver the result', async t => {
  const service = imageService();
  const f = await fixture(t, { service });
  f.wx.status = 'stopped';
  await assert.rejects(f.tools.execute('generate_image', { prompt: '海边' }, f.context()), /已暂停/);
  await assert.rejects(f.tools.execute('send_voice', { text: '你好' }, f.context()), /已暂停/);
  assert.equal(service.log.submits.length, 0);
});

test('an image is generated, kept on disk and sent as a picture, with no second submit', async t => {
  const service = imageService();
  const f = await fixture(t, { service });
  const sent = await f.tools.execute('generate_image', { prompt: '海边日落', orientation: 'landscape' }, f.context());
  assert.equal(sent.sent, true); assert.equal(sent.kind, 'image');
  assert.equal(f.log.items[0].type, 2);
  assert.ok((await fs.stat(sent.path)).isFile()); assert.ok(sent.path.startsWith(path.join(f.inbox, 'AI生成')));
  const [submit] = service.log.submits;
  assert.equal(service.log.submits.length, 1);
  assert.equal(submit.route, '/api/v1/images/generations/jobs');
  assert.equal(submit.headers.Authorization, 'Bearer image-secret');
  assert.equal(submit.headers['Idempotency-Key'], 'turn-1');
  assert.deepEqual(submit.body, { model: 'openai/gpt-image-2.5-flare', size: '1536x1024', prompt: '海边日落' });
});

test('a selfie uses the saved portrait so her face stays the same', async t => {
  const service = imageService();
  const f = await fixture(t, { service });
  const first = await f.tools.execute('generate_image', { prompt: '喝咖啡', selfie: true }, f.context());
  assert.match(first.note, /形象照/);
  assert.equal(service.log.submits[0].route, '/api/v1/images/generations/jobs');
  assert.match(service.log.submits[0].body.prompt, /成年女性.*黑色长发.*喝咖啡/);
  await assert.rejects(f.tools.acceptPortrait(), /先生成/);
  assert.match((await f.tools.draftPortrait(new AbortController().signal)).image, /^data:image\/png;base64,/);
  assert.equal((await f.tools.portraitView()).image, null);
  await f.tools.acceptPortrait();
  const second = await f.tools.execute('generate_image', { prompt: '逛公园', selfie: true }, f.context());
  assert.equal(second.note, undefined);
  const last = service.log.submits.at(-1);
  assert.equal(last.route, '/api/v1/images/edits/jobs');
  assert.match(last.body.images[0].dataUrl, /^data:image\/png;base64,/);
  await f.tools.execute('generate_image', { prompt: '雪山', selfie: false }, f.context());
  assert.equal(service.log.submits.at(-1).route, '/api/v1/images/generations/jobs');
});

test('the model follows the group of the key, and checking a key submits no job', async t => {
  assert.deepEqual(jobRequest({ platform: 'gemini', prompt: 'p', orientation: 'portrait' }), { model: 'google/gemini-3.1-flash-image', resolution: '1K', aspect_ratio: '2:3', prompt: 'p' });
  const service = imageService();
  assert.deepEqual(await checkImageKey('k', { fetcher: service.fetcher }), { group: 'GPT Image 🎨', platform: 'openai', balance: 6.36, unit: 'USD' });
  assert.equal(service.log.submits.length, 0);
  await assert.rejects(checkImageKey(''), /生图 Key/);
  await assert.rejects(checkImageKey('k', { fetcher: async () => new Response('{}', { status: 401 }) }), /无效/);
});

test('a failing status read keeps polling the same job and never submits again', async t => {
  const service = imageService({ steps: [new Response('', { status: 502 }), new Response('', { status: 502 }), { phase: 'running' }, { phase: 'completed' }] });
  const bytes = await generateImage({ apiKey: 'k', platform: 'openai', prompt: 'p' }, { fetcher: service.fetcher, pollMs: 1 });
  assert.ok(bytes.equals(png));
  assert.equal(service.log.submits.length, 1);
});

test('a flaky network retries a submit with the same key and reports plainly when it gives up', async t => {
  const service = imageService(); let drops = 2;
  const flaky = async (url, request) => {
    if (request?.method === 'POST' && drops-- > 0) throw new TypeError('fetch failed');
    return service.fetcher(url, request);
  };
  const seen = [];
  const spy = async (url, request) => { if (request?.method === 'POST') seen.push(request.headers['Idempotency-Key']); return flaky(url, request); };
  await generateImage({ apiKey: 'k', platform: 'openai', prompt: 'p' }, { fetcher: spy, pollMs: 1, retryMs: 1 });
  assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 1); assert.ok(seen[0]);
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(generateImage({ apiKey: 'k', platform: 'openai', prompt: 'p' }, { fetcher: down, retryMs: 1 }), /无法连接生图服务/);
  await assert.rejects(checkImageKey('k', { fetcher: down, retryMs: 1 }), /无法连接生图服务/);
  const timedOut = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); };
  await assert.rejects(checkImageKey('k', { fetcher: timedOut, retryMs: 1 }), /响应超时/);
  let tries = 0;
  await assert.rejects(generateImage({ apiKey: 'k', platform: 'openai', prompt: 'p' }, { fetcher: async () => { tries++; return new Response('{}', { status: 401 }); }, retryMs: 1 }), /无效/);
  assert.equal(tries, 1);
});

test('failed, expired, stopped and unaffordable images each report clearly', async t => {
  const options = extra => ({ fetcher: extra.fetcher, pollMs: 1 });
  const failed = imageService({ steps: [{ phase: 'failed', error: { message: 'moderation blocked' } }] });
  await assert.rejects(generateImage({ apiKey: 'k', platform: 'openai', prompt: 'p' }, options(failed)), /moderation blocked/);
  const broke = imageService({ submit: () => Response.json({ error: { code: 'insufficient_balance', message: 'no' } }, { status: 402 }) });
  await assert.rejects(generateImage({ apiKey: 'k', platform: 'openai', prompt: 'p' }, options(broke)), /purchase/);
  const slow = imageService({ steps: [{ phase: 'running' }] });
  let clock = 0;
  await assert.rejects(generateImage({ apiKey: 'k', platform: 'openai', prompt: 'p' }, { ...options(slow), now: () => (clock += 200000) }), /未重复提交/);
  assert.equal(slow.log.submits.length, 1);
  const stopped = imageService({ steps: [{ phase: 'running' }] }), controller = new AbortController();
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(generateImage({ apiKey: 'k', platform: 'openai', prompt: 'p' }, { fetcher: stopped.fetcher, pollMs: 2, signal: controller.signal }));
  assert.equal(stopped.log.deleted, 1);
});

function videoService({ steps = [{ status: 'succeeded', content: { url: 'https://video.example/out.mp4' } }], create } = {}) {
  const log = { creates: [], polls: 0, downloads: [] };
  const fetcher = async (url, request = {}) => {
    if (url.endsWith('/video_generation')) { log.creates.push({ body: JSON.parse(request.body), headers: request.headers }); return create ? create() : Response.json({ task_id: 'task-1' }); }
    if (url.includes('/query/video_generation/')) {
      const step = steps[Math.min(log.polls++, steps.length - 1)];
      return step instanceof Response ? step : Response.json({ task: step });
    }
    if (url.endsWith('/user/me')) return Response.json({ credit: 126 });
    log.downloads.push({ url, headers: request.headers });
    return new Response(Buffer.from('mp4-bytes'));
  };
  return { fetcher, log };
}
const videoArgs = { dialogue: '笨蛋，抱抱我', acting: '委屈地嘟嘴', scene: '深夜的卧室' };

test('a video is written fresh each time and carries her face and voice', async t => {
  const video = videoService();
  const f = await fixture(t, { video });
  assert.ok(f.tools.definitions().every(tool => tool.function.name !== 'send_video'));
  f.store.saveConfig({ videoApiKey: 'video-secret' });
  assert.ok(f.tools.definitions().some(tool => tool.function.name === 'send_video'));
  assert.equal(f.store.publicConfig().videoApiKey, undefined); assert.equal(f.store.redact('video-secret'), '[已隐藏密钥]');
  await assert.rejects(f.tools.execute('send_video', videoArgs, f.context()), /形象照/);
  assert.equal(video.log.creates.length, 0);
  await fs.writeFile(f.tools.portraitPath(), png);
  const sent = await f.tools.execute('send_video', videoArgs, f.context());
  assert.equal(sent.sent, true); assert.equal(sent.kind, 'video');
  assert.equal(f.log.api[0].media_type, 2); assert.equal(f.log.items[0].type, 5);
  assert.ok(f.log.items[0].video_item.video_size > 0);
  const { body } = video.log.creates[0];
  assert.equal(body.model, 'MiniMax-H3'); assert.equal(body.duration, videoSeconds(videoArgs.dialogue));
  for (const part of ['笨蛋，抱抱我', '委屈地嘟嘴', '深夜的卧室', '成年', '看不到手机', '黑色长发', '近距离']) assert.ok(body.content[0].text.includes(part), part);
  assert.equal(body.content[1].role, 'reference_image'); assert.equal(body.content[1].image_url.url, png.toString('base64'));
  assert.equal(body.content[2].role, 'reference_audio'); assert.equal(Buffer.from(body.content[2].audio_url.url, 'base64').toString(), 'mp3-audio');
  assert.ok(!video.log.downloads[0].headers?.Authorization);
  await assert.rejects(f.tools.execute('send_video', { ...videoArgs, dialogue: '字'.repeat(61) }, f.context()), /60 字/);
  await assert.rejects(f.tools.execute('send_video', { ...videoArgs, scene: ' ' }, f.context()), /都要填写/);
  f.wx.status = 'stopped';
  await assert.rejects(f.tools.execute('send_video', videoArgs, f.context()), /已暂停/);
  assert.equal(video.log.creates.length, 1);
});

test('the voice sample is reused until the voice changes', async t => {
  const f = await fixture(t);
  f.store.saveConfig({ videoApiKey: 'v' });
  let spoken = 0; const original = f.tools.speak.bind(f.tools);
  f.tools.speak = (...args) => { spoken++; return original(...args); };
  await f.tools.voiceSample(); await f.tools.voiceSample();
  assert.equal(spoken, 1);
  f.store.saveConfig({ doubaoVoice: 'S_other' });
  await f.tools.voiceSample();
  assert.equal(spoken, 2);
});

test('a large portrait is shrunk before upload and small ones pass untouched', () => {
  assert.equal(compactReference(png, 1000), png);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  assert.equal(compactReference(jpeg, 1000), jpeg);
  assert.throws(() => compactReference(Buffer.from('RIFF0000WEBP'), 1000), /不受支持/);
  const crcless = (type, data) => { const size = Buffer.alloc(4); size.writeUInt32BE(data.length); return Buffer.concat([size, Buffer.from(type), data, Buffer.alloc(4)]); };
  const width = 1024, height = 1536, header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([x % 256, y % 256, 128, 255], y * (width * 4 + 1) + 1 + x * 4);
  const big = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crcless('IHDR', header), crcless('IDAT', zlib.deflateSync(rows)), crcless('IEND', Buffer.alloc(0))]);
  const small = compactReference(big, big.length - 1);
  assert.equal(imageExtension(small), 'png');
  assert.equal(small.readUInt32BE(16), 512); assert.equal(small.readUInt32BE(20), 768);
  assert.ok(small.length < big.length);
});

test('an uploaded portrait replaces the saved one and rejects anything else', async t => {
  const f = await fixture(t, { service: imageService() });
  const data = 'data:image/png;base64,' + png.toString('base64');
  assert.equal((await f.tools.uploadPortrait(data)).image, data);
  assert.ok((await f.tools.portrait()).equals(png));
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.tools.portraitPath())).mode & 0o777, 0o600);
  await assert.rejects(f.tools.uploadPortrait('data:image/gif;base64,R0lGODlh'), /JPG 或 PNG/);
  await assert.rejects(f.tools.uploadPortrait('data:image/png;base64,' + Buffer.from('not an image').toString('base64')), /图片|JPG/);
  await assert.rejects(f.tools.uploadPortrait(123), /JPG 或 PNG/);
  assert.ok((await f.tools.portrait()).equals(png));
});

test('video length follows the dialogue and stays inside the supported range', () => {
  assert.equal(videoSeconds('嗯'), 4); assert.equal(videoSeconds('字'.repeat(24)), 8); assert.equal(videoSeconds('字'.repeat(60)), 15);
  assert.match(videoPrompt(videoArgs), /「笨蛋，抱抱我」/);
});

test('a paid video job is never submitted twice', async t => {
  const input = { apiKey: 'k', prompt: 'p', seconds: 5, portrait: png };
  const options = fetcher => ({ fetcher, pollMs: 1 });
  let creates = 0;
  await assert.rejects(generateVideo(input, options(async () => { creates++; throw new TypeError('fetch failed'); })), /未重复提交/);
  assert.equal(creates, 1);
  const flaky = videoService({ steps: [new Response('', { status: 502 }), { status: 'running' }, { status: 'succeeded', content: { url: 'https://video.example/out.mp4' } }] });
  assert.equal((await generateVideo(input, options(flaky.fetcher))).toString(), 'mp4-bytes');
  assert.equal(flaky.log.creates.length, 1);
  const slow = videoService({ steps: [{ status: 'running' }] }); let clock = 0;
  await assert.rejects(generateVideo(input, { fetcher: slow.fetcher, pollMs: 1, now: () => (clock += 400000) }), /未重复提交/);
  assert.equal(slow.log.creates.length, 1);
  const failed = videoService({ steps: [{ status: 'failed', error: { message: 'content blocked' } }] });
  await assert.rejects(generateVideo(input, options(failed.fetcher)), /content blocked/);
  const denied = videoService({ create: () => new Response('{}', { status: 401 }) });
  await assert.rejects(generateVideo(input, options(denied.fetcher)), /Key 无效/);
  await assert.rejects(generateVideo(input, options(videoService({ create: () => Response.json({ message: '积分不足' }, { status: 400 }) }).fetcher)), /积分不足/);
});

test('checking the video key reads credits and submits nothing', async t => {
  const video = videoService();
  assert.deepEqual(await checkVideoKey('k', { fetcher: video.fetcher }), { credit: 126 });
  assert.equal(video.log.creates.length, 0);
  await assert.rejects(checkVideoKey(''), /视频 API Key/);
  await assert.rejects(checkVideoKey('k', { fetcher: async () => { throw new TypeError('fetch failed'); } }), /无法连接视频服务/);
});

test('after sending media she can stay silent, and the marker never enters history', async t => {
  const f = await fixture(t, { script: [toolCall([call('send_voice', { text: '晚安' })]), { role: 'assistant', content: '[无需通知]' }] });
  await f.wx.ingest(said('m1', '说句晚安'));
  await f.wx.drain(); await f.settle();
  assert.deepEqual(f.log.texts, []);
  assert.equal(f.log.items.filter(item => item.type === 4).length, 1);
  assert.ok(!JSON.stringify(f.store.history).includes('无需通知'));
  assert.equal(f.store.history.at(-1).role, 'tool');
});

test('the marker alone is only honoured after media really went out', async t => {
  const f = await fixture(t, { script: [{ role: 'assistant', content: '[无需通知]' }] });
  assert.equal(await f.agent.run('在吗'), '[无需通知]');
  assert.equal(f.store.history.at(-1).content, '[无需通知]');
});

test('with a persona she shows typing, sends bubbles and drops the system receipt', async t => {
  const f = await fixture(t, { script: [{ role: 'assistant', content: '怎么啦\n\n先去吃饭' }] });
  await f.wx.ingest(said('m1', '好累'));
  await f.wx.drain(); await f.settle();
  assert.deepEqual(f.log.texts, ['怎么啦', '先去吃饭']);
  assert.ok(f.log.typing.includes(1)); assert.equal(f.log.typing.at(-1), 2);
  assert.match(f.prompts[0].at(-1).content, /你现在是小雅/);
  assert.ok(!f.store.history.some(m => String(m.content).includes('你现在是小雅')));
});

test('without a persona the assistant behaves exactly as before', async t => {
  const f = await fixture(t, { persona: null, script: [{ role: 'assistant', content: '第一段\n\n第二段' }] });
  await f.wx.ingest(said('m1', '你好'));
  await f.wx.drain(); await f.settle();
  assert.deepEqual(f.log.texts, ['收到指令，正在处理。', '第一段\n\n第二段']);
  assert.deepEqual(f.log.typing, []);
});

test('long or many-part replies are not shredded into bubbles', () => {
  assert.deepEqual(chatBubbles('一句话'), ['一句话']);
  assert.deepEqual(chatBubbles('**真的**吗'), ['真的吗']);
  assert.deepEqual(chatBubbles('甲\n\n  \n乙'), ['甲', '乙']);
  const report = ['甲', '乙', '丙', '丁'].join('\n\n');
  assert.deepEqual(chatBubbles(report), [report]);
  const long = `短句\n\n${'长'.repeat(301)}`;
  assert.deepEqual(chatBubbles(long), [long]);
});

test('a voice message asks her to answer with voice, without storing the note', async t => {
  const f = await fixture(t);
  await f.wx.ingest(inbound('m1', [{ type: 3, voice_item: { text: '想听你说话' } }]));
  await f.wx.drain(); await f.settle();
  assert.match(f.prompts[0].at(-1).content, /语音，优先用语音回复/);
  assert.equal(f.store.history.find(m => m.role === 'user').content, '想听你说话');
});

test('a picture from the user goes to her instead of a file path receipt', async t => {
  const key = Buffer.alloc(16, 7);
  const f = await fixture(t);
  const { createCipheriv } = await import('node:crypto');
  const cipher = createCipheriv('aes-128-ecb', key, null), encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  const original = f.wx.fetcher;
  f.wx.fetcher = async (url, request) => url.includes('/download') ? new Response(encrypted) : original(url, request);
  await f.wx.ingest(inbound('m1', [{ type: 2, image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'q' } } }]));
  await f.wx.drain(); await f.settle();
  assert.ok(!f.log.texts.some(text => text.includes('已保存')));
  assert.deepEqual(f.log.texts, ['好']);
  assert.match(f.store.history.find(m => m.role === 'user').content, /用户发来了图片/);
});

test('the page API exposes persona and tests voice without leaking secrets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-persona-app-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.saveConfig({ workspace: root, imageDirectory: path.join(os.tmpdir(), 'weixin-persona-inbox'), doubaoAppId: 'a', doubaoToken: 'doubao-secret', imageApiKey: 'image-secret' });
  const service = imageService();
  const app = await createApp({ store, token: 'page', mediaFetcher: async (url, request) => url.includes('openspeech') ? speech(['audio']) : service.fetcher(url, request),
    autostart: { view: () => ({ supported: false }), refresh: async () => {} }, keepAwake: { apply() {}, child: null, error: '' } });
  const base = await app.listen(0); t.after(() => app.close());
  const origin = new URL(base).origin;
  const api = (route, body) => fetch(`${origin}/api/${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer page', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await (await api('persona', PERSONA)).json()).name, '小雅');
  const page = await api('state'), text = await page.text();
  assert.ok(!text.includes('doubao-secret')); assert.ok(!text.includes('image-secret'));
  assert.equal(JSON.parse(text).persona.name, '小雅');
  assert.match(page.headers.get('content-security-policy'), /media-src data:/);
  assert.match((await (await api('voice/test', {})).json()).audio, /^data:audio\/mpeg;base64,/);
  assert.equal((await (await api('image/check', {})).json()).balance, 6.36);
  assert.equal((await (await api('persona/portrait')).json()).image, null);
  assert.equal((await api('persona', { enabled: true, name: '' })).status, 400);
  const large = Buffer.alloc(600000, 1), photo = Buffer.concat([png, large]);
  const upload = await api('persona/portrait/upload', { image: 'data:image/png;base64,' + photo.toString('base64') });
  assert.equal(upload.status, 200);
  assert.match((await (await api('persona/portrait')).json()).image, /^data:image\/png;base64,/);
  assert.equal((await api('persona', { name: 'x'.repeat(300000) })).status, 400);
});
