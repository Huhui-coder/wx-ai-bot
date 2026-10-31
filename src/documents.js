import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { getDocumentProxy, extractText } from 'unpdf';
import iconv from 'iconv-lite';

export const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
const INFLATED_MAX_BYTES = 100 * 1024 * 1024;
const PAGE_CHARS = 20000;
const LEGACY = new Set(['.doc', '.xls', '.ppt']);

function zipEntries(bytes) {
  let end = bytes.length - 22;
  const first = Math.max(0, end - 65535);
  while (end >= first && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < first) throw new Error('不是有效的 ZIP 容器');
  const count = bytes.readUInt16LE(end + 10), entries = new Map();
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 目录已损坏');
    const nameLength = bytes.readUInt16LE(offset + 28);
    entries.set(bytes.toString('utf8', offset + 46, offset + 46 + nameLength), {
      method: bytes.readUInt16LE(offset + 10), size: bytes.readUInt32LE(offset + 20), local: bytes.readUInt32LE(offset + 42) });
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
}
function zipText(bytes, entry) {
  const start = entry.local + 30 + bytes.readUInt16LE(entry.local + 26) + bytes.readUInt16LE(entry.local + 28);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method !== 8) throw new Error('ZIP 压缩方式不受支持');
  return inflateRawSync(data, { maxOutputLength: INFLATED_MAX_BYTES }).toString('utf8');
}
const unescapeXml = text => text.replace(/&(?:#(\d+)|#x([\da-f]+)|(lt|gt|amp|quot|apos));/gi, (_, dec, hex, name) =>
  dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[name.toLowerCase()]);
const attribute = (attributes, name) => attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

function wordText(xml) {
  const tokens = { '</w:p>': '\n', '</w:tc>': '\t', '</w:tr>': '\n' };
  return xml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '').replace(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>|<[^>]+>/g, (token, text) =>
    text !== undefined ? unescapeXml(text) : tokens[token] ?? (token.startsWith('<w:tab') ? '\t' : token.startsWith('<w:br') ? '\n' : ''));
}
function sheetColumn(reference) {
  let column = 0;
  for (const letter of (reference || '').replace(/\d+$/, '')) column = column * 26 + letter.charCodeAt(0) - 64;
  return column - 1;
}
function sheetText(xml, shared) {
  const rows = [];
  for (const [, body] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const [, attributes, inner = ''] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const type = attribute(attributes, 't'), raw = inner.match(/<v>([^<]*)<\/v>/)?.[1];
      const text = type === 's' ? shared[+raw] : type === 'inlineStr' ? [...inner.matchAll(/<t(?: [^>]*)?>([^<]*)<\/t>/g)].map(m => unescapeXml(m[1])).join('') : raw === undefined ? '' : unescapeXml(raw);
      const column = sheetColumn(attribute(attributes, 'r'));
      cells[column >= 0 ? column : cells.length] = text ?? '';
    }
    if (cells.length) rows.push(Array.from(cells, cell => cell ?? '').join('\t'));
  }
  return rows.join('\n');
}
function excelText(bytes, entries) {
  const read = name => entries.has(name) ? zipText(bytes, entries.get(name)) : '';
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, body]) =>
    [...body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?: [^>]*)?>([^<]*)<\/t>/g)].map(m => unescapeXml(m[1])).join(''));
  const targets = new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)].map(([, a]) => [attribute(a, 'Id'), attribute(a, 'Target')]));
  const parts = [];
  for (const [, attributes] of read('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const target = targets.get(attribute(attributes, 'r:id')); if (!target) continue;
    const name = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    parts.push(`## ${unescapeXml(attribute(attributes, 'name') || '工作表')}\n${sheetText(read(name), shared)}`);
  }
  return parts.join('\n\n');
}
function slidesText(bytes, entries) {
  const number = name => +name.match(/(\d+)\.xml$/)[1];
  return [...entries.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => number(a) - number(b)).map(name => {
    const text = zipText(bytes, entries.get(name)).replace(/<a:t>([^<]*)<\/a:t>|<\/a:p>|<[^>]+>/g, (token, value) => value !== undefined ? unescapeXml(value) : token === '</a:p>' ? '\n' : '');
    return `## 第 ${number(name)} 页\n${text.trim()}`;
  }).join('\n\n');
}
// Some fonts map CJK glyphs to look-alike Kangxi radicals; a PDF must read as normal Chinese.
export const normalizeRadicals = text => text.replace(/[\u2e80-\u2fdf]/g, char => char.normalize('NFKC'));
async function pdfText(bytes) {
  const { text, totalPages } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false });
  const pages = text.map((page, i) => `## 第 ${i + 1} 页\n${normalizeRadicals(page).trim()}`);
  return { text: pages.join('\n\n'), pages: totalPages, ...(text.some(page => page.trim()) ? {} : { note: '未提取到文字，这很可能是扫描件' }) };
}
// Chinese Windows tools still write GBK and UTF-16, and the compiled runtime's
// TextDecoder knows neither GBK nor its relatives, so this cannot rely on the platform.
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(bytes, 'utf-16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(bytes, 'utf-16be');
  if (bytes.includes(0)) throw new Error('不支持这种文件格式');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return iconv.decode(bytes, 'gb18030'); }
}
async function extract(bytes, extension) {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return { format: 'pdf', ...await pdfText(bytes) };
  if (bytes.subarray(0, 4).toString('latin1') === 'PK\x03\x04') {
    const entries = zipEntries(bytes);
    if (entries.has('word/document.xml')) return { format: 'docx', text: wordText(zipText(bytes, entries.get('word/document.xml'))) };
    if (entries.has('xl/workbook.xml')) return { format: 'xlsx', text: excelText(bytes, entries) };
    if (entries.has('ppt/presentation.xml')) return { format: 'pptx', text: slidesText(bytes, entries) };
    throw new Error('不支持这种文件格式');
  }
  if (LEGACY.has(extension)) throw new Error('暂不支持老版 Office 格式，请另存为 docx、xlsx 或 pptx');
  return { format: 'text', text: decodeText(bytes) };
}

export async function readDocument(file, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数');
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('只能读取文件');
  if (stat.size > DOCUMENT_MAX_BYTES) throw new Error('文档超过 50 MB，无法读取');
  let result;
  try { result = await extract(await fs.readFile(file), path.extname(file).toLowerCase()); }
  catch (e) {
    if (/^(不支持|暂不支持)/.test(e.message)) throw e;
    throw new Error('文档解析失败，文件可能已加密或损坏');
  }
  const { text, ...info } = result;
  const end = offset + PAGE_CHARS;
  return { ...info, totalChars: text.length, offset, text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
}
