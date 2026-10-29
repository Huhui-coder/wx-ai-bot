import fs from 'node:fs/promises';
import syncFS from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c/download';

// Resolve existing ancestors as well, so an alias cannot point into private data.
export function imageDirectory(value, privateDir) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写收件保存目录');
  value = value.trim();
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value)) throw new Error('收件保存目录必须是绝对路径');
  let ancestor = path.resolve(value); const missing = [];
  while (!syncFS.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('收件保存目录不存在');
    missing.unshift(path.basename(ancestor)); ancestor = parent;
  }
  if (!syncFS.statSync(ancestor).isDirectory()) throw new Error('收件保存路径必须是文件夹');
  const target = path.join(syncFS.realpathSync(ancestor), ...missing);
  if (privateDir) {
    const relative = path.relative(syncFS.realpathSync(privateDir), target);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('收件不能保存到助手的私有数据目录');
    }
  }
  return target;
}

export function imageDownloadURL(media, label = '图片') {
  let url;
  try {
    if (media?.full_url) url = new URL(media.full_url);
    else {
      if (typeof media?.encrypt_query_param !== 'string' || !media.encrypt_query_param) throw new Error();
      url = new URL(CDN); url.searchParams.set('encrypted_query_param', media.encrypt_query_param);
    }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.cdn.weixin.qq.com') ||
      url.port || url.username || url.password || url.hash) throw new Error();
  } catch { throw new Error(`${label}下载地址缺失或不受支持`); }
  return url.href;
}

export function imageKey(image, label = '图片') {
  if (image?.aeskey) {
    if (typeof image.aeskey !== 'string' || !/^[a-f\d]{32}$/i.test(image.aeskey)) throw new Error(`${label}解密密钥格式错误`);
    return Buffer.from(image.aeskey, 'hex');
  }
  const encoded = image?.media?.aes_key;
  if (!encoded) return null; // The protocol also allows unencrypted CDN images.
  if (typeof encoded !== 'string' || encoded.length > 64 || !/^[A-Za-z\d+/]+={0,2}$/.test(encoded)) throw new Error(`${label}解密密钥格式错误`);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f\d]{32}$/i.test(decoded.toString('latin1'))) return Buffer.from(decoded.toString('latin1'), 'hex');
  throw new Error(`${label}解密密钥格式错误`);
}

export function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (bytes.subarray(0, 2).toString() === 'BM') return 'bmp';
  if (['49492a00', '4d4d002a'].includes(bytes.subarray(0, 4).toString('hex'))) return 'tiff';
  if (bytes.subarray(4, 8).toString() === 'ftyp') {
    const brands = bytes.subarray(8, Math.min(bytes.length, 64)).toString('ascii');
    if (/avif|avis/.test(brands)) return 'avif';
    if (/heic|heix|hevc|hevx|mif1|msf1/.test(brands)) return 'heic';
  }
  throw new Error('下载内容不是受支持的图片，未保存');
}

async function download(url, { fetcher, signal, maxBytes, label }) {
  const combined = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(45000)]);
  let response, reader;
  try {
    response = await fetcher(url, { redirect: 'error', signal: combined, credentials: 'omit' });
    if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error(`${label}超过大小限制（25 MB）`);
    reader = response.body?.getReader();
    if (!reader) throw new Error(`${label}下载内容为空`);
    const chunks = []; let size = 0;
    while (true) {
      combined.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error(`${label}超过大小限制（25 MB）`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (combined.aborted) throw new Error(signal?.aborted ? `${label}保存已停止` : `${label}下载超时，请重新发送`);
    if (error.message.startsWith(label)) throw error;
    throw new Error(`${label}下载失败，请检查网络后重新发送`);
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    else await response?.body?.cancel().catch(() => {});
  }
}

export function mediaDay(now = Date.now()) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
export async function downloadAndDecrypt(item, { fetcher = fetch, signal, maxBytes = IMAGE_MAX_BYTES, label = '图片' } = {}) {
  if (item?.media?.encrypt_type && item.media.encrypt_type !== 1) throw new Error(`不支持的${label}加密类型`);
  const key = imageKey(item, label);
  let bytes = await download(imageDownloadURL(item?.media, label), { fetcher, signal, maxBytes: maxBytes + (key ? 16 : 0), label });
  if (key) {
    try {
      const decipher = createDecipheriv('aes-128-ecb', key, null);
      bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
    } catch { throw new Error(`${label}解密失败，请重新发送`); }
  }
  if (bytes.length > maxBytes) throw new Error(`${label}超过大小限制（25 MB）`);
  return bytes;
}
export const mediaMessageDigest = id => createHash('sha256').update(String(id)).digest('hex').slice(0, 24);

export async function persistMedia(bytes, { directory, privateDir, filename, day = mediaDay(), signal }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('收件日期无效');
  if (!filename || /[\\/\0]/.test(filename) || filename === '.' || filename === '..') throw new Error('收件文件名无效');
  const root = imageDirectory(directory, privateDir);
  let temp;
  try {
    await fs.mkdir(root, { recursive: true });
    const canonical = imageDirectory(await fs.realpath(root), privateDir && await fs.realpath(privateDir));
    const folder = path.join(canonical, day);
    await fs.mkdir(folder, { recursive: true });
    if ((await fs.lstat(folder)).isSymbolicLink() || await fs.realpath(folder) !== folder) throw new Error('收件日期目录不能是符号链接');
    const target = path.join(folder, filename);
    const existing = async () => {
      let stat;
      try { stat = await fs.lstat(target); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length || !(await fs.readFile(target)).equals(bytes)) throw new Error('同名文件已存在且内容不同，未覆盖');
      return true;
    };
    signal?.throwIfAborted();
    if (!await existing()) {
      temp = path.join(folder, '.' + randomUUID() + '.tmp');
      await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
      signal?.throwIfAborted();
      try { await fs.link(temp, target); }
      catch (e) { if (e.code !== 'EEXIST' || !await existing()) throw e; }
    }
    return { path: target, bytes: bytes.length };
  } catch (error) {
    if (signal?.aborted) throw new Error('收件保存已停止');
    if (/^(收件日期目录|同名文件)/.test(error.message)) throw error;
    throw new Error('无法写入收件保存目录，请检查路径、磁盘空间和写入权限');
  } finally { if (temp) await fs.unlink(temp).catch(() => {}); }
}
export async function saveImage(image, options = {}) {
  const bytes = await downloadAndDecrypt(image, options);
  const extension = imageExtension(bytes);
  return persistMedia(bytes, { ...options, filename: `image-${mediaMessageDigest(options.messageId)}-${(options.index || 0) + 1}.${extension}` });
}
