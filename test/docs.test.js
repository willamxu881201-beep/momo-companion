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
