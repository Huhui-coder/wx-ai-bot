import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv } from 'node:crypto';
import { Store } from '../src/store.js';
import { Wechat } from '../src/wechat.js';
import { saveImage, imageKey, imageDownloadURL } from '../src/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
const key = Buffer.from('0123456789abcdef');
function encrypt(bytes = png, secret = key) {
  const cipher = createCipheriv('aes-128-ecb', secret, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
const image = () => ({ media: { encrypt_query_param: 'opaque+/=&ticket', aes_key: key.toString('base64'), encrypt_type: 1 } });
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-images-')));
  const directory = path.join(root, '图片 收件箱');
  const store = new Store(path.join(root, 'private'));
  store.saveConfig({ imageDirectory: directory });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, directory, store, options: { directory, privateDir: store.dir, messageId: '../../unsafe:msg?123', day: '2026-10-29' } };
}

test('image AES keys accept official variants and prefer image_item.aeskey', () => {
  for (const aes_key of [key.toString('base64'), Buffer.from(key.toString('hex')).toString('base64')]) assert.deepEqual(imageKey({ media: { aes_key } }), key);
  assert.deepEqual(imageKey({ aeskey: key.toString('hex'), media: { aes_key: 'invalid' } }), key);
  assert.equal(imageKey({ media: {} }), null);
  assert.throws(() => imageKey({ aeskey: 'broken' }), /密钥/);
  assert.throws(() => imageKey({ media: { aes_key: 'bad!!!!' } }), /密钥/);
  const url = new URL(imageDownloadURL(image().media));
  assert.equal(url.searchParams.get('encrypted_query_param'), 'opaque+/=&ticket');
  assert.equal(imageDownloadURL({ full_url: 'https://novac2c.cdn.weixin.qq.com/full?ticket=1' }), 'https://novac2c.cdn.weixin.qq.com/full?ticket=1');
  for (const full_url of ['http://novac2c.cdn.weixin.qq.com/a', 'https://127.0.0.1/a', 'https://novac2c.cdn.weixin.qq.com.evil.test/a', 'https://u:p@novac2c.cdn.weixin.qq.com/a', 'https://novac2c.cdn.weixin.qq.com:444/a']) assert.throws(() => imageDownloadURL({ full_url }), /地址/);
});

test('download decrypts exact image bytes, writes atomically and deduplicates without overwriting', async t => {
  const { directory, options } = await setup(t); let calls = 0;
  const fetcher = async (url, request) => {
    calls++; assert.equal(request.headers, undefined); assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
    return new Response(encrypt(), { headers: { 'content-type': 'application/octet-stream' } });
  };
  const saved = await saveImage(image(), { ...options, fetcher });
  assert.equal(saved.bytes, png.length); assert.equal(path.dirname(saved.path), path.join(directory, '2026-10-29'));
  assert.match(path.basename(saved.path), /^image-[a-f\d]{24}-1\.png$/);
  assert.deepEqual(await fs.readFile(saved.path), png);
  const modified = (await fs.stat(saved.path)).mtimeMs;
  await saveImage(image(), { ...options, fetcher });
  assert.equal((await fs.stat(saved.path)).mtimeMs, modified); assert.equal(calls, 2);
  assert.equal((await fs.readdir(path.dirname(saved.path))).length, 1);
  await fs.writeFile(saved.path, 'do not overwrite');
  await assert.rejects(saveImage(image(), { ...options, fetcher }), /未覆盖/);
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'do not overwrite');
});

test('full_url plaintext images and encrypted hex keys save without a model', async t => {
  const { options } = await setup(t);
  const plain = { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/plain' } };
  const saved = await saveImage(plain, { ...options, fetcher: async () => new Response(png) });
  assert.deepEqual(await fs.readFile(saved.path), png);
  const item = image(); item.aeskey = key.toString('hex'); item.media.aes_key = 'ignored';
  const second = await saveImage(item, { ...options, index: 1, fetcher: async () => new Response(encrypt()) });
  assert.deepEqual(await fs.readFile(second.path), png);
});

test('bad keys, decryption, HTTP errors, HTML and oversized streams never create images or disclose tickets', async t => {
  const { directory, options } = await setup(t);
  const cases = [
    [image(), async () => new Response('not ciphertext'), /解密/],
    [image(), async () => new Response('', { status: 403 }), /HTTP 403/],
    [image(), async () => { throw new Error('https://cdn/?SECRET-TICKET'); }, /下载失败/],
    [{ media: { encrypt_query_param: 'x' } }, async () => new Response('<html>error</html>'), /不是受支持/],
    [image(), async () => new Response(encrypt(), { headers: { 'content-length': '99999999' } }), /大小限制/],
    [{ media: { encrypt_query_param: 'x' } }, async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(33)); c.close(); } })), /大小限制/],
  ];
  for (const [item, fetcher, expected] of cases) await assert.rejects(saveImage(item, { ...options, maxBytes: 32, fetcher }), e => { assert.match(e.message, expected); assert.equal(e.message.includes('SECRET-TICKET'), false); return true; });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('configured folders reject relative paths, private storage, files and escaped date folders', async t => {
  const { root, store, directory, options } = await setup(t);
  assert.throws(() => store.saveConfig({ imageDirectory: '../relative' }), /绝对路径/);
  assert.throws(() => store.saveConfig({ imageDirectory: store.dir }), /私有/);
  const file = path.join(root, 'file'); await fs.writeFile(file, 'keep');
  assert.throws(() => store.saveConfig({ imageDirectory: file }), /文件夹/);
  assert.equal(new Store(store.dir).publicConfig().imageDirectory, directory);
  await fs.mkdir(directory); const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(directory, options.day), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveImage(image(), { ...options, fetcher: async () => new Response(encrypt()) }), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
  const alias = path.join(root, 'alias'); await fs.symlink(store.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.saveConfig({ imageDirectory: alias }), /私有/);
  assert.throws(() => store.saveConfig({ imageDirectory: path.join(alias, 'new') }), /私有/);
  await assert.rejects(fs.stat(path.join(store.dir, 'new')), { code: 'ENOENT' });
});

function message(items = [image()], id = '18446744073709551615') {
  return { message_id: id, from_user_id: 'owner', message_type: 1, context_token: 'ctx', item_list: items.map(image_item => ({ type: 2, image_item })) };
}
function bot(store, { mediaFetcher = async () => new Response(encrypt()), failReply = false } = {}) {
  const sent = [], downloads = [];
  const wx = new Wechat(store, { active: { busy: true }, run() { throw new Error('Images must not call the model'); }, stop() { return '已停止'; } }, { fetcher: async (url, request) => {
    if (url.includes('/sendmessage')) { if (failReply) throw new Error('offline'); sent.push(JSON.parse(request.body).msg.item_list[0].text_item.text); return Response.json({}); }
    downloads.push(url); return mediaFetcher(url, request);
  } });
  wx.account = { token: 'private-wx-token', userId: 'owner' }; wx.status = 'connected';
  return { wx, sent, downloads };
}

test('WeChat owner image receipt downloads once, saves in configured folder and replies with real path', async t => {
  const { store, directory } = await setup(t); const { wx, sent, downloads } = bot(store);
  await wx.ingest({ ...message(), from_user_id: 'intruder' }); await wx.drain(); assert.equal(downloads.length, 0);
  await wx.ingest({ ...message(), message_type: 2 }); assert.equal(wx.state.inbox.length, 0);
  await wx.ingest(message()); await wx.ingest(message()); await wx.drain();
  assert.equal(downloads.length, 1); assert.equal(sent.length, 1); assert.match(sent[0], /已保存 1 张图片/);
  const saved = wx.state.inbox[0].savedImages[0]; assert.equal(saved.path.startsWith(directory + path.sep), true);
  assert.equal(sent[0].includes(saved.path), true); assert.deepEqual(await fs.readFile(saved.path), png);
  assert.equal(wx.state.inbox[0].images, undefined);
  assert.equal(JSON.stringify(store.events).includes('opaque'), false);
  const restarted = bot(new Store(store.dir)); await restarted.wx.ingest(message()); await restarted.wx.drain(); assert.equal(restarted.downloads.length, 0);
});

test('mixed image success/failure replies honestly; undelivered receipt survives restart without redownload', async t => {
  const { store } = await setup(t); let n = 0;
  const { wx } = bot(store, { failReply: true, mediaFetcher: async () => ++n === 1 ? new Response(encrypt()) : new Response('bad') });
  await wx.ingest(message([image(), image()])); await wx.drain();
  assert.equal(wx.state.inbox[0].status, 'failed'); assert.equal(wx.state.outbox.length, 1);
  assert.match(wx.state.outbox[0].text, /已保存 1 张图片/); assert.match(wx.state.outbox[0].text, /第 2 张：图片解密失败/);
  const recovered = bot(new Store(store.dir)); await recovered.wx.flush();
  assert.equal(recovered.downloads.length, 0); assert.equal(recovered.sent.length, 1); assert.equal(recovered.wx.state.outbox.length, 0);
});

test('restart resumes image jobs at the first unsaved image and retains original folder', async t => {
  const { store, root } = await setup(t); const original = bot(store);
  await original.wx.ingest(message([image(), image()]));
  const job = original.wx.state.inbox[0]; job.status = 'running';
  job.savedImages.push(await saveImage(image(), { directory: job.directory, privateDir: store.dir, messageId: job.id, index: 0, day: job.day, fetcher: async () => new Response(encrypt()) }));
  original.wx.save(); store.saveConfig({ imageDirectory: path.join(root, 'changed') });
  const { wx, downloads, sent } = bot(new Store(store.dir)); await wx.drain();
  assert.equal(downloads.length, 1); assert.match(sent[0], /已保存 2 张图片/);
  assert.equal(wx.state.inbox[0].savedImages.every(s => path.dirname(s.path) === path.join(job.directory, job.day)), true);
});

test('stopping an in-flight download leaves no file and allows safe resumption', async t => {
  const { store, directory } = await setup(t); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { wx } = bot(store, { mediaFetcher: async (_url, request) => {
    started(); return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  } });
  await wx.ingest(message()); const draining = wx.drain(); await ready; wx.stop(); await draining;
  assert.equal(wx.state.inbox[0].status, 'pending'); assert.equal(wx.state.outbox.length, 0);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  const recovered = bot(new Store(store.dir)); await recovered.wx.drain(); assert.equal(recovered.sent.length, 1);
});
