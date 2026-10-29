import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv } from 'node:crypto';
import { attachmentName, saveAttachment } from '../src/attachments.js';
import { saveImage, mediaDay } from '../src/images.js';
import { Store } from '../src/store.js';
import { Wechat } from '../src/wechat.js';

const key = Buffer.from('0123456789abcdef');
const bytes = Buffer.from('%PDF-1.7\nfile fixture\n%%EOF');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
function encrypt(data) { const cipher = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(data), cipher.final()]); }
function file(name = '报价单.pdf', data = bytes) { return { file_name: name, len: String(data.length), media: { encrypt_query_param: 'private-ticket', aes_key: Buffer.from(key.toString('hex')).toString('base64') } }; }
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-files-')));
  const store = new Store(path.join(root, 'private')); const directory = path.join(root, '收件箱'); store.saveConfig({ imageDirectory: directory });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { store, root, directory, options: { directory, privateDir: store.dir, messageId: '18446744073709551615', day: '2026-10-30' } };
}

test('attachment names are portable, bounded and cannot escape into paths or Windows streams', () => {
  assert.equal(attachmentName('../../秘密.txt'), '秘密.txt');
  assert.equal(attachmentName('C:\\folder\\报告.docx'), '报告.docx');
  assert.equal(attachmentName('bad:part?.zip. '), 'bad_part_.zip');
  assert.equal(attachmentName('CON.txt'), '_CON.txt');
  assert.equal(attachmentName('..'), 'attachment.bin');
  assert.equal(attachmentName('a\nb\u202ec.txt'), 'a_b_c.txt');
  const name = attachmentName('中文😀'.repeat(100) + '.xlsx'); assert.equal(name.endsWith('.xlsx'), true); assert.ok(Buffer.byteLength(name) <= 120);
  assert.equal(mediaDay(Date.parse('2026-10-29T16:01:00Z')), '2026-10-30');
});

test('attachments decrypt exact bytes and preserve filenames; same names never overwrite other messages', async t => {
  const { options } = await setup(t); const fetcher = async () => new Response(encrypt(bytes));
  const saved = await saveAttachment(file(), { ...options, fetcher });
  assert.match(path.basename(saved.path), /^file-[a-f\d]{24}-1-报价单\.pdf$/); assert.deepEqual(await fs.readFile(saved.path), bytes);
  const modified = (await fs.stat(saved.path)).mtimeMs;
  await saveAttachment(file(), { ...options, fetcher }); assert.equal((await fs.stat(saved.path)).mtimeMs, modified);
  const second = await saveAttachment(file(), { ...options, messageId: 'second', fetcher }); assert.notEqual(saved.path, second.path);
  assert.equal((await fs.readdir(path.dirname(saved.path))).length, 2);
  if (process.platform !== 'win32') assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
});

test('ZIP, text and empty files are accepted as data; no extraction or execution occurs', async t => {
  const { options } = await setup(t);
  for (const [index, [name, data]] of [['demo.zip', Buffer.from('PK\x03\x04opaque zip')], ['note.txt', Buffer.from('hello')], ['empty.bin', Buffer.alloc(0)], ['script.sh', Buffer.from('touch MUST_NOT_RUN')]].entries()) {
    const saved = await saveAttachment(file(name, data), { ...options, index, fetcher: async () => new Response(encrypt(data)) });
    assert.deepEqual(await fs.readFile(saved.path), data);
  }
});

test('attachments reject oversize, bad length, missing keys and corrupted encryption before claiming saved', async t => {
  const { directory, options } = await setup(t); let fetched = 0;
  const fetcher = async () => { fetched++; return new Response(encrypt(bytes)); };
  await assert.rejects(saveAttachment({ ...file(), len: '9999999999999' }, { ...options, fetcher }), /大小限制/); assert.equal(fetched, 0);
  await assert.rejects(saveAttachment({ ...file(), len: '-1' }, { ...options, fetcher }), /大小信息/);
  await assert.rejects(saveAttachment({ ...file(), media: { full_url: 'https://novac2c.cdn.weixin.qq.com/a' } }, { ...options, fetcher }), /缺少解密密钥/);
  await assert.rejects(saveAttachment({ ...file(), len: '1' }, { ...options, fetcher }), /大小与消息不符/);
  await assert.rejects(saveAttachment(file(), { ...options, fetcher: async () => new Response('not-encrypted') }), /解密失败/);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});
function msg(id = 'file-msg') { return { message_id: id, from_user_id: 'owner', context_token: 'ctx', item_list: [{ type: 4, file_item: file() }] }; }
function bot(store, fetcher) {
  const sent = [], downloads = [];
  const wx = new Wechat(store, { active: {}, run() { throw new Error('must not call model'); } }, { fetcher: async (url, request) => {
    if (url.includes('sendmessage')) { sent.push(JSON.parse(request.body).msg.item_list[0].text_item.text); return Response.json({}); }
    downloads.push(url); return fetcher ? fetcher(url, request) : new Response(encrypt(bytes));
  } });
  wx.account = { userId: 'owner', botId: 'bot', token: 'token' }; wx.status = 'connected';
  return { wx, sent, downloads };
}

test('only the owner can save attachments; durable dedup and real path receipts work without a model key', async t => {
  const { store } = await setup(t); const { wx, sent, downloads } = bot(store);
  await wx.ingest({ ...msg(), from_user_id: 'intruder' }); await wx.drain(); assert.equal(downloads.length, 0);
  await wx.ingest(msg()); await wx.ingest(msg()); await wx.drain();
  assert.equal(downloads.length, 1); assert.match(sent[0], /已保存 1 个文件/);
  const saved = wx.state.inbox[0].savedMedia[0]; assert.ok(sent[0].includes(saved.path)); assert.deepEqual(await fs.readFile(saved.path), bytes);
  assert.equal(wx.state.inbox[0].media, undefined); assert.equal(JSON.stringify(store.events).includes('private-ticket'), false);
  const restored = bot(new Store(store.dir)); await restored.wx.ingest(msg()); await restored.wx.drain(); assert.equal(restored.downloads.length, 0);
});

test('mixed photo and file messages recover progress and report each success or failure', async t => {
  const { store } = await setup(t); let n = 0;
  const { wx, sent } = bot(store, async () => ++n === 1 ? new Response(encrypt(png)) : new Response('bad'));
  const mixed = { ...msg(), item_list: [{ type: 2, image_item: { media: file().media } }, ...msg().item_list] };
  await wx.ingest(mixed); await wx.drain();
  assert.match(sent[0], /已保存 1 个文件/); assert.match(sent[0], /第 2 个文件：附件解密失败/);
  assert.deepEqual(await fs.readFile(wx.state.inbox[0].savedMedia[0].path), png);
});

test('v0.4 pending image jobs migrate and resume without losing saved progress', async t => {
  const { store, options } = await setup(t);
  const image = { media: file().media };
  const saved = await saveImage(image, { ...options, messageId: 'legacy', fetcher: async () => new Response(encrypt(png)) });
  store.write('wechat-state', { context: 'ctx', seen: ['legacy'], inbox: [{ id: 'legacy', status: 'running', images: [image, image], savedImages: [saved], directory: options.directory, day: options.day }] });
  const { wx, downloads, sent } = bot(store, async () => new Response(encrypt(png))); await wx.drain();
  assert.equal(downloads.length, 1); assert.match(sent[0], /已保存 2 张图片/); assert.equal(wx.state.inbox[0].savedMedia.length, 2);
});

test('interrupted attachment downloads resume safely after restart', async t => {
  const { store } = await setup(t); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { wx } = bot(store, async (_url, request) => { started(); return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); });
  await wx.ingest(msg()); const draining = wx.drain(); await ready; wx.stop(); await draining;
  assert.equal(wx.state.inbox[0].status, 'pending');
  const restored = bot(new Store(store.dir)); await restored.wx.drain(); assert.match(restored.sent[0], /已保存 1 个文件/);
});

test('pausing during the final file commit does not send a receipt until safely resumed', async t => {
  const { store, directory } = await setup(t); const { wx, sent } = bot(store);
  const originalLink = fs.link;
  fs.link = async (...args) => { await originalLink(...args); wx.stop(); };
  try { await wx.ingest(msg()); await wx.drain(); }
  finally { fs.link = originalLink; }
  assert.equal(sent.length, 0); assert.equal(wx.state.inbox[0].status, 'pending');
  const day = (await fs.readdir(directory))[0]; const before = await fs.readdir(path.join(directory, day)); assert.equal(before.length, 1);
  const restored = bot(new Store(store.dir)); await restored.wx.drain();
  assert.match(restored.sent[0], /已保存 1 个文件/); assert.deepEqual(await fs.readdir(path.join(directory, day)), before);
});
