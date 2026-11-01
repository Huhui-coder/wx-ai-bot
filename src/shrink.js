import zlib from 'node:zlib';
import { imageExtension } from './images.js';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex'), TARGET_WIDTH = 512;
const CHANNELS = { 2: 3, 6: 4 };

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc(bytes) { let c = ~0; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (~c) >>> 0; }
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, sum]);
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function decode(png) {
  let width, height, depth, color, interlace; const data = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8), body = png.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12]; }
    if (type === 'IDAT') data.push(body);
    if (type === 'IEND') break;
    at += size + 12;
  }
  const channels = CHANNELS[color];
  if (depth !== 8 || !channels || interlace) return null;
  const raw = zlib.inflateSync(Buffer.concat(data)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], from = y * (stride + 1) + 1, to = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[to + x - channels] : 0, up = y ? pixels[to + x - stride] : 0, corner = x >= channels && y ? pixels[to + x - stride - channels] : 0;
      const guess = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : 0;
      pixels[to + x] = raw[from + x] + guess;
    }
  }
  return { width, height, channels, pixels };
}
function downscale({ width, height, channels, pixels }, factor) {
  const w = Math.floor(width / factor), h = Math.floor(height / factor), out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) sum += pixels[((y * factor + dy) * width + x * factor + dx) * channels + c];
    out[(y * w + x) * 3 + c] = Math.round(sum / (factor * factor));
  }
  return { width: w, height: h, pixels: out };
}
function encode({ width, height, pixels }) {
  const stride = width * 3, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const to = y * (stride + 1), row = y * stride;
    raw[to] = 4;
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? pixels[row + x - 3] : 0, up = y ? pixels[row + x - stride] : 0, corner = x >= 3 && y ? pixels[row + x - stride - 3] : 0;
      raw[to + 1 + x] = pixels[row + x] - paeth(left, up, corner);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// The video service uploads slowly and refuses other formats, so a full portrait would time out.
export function compactReference(bytes, maxBytes) {
  const type = imageExtension(bytes);
  if (type === 'jpg' && bytes.length <= maxBytes * 2) return bytes;
  if (type !== 'png') throw new Error('形象照格式或大小不受支持，请用户到人格页重新设置一张');
  if (bytes.length <= maxBytes) return bytes;
  const image = decode(bytes);
  if (!image) throw new Error('形象照格式或大小不受支持，请用户到人格页重新设置一张');
  const smaller = encode(downscale(image, Math.max(2, Math.ceil(image.width / TARGET_WIDTH))));
  if (smaller.length > maxBytes * 2) throw new Error('形象照太大，请用户到人格页重新设置一张');
  return smaller;
}
