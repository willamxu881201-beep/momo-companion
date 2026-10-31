import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect, extract } from '../server/extract.js';
import { excerpts, pieces } from '../server/docs.js';

// The sample documents are made-up school papers (test/fixtures/make.py made them).
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const installed = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
async function read(name, options) {
  const buf = fixture(name);
  const kind = detect(buf, name);
  assert.ok(kind, `${name} is recognised`);
  return { kind, ...(await extract(buf, kind, options)) };
}

test('Word: paragraphs in order (a bold word mid-sentence included), the table as rows, tabs and line breaks kept', async () => {
  const r = await read('notice.docx');
  assert.equal(r.kind.type, 'docx');
  assert.match(r.text, /^关于举行秋季运动会的通知\n各位家长：\n我校定于2026年11月6日（星期五）在学校操场举行秋季运动会，请家长提醒孩子做好准备。\n/);
  assert.match(r.text, /\n项目 \| 时间 \| 地点\n50米跑 \| 8:30 \| 跑道\n跳绳 \| 9:30 \| 篮球场\n接力赛 \| 14:00 \| 跑道\n/);
  assert.match(r.text, /报名截止：\t11月3日\n三年级甲班 王老师$/);
  assert.deepEqual(r.pictures, []);
});

test("Excel: every sheet but hidden ones, dates and percentages as shown, a formula's value, figures for each column of numbers", async () => {
  const r = await read('scores.xlsx');
  assert.equal(r.parts, 2);
  assert.doesNotMatch(r.text, /隐藏/);
  assert.match(r.text, /^【工作表：期中成绩】\n科目 \| 分数 \| 满分 \| 得分率 \| 考试日期\n语文 \| 92 \| 100 \| 92% \| 2026-10-20\n/);
  assert.match(r.text, /\n平均 \| 88.5 \| 100\n/);
  assert.match(r.text, /（统计）分数：4 个，合计 354，平均 88.5，最高 95（英语），最低 79（科学）\n/, 'the 平均 row is not counted');
  assert.doesNotMatch(r.text, /满分：/, 'a column that is all the same says nothing');
  assert.match(r.text, /【工作表：每周阅读】\n日期 \| 书名 \| 分钟\n2026-10-19 \| 夏洛的网 \| 30\n/, 'a date in a Chinese format');
});

test('PowerPoint: slides in their order, with the speaker notes', async () => {
  const r = await read('lesson.pptx');
  assert.equal(r.parts, 3);
  assert.equal(
    r.text,
    '【第1张幻灯片】\n认识分数\n三年级数学 第七单元\n【第2张幻灯片】\n什么是几分之一\n把一个物体平均分成几份，每份是它的几分之一。\n分数线上面是分子，下面是分母。\n备注：让学生动手折纸，体会平均分。\n【第3张幻灯片】\n练一练\n一个蛋糕平均分成4份，每份是这个蛋糕的几分之几？',
  );
});

test('PDF: the text page by page; a scan has hardly any', { skip: !installed('pdftotext') && 'pdftotext is not installed here' }, async () => {
  const r = await read('notice.pdf');
  assert.equal(r.kind.type, 'pdf');
  assert.match(r.text, /^【第1页】\n关于举行秋季运动会的通知/);
  assert.match(r.text, /接力赛 {2}14:00 {2}跑道/, 'columns stay apart');
  const scan = await read('scan.pdf');
  assert.equal(scan.text.replace(/【[^】]*】|\s/g, ''), '');
});

test('old Word and Excel files are read through LibreOffice', { skip: !installed('soffice') && 'LibreOffice is not installed here' }, async () => {
  const doc = await read('notice.doc');
  assert.equal(doc.kind.type, 'doc');
  assert.match(doc.text, /^关于举行秋季运动会的通知\n/);
  assert.match(doc.text, /50米跑 \| 8:30 \| 跑道/);
  const xls = await read('scores.xls');
  assert.equal(xls.kind.type, 'xls');
  assert.match(xls.text, /【工作表：期中成绩】\n科目 \| 分数 \| 满分 \| 得分率 \| 考试日期\n语文 \| 92 \| 100 \| 92% \| 2026-10-20\n/);
  assert.equal(xls.parts, 2);
});

test('an old PowerPoint file goes to LibreOffice and comes back as a new one; without LibreOffice, it says so', async () => {
  // An old-format file is recognised by what is inside, whatever its name.
  const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(200), Buffer.from('PowerPoint Document', 'utf16le'), Buffer.alloc(200)]);
  const kind = detect(ole, 'lesson');
  assert.equal(kind.type, 'ppt');
  const calls = [];
  const soffice = (cmd, args, opts, done) => {
    calls.push(args.slice(args.indexOf('--convert-to'), args.indexOf('--convert-to') + 2));
    writeFileSync(join(args[args.indexOf('--outdir') + 1], 'in.pptx'), fixture('lesson.pptx'));
    done(null, '', '');
  };
  const r = await extract(ole, kind, { run: soffice });
  assert.deepEqual(calls, [['--convert-to', 'pptx']]);
  assert.match(r.text, /^【第1张幻灯片】\n认识分数/);
  const missing = (cmd, args, opts, done) => done(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
  await assert.rejects(extract(ole, kind, { run: missing }), (err) => err.missing === true);
});

test('text files: UTF-8 or GBK, a CSV as a table; a file is known by its content', async () => {
  const csv = await read('scores_gbk.csv');
  assert.equal(csv.text, '科目 | 分数\n语文 | 92\n数学 | 88');
  const story = await read('story.txt');
  assert.match(story.text, /^四季的森林\n\n春天\n小燕子从南方飞回来/);
  assert.equal(detect(Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 8]), 'notes.txt'), null, 'not text, whatever the name');
  assert.equal(detect(fixture('notice.doc'), 'renamed.bin').type, 'doc');
  assert.equal(detect(Buffer.from('{\\rtf1\\ansi 你好}'), 'a.rtf').type, 'rtf');
  assert.equal(detect(Buffer.from('PK\x03\x04 not really a zip')), null);
  assert.equal(detect(Buffer.from('ffd8ffe000104a464946', 'hex')).type, 'image');
});

test('a long document: the parts that answer a question, or pieces from all through it', () => {
  const story = fixture('story.txt').toString('utf8');
  assert.ok(pieces(story).length > 5);
  const squirrel = excerpts(story, '松鼠藏了多少松果？', 1500);
  assert.equal(squirrel.whole, false);
  assert.ok(squirrel.text.length <= 1500, 'within the budget');
  assert.match(squirrel.text, /一百零八颗/);
  assert.match(excerpts(story, '松鼠藏了多少松果？', 640).text, /一百零八颗/, 'room for one piece: the right one');
  assert.match(excerpts(story, '青蛙数到了多少颗星星', 640).text, /三百六十五颗/);
  const all = excerpts(story, '这个故事讲了什么', 2500).text;
  for (const season of ['春天', '夏天', '秋天', '冬天']) assert.match(all, new RegExp(season), `the whole story: ${season}`);
  assert.equal(excerpts('一句话的文件。', '随便', 1500).whole, true);
});

test("a sheet's later pieces start with its header row", () => {
  const rows = ['【工作表：成绩】', '姓名 | 语文 | 数学', ...Array.from({ length: 300 }, (_, i) => `学生${i + 1} | ${60 + (i % 40)} | ${70 + (i % 30)}`)];
  const found = excerpts(rows.join('\n'), '学生257的数学考了多少', 1500).text;
  assert.match(found, /^（工作表：成绩）姓名 \| 语文 \| 数学\n/);
  assert.match(found, /学生257 \| 76 \| 86/);
});

// A little zip, for e-books made up on the spot.
function zipOf(files) {
  const { deflateRawSync, crc32 } = require_zlib;
  const local = [];
  const central = [];
  let at = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const stored = name === 'mimetype';
    const packed = stored ? data : deflateRawSync(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(Buffer.byteLength(name), 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(Buffer.byteLength(name), 28);
    entry.writeUInt32LE(at, 42);
    local.push(head, Buffer.from(name), packed);
    central.push(entry, Buffer.from(name));
    at += 30 + Buffer.byteLength(name) + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...local, dir, end]);
}
const require_zlib = await import('node:zlib');

test('web pages, e-books, OpenDocument and any text are read; what is not read is named roughly', async (t) => {
  const page = Buffer.from('<!doctype html><html><head><style>p{}</style><script>var x=1</script></head><body><h1>春游通知</h1><p>11月8日去植物园，&nbsp;带水和帽子。</p><table><tr><td>集合</td><td>7:30</td></tr></table></body></html>');
  const html = await read_(page, '通知.htm');
  assert.equal(html.kind.type, 'html');
  assert.equal(html.text, '春游通知\n11月8日去植物园， 带水和帽子。\n集合 | 7:30');

  const book = zipOf({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
    'OEBPS/book.opf': '<package><manifest><item id="c2" href="two.xhtml"/><item id="c1" href="one.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
    'OEBPS/one.xhtml': '<html><body><h2>第一章</h2><p>小狐狸叫阿橙。</p></body></html>',
    'OEBPS/two.xhtml': '<html><body><h2>第二章</h2><p>阿橙学会了游泳。</p></body></html>',
  });
  const epub = await read_(book, 'story.epub');
  assert.equal(epub.kind.type, 'epub');
  assert.equal(epub.text, '【第1章】\n第一章\n小狐狸叫阿橙。\n【第2章】\n第二章\n阿橙学会了游泳。');

  const subs = await read_(Buffer.from('1\n00:00:01,000 --> 00:00:03,000\n你好，沫沫\n'), '动画片.srt');
  assert.equal(subs.kind.type, 'text', 'text, whatever its name');

  const { roughly } = await import('../server/extract.js');
  assert.equal(roughly(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]), 'song.mp3'), '音频');
  assert.equal(roughly(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(20)]), 'clip.mp4'), '视频');
  assert.equal(roughly(Buffer.from('Rar!\x1a\x07\x00'), 'a.rar'), '压缩包');
  assert.equal(roughly(Buffer.from([1, 2, 3]), 'x.bin'), '文件');

  if (!installed('soffice')) return t.skip('LibreOffice is not installed here (OpenDocument)');
  const odt = await read('notice.odt');
  assert.equal(odt.kind.type, 'odt');
  assert.match(odt.text, /^关于举行秋季运动会的通知\n/);
});

async function read_(buf, name) {
  const kind = detect(buf, name);
  assert.ok(kind, `${name} is recognised`);
  return { kind, ...(await extract(buf, kind)) };
}

test('a long document is read all through: notes on every section, then the whole from them', async () => {
  const { readDocument } = await import('../server/docs.js');
  const text = Array.from({ length: 6 }, (_, i) => `【第${i + 1}页】\n${`第${i + 1}页的内容。`.repeat(1200)}`).join('\n');
  const calls = [];
  const chat = async ({ model, messages, json }) => {
    calls.push({ model, json: Boolean(json), text: messages[0].content });
    if (!json) return { content: `要点${calls.length}` };
    return { content: JSON.stringify({ kind: 'document', summary: '长文件', doc: { title: '一本长书', gist: '很长。', points: [], dates: [], todo: [] } }) };
  };
  const r = await readDocument({ apiKey: 'k', model: 'pro', noteModel: 'lite', text, name: '长书.pdf', today: '2026-10-28', tomorrow: '2026-10-29', chat });
  const notes = calls.filter((c) => !c.json);
  assert.ok(notes.length >= 4, `${notes.length} sections`);
  assert.ok(notes.every((c) => c.model === 'lite'));
  assert.match(notes[0].text, /^下面是一个长文件《长书.pdf》的第 1\/\d+ 部分/);
  const last = calls.at(-1);
  assert.equal(last.model, 'pro');
  assert.match(last.text, /【每一部分的要点】\n第 1 部分：要点\d+\n第 2 部分：/);
  assert.equal(r.sections, notes.length);
  assert.equal(r.doc.title, '一本长书');
});

test('searching all the files: the one that holds the words, with the bit around them', async () => {
  const { searchFiles } = await import('../server/docs.js');
  const story = fixture('story.txt').toString('utf8');
  const texts = { 1: story, 2: '关于举行秋季运动会的通知\n当天穿运动服和运动鞋。\n接力赛 | 14:00 | 跑道', 3: '数学练习\n6箱粉笔，每箱48盒。' };
  const files = [1, 2, 3].map((id) => ({ id, name: { 1: '故事.txt', 2: '通知.docx', 3: '练习.pdf' }[id], result: null }));
  const index = new Map();
  const hits = searchFiles(files, '松鼠把松果藏在哪里', { index, textOf: (id) => texts[id] });
  assert.equal(hits[0].id, 1);
  assert.match(hits[0].snippet, /松果/);
  assert.equal(searchFiles(files, '接力赛几点', { index, textOf: (id) => texts[id] })[0].id, 2);
  assert.equal(searchFiles(files, '通知', { index, textOf: (id) => texts[id] })[0].id, 2, 'by its name too');
  assert.deepEqual(searchFiles(files, '恐龙', { index, textOf: (id) => texts[id] }), []);
  assert.equal(index.size, 3, 'each file cut up once');
});
