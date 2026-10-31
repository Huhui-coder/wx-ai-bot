import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { IMAGE_MAX_BYTES, imageExtension } from './images.js';
import { attachmentName } from './attachments.js';

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
const MEDIA_IMAGE = 1, MEDIA_FILE = 3;
// HEIC, TIFF and AVIF do not preview reliably in the chat, so they go out as files.
const PREVIEWABLE = new Set(['png', 'jpg', 'gif', 'webp', 'bmp']);

export const encryptedSize = size => Math.ceil((size + 1) / 16) * 16;
export function isPreviewable(bytes) {
  try { return PREVIEWABLE.has(imageExtension(bytes)); } catch { return false; }
}
export function uploadURL({ upload_full_url: full, upload_param: param }, filekey) {
  const href = full?.trim() || (param ? `${CDN}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}` : '');
  let url;
  try { url = new URL(href); } catch { throw new Error('微信没有返回可用的上传地址'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.port || url.username || url.password || url.hash) throw new Error('微信返回了不受支持的上传地址');
  return url.href;
}
async function postCiphertext(url, body, { fetcher, signal }) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const res = await fetcher(url, { method: 'POST', redirect: 'error', credentials: 'omit', body,
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(120000)]) });
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`微信 CDN 拒绝了上传（HTTP ${res.status}）`), { fatal: true });
      if (res.status !== 200) throw new Error(`微信 CDN 上传失败（HTTP ${res.status}）`);
      const param = res.headers.get('x-encrypted-param');
      if (!param) throw new Error('微信 CDN 没有返回下载参数');
      return param;
    } catch (e) { if (e.fatal || signal?.aborted) throw e; failure = e; }
  }
  throw failure;
}
export async function uploadMedia(file, { request, fetcher = fetch, toUserId, signal, maxBytes = IMAGE_MAX_BYTES }) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('只能发送文件');
  if (!stat.size) throw new Error('文件是空的，未发送');
  if (stat.size > maxBytes) throw new Error('文件超过 25 MB，微信发送暂不支持');
  const bytes = await fs.readFile(file);
  const image = isPreviewable(bytes);
  const key = randomBytes(16), filekey = randomBytes(16).toString('hex'), aeskey = key.toString('hex');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const target = await request('ilink/bot/getuploadurl', { filekey, media_type: image ? MEDIA_IMAGE : MEDIA_FILE, to_user_id: toUserId,
    rawsize: bytes.length, rawfilemd5: createHash('md5').update(bytes).digest('hex'), filesize: ciphertext.length, no_need_thumb: true, aeskey }, { signal });
  const param = await postCiphertext(uploadURL(target, filekey), ciphertext, { fetcher, signal });
  // The protocol carries the hex key text as base64, not the 16 raw bytes.
  const media = { encrypt_query_param: param, aes_key: Buffer.from(aeskey).toString('base64'), encrypt_type: 1 };
  const name = attachmentName(path.basename(file));
  return { name, bytes: bytes.length, kind: image ? 'image' : 'file', item: image
    ? { type: 2, image_item: { media, mid_size: ciphertext.length } }
    : { type: 4, file_item: { media, file_name: name, len: String(bytes.length) } } };
}
