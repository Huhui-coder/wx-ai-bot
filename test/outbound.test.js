import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { Processes } from '../src/processes.js';
import { Skills } from '../src/skills.js';
import { Tools } from '../src/tools.js';
import { Wechat } from '../src/wechat.js';
import { downloadAndDecrypt } from '../src/images.js';
import { encryptedSize, uploadURL } from '../src/outbound.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
const context = () => ({ signal: new AbortController().signal, notify: async () => {}, owner: 'wechat' });

async function setup(t, { cdn } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-outbound-')));
  const workspace = path.join(root, 'work'), inbox = path.join(root, '收件箱');
  await fs.mkdir(workspace); await fs.mkdir(inbox);
  const store = new Store(path.join(root, 'private')); store.saveConfig({ workspace, imageDirectory: inbox });
  const log = { api: [], uploads: [], sent: [] };
  const wx = new Wechat(store, { active: null }, { fetcher: async (url, request) => {
    if (url.includes('getuploadurl')) { const body = JSON.parse(request.body); log.api.push(body); return Response.json({ upload_param: 'upload-ticket' }); }
    if (url.includes('sendmessage')) { log.sent.push(JSON.parse(request.body).msg); return Response.json({}); }
    log.uploads.push({ url, body: Buffer.from(request.body), headers: request.headers });
    return cdn ? cdn(log.uploads.length) : new Response(null, { status: 200, headers: { 'x-encrypted-param': 'download-ticket' } });
  } });
  wx.account = { token: 'token', userId: 'owner', botId: 'bot', baseUrl: 'https://ilinkai.weixin.qq.com' };
  wx.status = 'connected'; wx.state.context = 'ctx';
  const processes = new Processes();
  const tools = new Tools(store, new Skills(store.dir, processes), processes, undefined, { getWechat: () => wx });
  t.after(async () => { processes.stopAll(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace, inbox, store, wx, tools, log };
}
// Decrypt with the same code that handles inbound media, so both directions must agree.
async function recover(log, media) {
  return downloadAndDecrypt({ media }, { fetcher: async () => new Response(log.uploads.at(-1).body), label: '附件' });
}

test('sent files follow the upload protocol and decrypt back to the exact bytes', async t => {
  const { workspace, tools, log } = await setup(t);
  const bytes = Buffer.from('%PDF-1.7 季度报告'); await fs.writeFile(path.join(workspace, '报告.pdf'), bytes);
  const result = await tools.execute('send_file', { path: '报告.pdf' }, context());
  assert.deepEqual(result, { sent: true, name: '报告.pdf', kind: 'file', bytes: bytes.length });
  const [request] = log.api;
  assert.equal(request.media_type, 3); assert.equal(request.to_user_id, 'owner'); assert.equal(request.no_need_thumb, true);
  assert.equal(request.rawsize, bytes.length); assert.equal(request.filesize, log.uploads[0].body.length);
  assert.equal(request.filesize, encryptedSize(bytes.length)); assert.match(request.aeskey, /^[a-f\d]{32}$/);
  assert.equal(request.rawfilemd5, createHash('md5').update(bytes).digest('hex'));
  assert.match(log.uploads[0].url, /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/upload\?encrypted_query_param=upload-ticket&filekey=[a-f\d]{32}$/);
  assert.equal(log.uploads[0].headers['Content-Type'], 'application/octet-stream');
  assert.equal(log.uploads[0].body.includes(bytes), false);
  const message = log.sent[0];
  assert.equal(message.context_token, 'ctx'); assert.equal(message.to_user_id, 'owner'); assert.equal(message.item_list.length, 1);
  const item = message.item_list[0];
  assert.equal(item.type, 4); assert.equal(item.file_item.file_name, '报告.pdf'); assert.equal(item.file_item.len, String(bytes.length));
  assert.equal(item.file_item.media.encrypt_query_param, 'download-ticket'); assert.equal(item.file_item.media.encrypt_type, 1);
  assert.deepEqual(await recover(log, item.file_item.media), bytes);
});

test('previewable images go out as image messages and the hex-text key format is preserved', async t => {
  const { workspace, tools, log } = await setup(t);
  await fs.writeFile(path.join(workspace, 'shot.png'), png);
  assert.equal((await tools.execute('send_file', { path: 'shot.png' }, context())).kind, 'image');
  assert.equal(log.api[0].media_type, 1);
  const { image_item: image } = log.sent[0].item_list[0];
  assert.equal(image.mid_size, encryptedSize(png.length));
  assert.equal(Buffer.from(image.media.aes_key, 'base64').toString(), log.api[0].aeskey);
  assert.deepEqual(await recover(log, image.media), png);
});

test('send_file reaches the workspace and inbox only, never private state or outside paths', async t => {
  const { root, inbox, store, workspace, tools, log } = await setup(t);
  await fs.writeFile(path.join(root, 'outside.txt'), 'secret'); await fs.writeFile(path.join(inbox, '收到.txt'), 'hello');
  await assert.rejects(tools.execute('send_file', { path: path.join(root, 'outside.txt') }, context()), /工作目录/);
  await assert.rejects(tools.execute('send_file', { path: '../outside.txt' }, context()), /工作目录/);
  await assert.rejects(tools.execute('send_file', { path: path.join(store.dir, 'config.json') }, context()), /工作目录/);
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(root, 'outside.txt'), path.join(inbox, 'link.txt'));
    await assert.rejects(tools.execute('send_file', { path: path.join(inbox, 'link.txt') }, context()), /收件目录之外/);
  }
  await fs.symlink(store.dir, path.join(workspace, 'escape'), 'junction');
  await assert.rejects(tools.execute('send_file', { path: 'escape/config.json' }, context()), /符号链接/);
  assert.equal(log.uploads.length, 0);
  assert.equal((await tools.execute('send_file', { path: path.join(inbox, '收到.txt') }, context())).sent, true);
});

test('empty, oversized and missing files are refused before anything is uploaded', async t => {
  const { workspace, tools, log } = await setup(t);
  await fs.writeFile(path.join(workspace, 'empty.txt'), '');
  await assert.rejects(tools.execute('send_file', { path: 'empty.txt' }, context()), /空的/);
  const big = await fs.open(path.join(workspace, 'big.bin'), 'w'); await big.truncate(25 * 1024 * 1024 + 1); await big.close();
  await assert.rejects(tools.execute('send_file', { path: 'big.bin' }, context()), /25 MB/);
  await assert.rejects(tools.execute('send_file', { path: 'none.txt' }, context()), /ENOENT|no such file/i);
  assert.equal(log.api.length, 0); assert.equal(log.sent.length, 0);
});

test('CDN uploads retry server failures, stop on client errors and never claim success', async t => {
  const flaky = await setup(t, { cdn: n => n < 3 ? new Response('busy', { status: 500 }) : new Response(null, { status: 200, headers: { 'x-encrypted-param': 'ok' } }) });
  await fs.writeFile(path.join(flaky.workspace, 'a.txt'), 'data');
  assert.equal((await flaky.tools.execute('send_file', { path: 'a.txt' }, context())).sent, true);
  assert.equal(flaky.log.uploads.length, 3);
  const denied = await setup(t, { cdn: () => new Response('no', { status: 403 }) });
  await fs.writeFile(path.join(denied.workspace, 'a.txt'), 'data');
  await assert.rejects(denied.tools.execute('send_file', { path: 'a.txt' }, context()), /403/);
  assert.equal(denied.log.uploads.length, 1); assert.equal(denied.log.sent.length, 0);
  const missing = await setup(t, { cdn: () => new Response(null, { status: 200 }) });
  await fs.writeFile(path.join(missing.workspace, 'a.txt'), 'data');
  await assert.rejects(missing.tools.execute('send_file', { path: 'a.txt' }, context()), /下载参数/);
  assert.equal(missing.log.uploads.length, 3); assert.equal(missing.log.sent.length, 0);
});

test('a paused or unbound WeChat connection reports failure instead of pretending to send', async t => {
  const { workspace, wx, tools, log } = await setup(t);
  await fs.writeFile(path.join(workspace, 'a.txt'), 'data');
  wx.status = 'stopped'; await assert.rejects(tools.execute('send_file', { path: 'a.txt' }, context()), /暂停或失效/);
  wx.status = 'connected'; wx.state.context = ''; await assert.rejects(tools.execute('send_file', { path: 'a.txt' }, context()), /发一条消息/);
  wx.account = {}; await assert.rejects(tools.execute('send_file', { path: 'a.txt' }, context()), /扫码/);
  assert.equal(log.uploads.length, 0);
});

test('upload addresses must stay on HTTPS WeChat hosts', () => {
  assert.equal(uploadURL({ upload_full_url: ' https://novac2c.cdn.weixin.qq.com/c2c/upload?x=1 ' }, 'k'), 'https://novac2c.cdn.weixin.qq.com/c2c/upload?x=1');
  assert.throws(() => uploadURL({}, 'k'), /上传地址/);
  for (const upload_full_url of ['http://novac2c.cdn.weixin.qq.com/x', 'https://evil.test/x', 'https://weixin.qq.com.evil.test/x', 'https://a.weixin.qq.com:8443/x']) assert.throws(() => uploadURL({ upload_full_url }, 'k'), /不受支持/);
  assert.equal(encryptedSize(15), 16); assert.equal(encryptedSize(16), 32);
});
