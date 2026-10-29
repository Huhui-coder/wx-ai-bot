import path from 'node:path';
import { downloadAndDecrypt, persistMedia, mediaMessageDigest, IMAGE_MAX_BYTES } from './images.js';

export function attachmentName(value) {
  let name = typeof value === 'string' ? value.replaceAll('\\', '/').split('/').at(-1) : '';
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '_').trim().replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'attachment.bin';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  const rawExt = path.extname(name);
  const ext = Buffer.byteLength(rawExt) <= 20 ? rawExt : '';
  const base = ext ? name.slice(0, -ext.length) : name;
  let short = '';
  for (const char of base) { if (Buffer.byteLength(short + char + ext) > 120) break; short += char; }
  return (short || 'attachment') + ext;
}
export async function saveAttachment(file, options = {}) {
  const maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
  let expected;
  if (file?.len !== undefined && file.len !== '') {
    if (!/^\d+$/.test(String(file.len))) throw new Error('附件大小信息无效');
    expected = Number(file.len);
    if (expected > maxBytes) throw new Error('附件超过大小限制（25 MB）');
  }
  if (!file?.media?.aes_key) throw new Error('附件缺少解密密钥，请重新发送');
  const bytes = await downloadAndDecrypt({ media: file.media }, { ...options, label: '附件' });
  if (expected !== undefined && bytes.length !== expected) throw new Error('附件大小与消息不符，未保存，请重新发送');
  const name = attachmentName(file.file_name);
  return persistMedia(bytes, { ...options, filename: `file-${mediaMessageDigest(options.messageId)}-${(options.index || 0) + 1}-${name}` });
}
