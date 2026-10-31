import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { createCipheriv } from 'node:crypto';
import { Store } from '../src/store.js';
import { Processes } from '../src/processes.js';
import { Skills } from '../src/skills.js';
import { Tools } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { Wechat } from '../src/wechat.js';
import { readDocument, normalizeRadicals, decodeText } from '../src/documents.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
// Office files are ZIP containers; build real ones so the reader is exercised end to end.
function zip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name), data = deflateRawSync(Buffer.from(content));
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(8, 10);
    head.writeUInt32LE(data.length, 20); head.writeUInt16LE(nameBytes.length, 28); head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function pdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(body + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-docs-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('PDF text is extracted page by page', async t => {
  const root = await setup(t); const file = path.join(root, 'report.pdf');
  await fs.writeFile(file, pdf('Quarterly revenue grew'));
  const result = await readDocument(file);
  assert.equal(result.format, 'pdf'); assert.equal(result.pages, 1);
  assert.match(result.text, /第 1 页/); assert.match(result.text, /Quarterly revenue grew/);
});

test('look-alike Kangxi radicals from PDF fonts become normal Chinese', () => {
  assert.equal(normalizeRadicals('中\u2F42测试：\u2F00百万 ABC'), '中文测试：一百万 ABC');
});

test('Windows text encodings decode without relying on the runtime', () => {
  assert.equal(decodeText(Buffer.from('c4e3bac3', 'hex')), '你好');
  assert.equal(decodeText(Buffer.from('fffe604f7d59', 'hex')), '你好');
  assert.equal(decodeText(Buffer.from('feff4f60597d', 'hex')), '你好');
  assert.equal(decodeText(Buffer.from('efbbbfe4bda0e5a5bd', 'hex')), '你好');
  assert.throws(() => decodeText(Buffer.from([1, 0, 2])), /不支持/);
});

test('Word text keeps paragraphs, table cells, escapes and Chinese', async t => {
  const root = await setup(t); const file = path.join(root, '方案.docx');
  await fs.writeFile(file, zip({ 'word/document.xml': `<w:document><w:body>
    <w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t>第一段 &amp; 说明</w:t></w:r><w:r><w:t xml:space="preserve"> 继续</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>第二段</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>换行</w:t></w:r></w:p></w:body></w:document>` }));
  const { format, text } = await readDocument(file);
  assert.equal(format, 'docx');
  assert.match(text, /第一段 & 说明 继续\n/); assert.match(text, /甲\n\t乙/); assert.match(text, /第二段\n换行/);
  assert.equal(text.startsWith('\t'), false);
});

test('Excel output follows sheet order, resolves shared strings and keeps empty columns', async t => {
  const root = await setup(t); const file = path.join(root, '预算.xlsx');
  await fs.writeFile(file, zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="二月" sheetId="2" r:id="rId2"/><sheet name="一月 &amp; 汇总" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Target="/xl/worksheets/sheet2.xml" Id="rId2"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>项目</t></si><si><r><t>金</t></r><r><t>额</t></r><rPh sb="0"><t>x</t></rPh></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>房租</t></is></c><c r="C2"><v>1200.5</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
  }));
  const { format, text } = await readDocument(file);
  assert.equal(format, 'xlsx');
  assert.ok(text.indexOf('## 二月') < text.indexOf('## 一月 & 汇总'));
  assert.match(text, /项目\t\t金额/); assert.match(text, /房租\t\t1200\.5/);
});

test('PowerPoint slides stay in numeric order', async t => {
  const root = await setup(t); const file = path.join(root, '路演.pptx');
  const slide = text => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
  await fs.writeFile(file, zip({ 'ppt/presentation.xml': '<p:presentation/>', 'ppt/slides/slide10.xml': slide('十'), 'ppt/slides/slide2.xml': slide('二') }));
  const { format, text } = await readDocument(file);
  assert.equal(format, 'pptx'); assert.ok(text.indexOf('第 2 页') < text.indexOf('第 10 页')); assert.match(text, /二/);
});

test('plain text handles UTF-8 and GBK and long documents page through nextOffset', async t => {
  const root = await setup(t); const file = path.join(root, 'long.txt');
  const full = '数据'.repeat(15000);
  await fs.writeFile(file, full);
  const first = await readDocument(file);
  assert.equal(first.totalChars, 30000); assert.equal(first.text.length, 20000); assert.equal(first.nextOffset, 20000);
  const second = await readDocument(file, first.nextOffset);
  assert.equal(second.nextOffset, undefined); assert.equal(first.text + second.text, full);
  const gbk = path.join(root, 'gbk.csv');
  await fs.writeFile(gbk, Buffer.from('c4e3bac3', 'hex'));
  assert.equal((await readDocument(gbk)).text, '你好');
});

test('unsupported, damaged and legacy documents explain themselves', async t => {
  const root = await setup(t);
  const write = async (name, data) => { const file = path.join(root, name); await fs.writeFile(file, data); return file; };
  await assert.rejects(readDocument(await write('a.bin', Buffer.from([1, 0, 2]))), /不支持这种文件格式/);
  await assert.rejects(readDocument(await write('a.doc', Buffer.from([0xd0, 0xcf, 0, 0]))), /老版 Office/);
  await assert.rejects(readDocument(await write('b.pdf', '%PDF-1.4 broken')), /解析失败/);
  await assert.rejects(readDocument(await write('c.docx', Buffer.from('PK\x03\x04broken'))), /解析失败/);
  await assert.rejects(readDocument(await write('d.zip', zip({ 'readme.txt': 'hi' }))), /不支持这种文件格式/);
  await assert.rejects(readDocument(path.join(root, 'none.pdf'), -1), /offset/);
});

function fixture(store) {
  const processes = new Processes(); let wx;
  const tools = new Tools(store, new Skills(store.dir, processes), processes, undefined, { getWechat: () => wx });
  return { tools, processes, setWechat: value => { wx = value; } };
}
const reply = content => ({ role: 'assistant', content });
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('received files reach the model: caption runs after saving and later turns can find them', async t => {
  const root = await setup(t); const inbox = path.join(root, '收件箱');
  const store = new Store(path.join(root, 'private')); store.saveConfig({ workspace: root, imageDirectory: inbox });
  const { tools, processes, setWechat } = fixture(store); t.after(() => processes.stopAll());
  const seen = [];
  const agent = new Agent(store, { async complete(messages) {
    seen.push(messages);
    if (seen.length === 1) return call('read_document', { path: messages.at(-1).content.match(/^(.*file-.*\.txt)$/m)[1] });
    return reply('已读取：季度营收');
  } }, tools);
  const sent = [], key = Buffer.from('0123456789abcdef');
  const wx = new Wechat(store, agent, { fetcher: async (url, request) => {
    if (url.includes('sendmessage')) { sent.push(JSON.parse(request.body).msg.item_list[0].text_item.text); return Response.json({}); }
    const cipher = createCipheriv('aes-128-ecb', key, null);
    return new Response(Buffer.concat([cipher.update('季度营收'), cipher.final()]));
  } });
  setWechat(wx); wx.account = { userId: 'owner', botId: 'bot', token: 'token' }; wx.status = 'connected';
  await wx.ingest({ message_id: 'm', from_user_id: 'owner', context_token: 'ctx', item_list: [
    { type: 1, text_item: { text: '帮我总结这份文件' } },
    { type: 4, file_item: { file_name: '报告.txt', media: { full_url: 'https://novac2c.cdn.weixin.qq.com/x', aes_key: Buffer.from(key.toString('hex')).toString('base64') } } }] });
  await wx.drain();
  assert.equal(sent[0], '收到指令，正在处理。'); assert.match(sent[1], /已保存 1/); assert.equal(sent.at(-1), '已读取：季度营收');
  assert.match(seen[0].at(-1).content, /帮我总结这份文件/); assert.match(seen[0].at(-1).content, /报告\.txt/);
  assert.match(seen[1].at(-1).content, /季度营收/);
  assert.equal(wx.state.received.length, 1);
  assert.match(await agent.system(), /微信最近收到的文件/);
  assert.equal(JSON.stringify(store.history).includes('base64'), false);
});

test('a media message without a caption still never calls the model', async t => {
  const root = await setup(t); const store = new Store(path.join(root, 'private')); store.saveConfig({ workspace: root, imageDirectory: path.join(root, 'in') });
  let calls = 0; const { tools, processes } = fixture(store); t.after(() => processes.stopAll());
  const agent = new Agent(store, { async complete() { calls++; return reply('x'); } }, tools);
  const wx = new Wechat(store, agent, { fetcher: async (url) => url.includes('sendmessage') ? Response.json({}) : new Response(png) });
  wx.account = { userId: 'owner', botId: 'bot', token: 'token' }; wx.status = 'connected';
  await wx.ingest({ message_id: 'p', from_user_id: 'owner', context_token: 'ctx', item_list: [{ type: 2, image_item: { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/x' } } }] });
  await wx.drain();
  assert.equal(calls, 0); assert.equal(wx.state.received.length, 1);
});

test('vision is opt-in; images reach the model for one turn and stay out of stored history', async t => {
  const root = await setup(t); const store = new Store(path.join(root, 'private')); store.saveConfig({ workspace: root });
  await fs.writeFile(path.join(root, 'a.png'), png); await fs.writeFile(path.join(root, 'a.heic'), 'x');
  const { tools, processes } = fixture(store); t.after(() => processes.stopAll());
  assert.equal(tools.definitions().some(t => t.function.name === 'view_image'), false);
  await assert.rejects(tools.execute('view_image', { path: 'a.png' }, { signal: new AbortController().signal, images: [] }), /看图/);
  store.saveConfig({ vision: true });
  assert.equal(tools.definitions().some(t => t.function.name === 'view_image'), true);
  await assert.rejects(tools.execute('view_image', { path: 'a.heic' }, { signal: new AbortController().signal, images: [] }), /图片/);
  let step = 0, attached;
  const agent = new Agent(store, { async complete(messages) {
    if (!step++) return call('view_image', { path: 'a.png' });
    attached = messages.at(-1); return reply('这是一张图');
  } }, tools);
  await agent.run('看看这张图');
  assert.equal(attached.role, 'user'); assert.equal(attached.content[1].type, 'image_url');
  assert.match(attached.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(JSON.stringify(store.history).includes('base64,'), false);
  assert.equal((await fs.readFile(path.join(store.dir, 'history.json'), 'utf8')).includes('iVBOR'), false);
});
