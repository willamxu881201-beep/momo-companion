import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { Family } from '../server/family.js';
import { Auth, PARENT_COOKIE } from '../server/auth.js';
import { Brain } from '../server/brain.js';
import { Files } from '../server/files.js';
import { Eyes } from '../server/eyes.js';
import { Post } from '../server/post.js';
import { createHandler } from '../server/http.js';

const webDir = mkdtempSync(join(tmpdir(), 'momo-web-'));
const dataDir = mkdtempSync(join(tmpdir(), 'momo-data-'));
writeFileSync(join(webDir, 'kid.html'), '<!doctype html><title>kid</title>');
after(() => {
  server.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

let at = new Date('2026-10-28T08:05:00Z'); // 16:05 in Kuala Lumpur
const store = openDb(':memory:');
store.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 1 });
store.setCourses(1, [{ name: '数学' }]);
const family = new Family(store, { clock: () => at });
const auth = new Auth(store, { parentPassword: 'test-password' });
const config = { publicUrl: '', parentPassword: 'test-password', arkApiKey: 'k', visionModel: 'v', limits: { chatPerDay: 80, asrPerDay: 150, ttsCharsPerDay: 20000, visionPerDay: 60, momChatPerDay: 80 } };

// Pages that are "open": each records what was pushed to it.
const fakeHub = () => ({ size: 1, got: [], send(e) { this.got.push(e); } });
const hub = fakeHub();
const momHub = fakeHub();
family.onEvent = () => momHub.send({ type: 'event' });

// What the models "see" and "read", set per test.
let picture = null;
let view = null;
let reading = null;
let readArgs = null;
let ocrCalls = 0;
let slow = 0; // ms the document model takes
const files = new Files(store, dataDir);
const eyes = new Eyes({
  family, store, files, hub, momHub, config,
  read: async () => picture,
  look: async () => view,
  readDoc: async (args) => {
    readArgs = args;
    if (slow) await new Promise((r) => setTimeout(r, slow));
    if (reading instanceof Error) throw reading;
    return structuredClone(reading);
  },
  ocr: async () => {
    ocrCalls += 1;
    return '家长会通知\n时间：11月12日 晚上7点';
  },
});
const post = new Post({ family, store, hub, momHub });
const brain = new Brain(family, { apiKey: 'k' });
brain.attach({ eyes, post, hub, momHub });

const server = createServer(createHandler({ config, store, family, brain, auth, hub, momHub, files, eyes, post, webDir }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const kidCookie = (await fetch(`${base}/?k=${auth.kidKey()}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const momCookie = `${PARENT_COOKIE}=${auth.login('127.0.0.1', 'test-password').token}`;
const as = (cookie) => ({
  post: (path, body, type = 'application/json') =>
    fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body }),
  get: (path) => fetch(base + path, { headers: { Cookie: cookie } }),
});
const kid = as(kidCookie);
const mom = as(momCookie);
const jpeg = (n = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n)]);

test("a photo of the teacher's homework list becomes today's tasks, and Mom can undo it", async () => {
  picture = {
    kind: 'homework_list', summary: '今天的作业', unsure: '', timetable: null, page: null,
    homework: [
      { subject: '语文', title: '抄写第9课生字', detail: '每个3遍', due: '2026-10-29', minutes: 5 },
      { subject: '数学', title: '练习册36-37页', detail: '', due: '', minutes: 20 },
    ],
  };
  const res = await kid.post('/api/upload?name=hw.jpg', jpeg(), 'image/jpeg');
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.kind, 'homework_list');
  assert.deepEqual(r.changes, ['语文：抄写第9课生字', '数学：练习册36-37页']);
  assert.match(r.line, /作业记下来/);
  const tasks = family.tasks('2026-10-28');
  const hw = tasks.find((t) => t.title === '语文：抄写第9课生字');
  assert.equal(hw.note, '每个3遍，10月29日 周四交');
  assert.equal(hw.minutes, 10, 'at least ten minutes');
  assert.ok(r.state.tasks.some((t) => t.title === '数学：练习册36-37页'), 'the tablet gets the new list');

  // The same list again adds nothing.
  const again = await (await kid.post('/api/upload', jpeg(), 'image/jpeg')).json();
  assert.deepEqual(again.changes, []);

  const feed = await (await mom.get('/api/parent/feed')).json();
  const ev = feed.events.find((e) => e.kind === 'homework_list' && e.undo);
  assert.match(ev.text, /MoMo发来作业清单，加了 2 件作业/);
  assert.ok(ev.fileId);
  const undo = await mom.post(`/api/parent/undo/${ev.id}`, {});
  assert.equal(undo.status, 200);
  assert.ok(!family.tasks('2026-10-28').some((t) => t.title.startsWith('语文：')), 'the added tasks are gone');
  assert.equal((await mom.post(`/api/parent/undo/${ev.id}`, {})).status, 404, 'only once');
});

test("Mom's photo of a timetable replaces the courses; undo puts the old ones back", async () => {
  picture = {
    kind: 'timetable', summary: '课程表', unsure: '', homework: [], page: null,
    timetable: { cycle: 6, days: [{ day: 1, courses: [{ name: '华文', note: '' }, { name: '英文', note: '' }] }, { day: 2, courses: [{ name: '科学', note: '带实验本' }] }] },
  };
  const r = await (await mom.post('/api/upload', jpeg(), 'image/png')).json();
  assert.equal(r.kind, 'timetable');
  assert.deepEqual(store.getCourses(), { 1: [{ name: '华文' }, { name: '英文' }], 2: [{ name: '科学', note: '带实验本' }] });
  assert.match(r.line, /课程表已经更新好了，一共 2 天/);
  assert.ok(hub.got.some((e) => e.type === 'refresh'), 'the tablet reloads');
  await mom.post(`/api/parent/undo/${r.undo}`, {});
  assert.deepEqual(store.getCourses(), { 1: [{ name: '数学' }] });

  // A timetable with a different cycle: every day's D number moves, so Mom is asked to
  // check which day today is; undo puts the old cycle back as it was.
  store.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 6 });
  picture = { ...picture, timetable: { cycle: 5, days: [{ day: 1, courses: [{ name: '华文', note: '' }] }] } };
  const five = await (await kid.post('/api/upload', jpeg(), 'image/jpeg')).json();
  assert.match(five.line, /轮换的天数变了，我请妈妈核对/);
  assert.deepEqual([store.getSetting('cycle').cycleLength, store.getSetting('cycle').anchorDay], [5, null]);
  const logged = store.getEvent(five.undo);
  assert.match(logged.text, /一轮从 6 天变成 5 天，请到「管理 → 课表」核对今天是 D 几/);
  await mom.post(`/api/parent/undo/${five.undo}`, {});
  assert.deepEqual([store.getSetting('cycle').cycleLength, store.getSetting('cycle').anchorDay], [6, 6]);
  store.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 1 });
});

test('a page of homework is kept in mind for helping', async () => {
  picture = {
    kind: 'homework_page', summary: '数学练习', unsure: '', timetable: null, homework: [],
    page: { subject: '数学', problems: [{ n: '三', text: '6箱粉笔，每箱48盒，一共多少盒？', done: '' }], hint: '想想乘法' },
  };
  const r = await (await kid.post('/api/upload', jpeg(), 'image/jpeg')).json();
  assert.match(r.line, /一共 1 道题/);
  assert.equal(eyes.currentHomework().problems[0].n, '三');
  assert.equal(brain.extras().homework.subject, '数学');
});

test('Mom looks in: the tablet is asked, takes a picture, and Mom hears what it shows', async () => {
  hub.got.length = 0;
  momHub.got.length = 0;
  const ask = await (await mom.post('/api/parent/check', { what: 'posture' })).json();
  assert.equal(ask.ok, true);
  const asked = hub.got.find((e) => e.type === 'check');
  assert.equal(asked.what, 'posture');
  assert.match(asked.line, /看看你的坐姿/);

  view = { seen: true, doing: '趴着写作业', piano: false, posture: { ok: false, issues: ['头太低'], tip: '抬起头，坐直一点哦' }, summary: 'MoMo趴在桌上写作业' };
  assert.equal((await kid.post(`/api/checks/${asked.id}`, { image: jpeg().toString('base64') })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const result = momHub.got.find((e) => e.type === 'check');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'MoMo趴在桌上写作业');
  assert.ok(result.fileId);
  assert.deepEqual(hub.got.find((e) => e.type === 'say'), { type: 'say', line: '抬起头，坐直一点哦', mood: 'happy' }, 'a gentle word to MoMo');
  assert.ok(hub.got.some((e) => e.type === 'refresh'), "MoMo's page refreshes...");
  const looked = (await (await kid.get('/api/state')).json()).looked;
  assert.equal(looked.n, 1, '...and shows that Mom looked once today');
  assert.match(looked.last, /^\d\d:\d\d$/);

  // Only Mom sees the picture.
  const pic = await mom.get(`/api/parent/files/${result.fileId}`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/jpeg');
  assert.equal((await kid.get(`/api/parent/files/${result.fileId}`)).status, 401);
  assert.equal((await kid.post(`/api/checks/${asked.id}`, { image: 'x' })).status, 404, 'a check is answered once');
});

test("a check-in with the camera refused tells Mom so; with no tablet on, Mom hears that at once", async () => {
  hub.got.length = 0;
  momHub.got.length = 0;
  const ask = await (await mom.post('/api/parent/check', { what: 'piano' })).json();
  const asked = hub.got.find((e) => e.type === 'check');
  assert.equal(asked.listen, true, 'the piano check listens too');
  await kid.post(`/api/checks/${ask.id}`, { error: 'camera' });
  assert.match(momHub.got.find((e) => e.type === 'check').text, /摄像头没打开/);
  const logged = store.listEvents(family.now().date).find((e) => e.kind === 'check');
  assert.match(logged.text, /^看看在不在练琴：平板的摄像头没打开/, 'the record shows it too, for when Mom comes back');

  hub.size = 0;
  const none = await (await mom.post('/api/parent/check', { what: 'look' })).json();
  assert.equal(none.ok, false);
  assert.match(none.text, /平板现在没打开/);
  hub.size = 1;
});

test("Mom's words reach MoMo once the tablet is on, and stop once it has said them", async () => {
  hub.got.length = 0;
  hub.size = 0;
  const r = await (await mom.post('/api/parent/tell', { text: '晚饭前把钢琴练了' })).json();
  assert.equal(r.ok, true);
  assert.equal(hub.got.length, 0, 'nothing to send to yet');
  hub.size = 1;
  assert.equal(post.offer({ fresh: true }), 1);
  const msg = hub.got.find((e) => e.type === 'message');
  assert.equal(msg.line, 'MoMo，妈妈让我告诉你：晚饭前把钢琴练了');
  assert.equal(post.offer(), 0, 'not again straight away');
  assert.equal((await kid.post(`/api/messages/${msg.id}/heard`, {})).status, 200);
  assert.equal(post.offer({ fresh: true }), 0, 'said, so done');
  assert.deepEqual(brain.extras().notes.map((m) => m.text), ['晚饭前把钢琴练了'], 'she knows what she passed on');

  at = new Date('2026-10-28T14:00:00Z'); // 22:00, quiet time
  post.toKid('明天早点起');
  assert.equal(post.offer({ fresh: true }), 0, 'held until morning');
  at = new Date('2026-10-28T08:05:00Z');
});

test("MoMo's words for Mom go to Mom's page, and the companion's tools for Mom work", async () => {
  momHub.got.length = 0;
  // Her own words go to Mom as she said them, even if the model retold them oddly.
  const told = brain.runTool({ name: 'tell_mom', args: { text: '小九想吃饺子' } }, null, '帮我告诉妈妈我想吃饺子');
  assert.equal(told.action.type, 'told-mom');
  assert.equal(momHub.got.find((e) => e.type === 'message').line, 'MoMo让我告诉你：“我想吃饺子”');
  // A question about homework is not a message for Mom, whatever the model thought.
  momHub.got.length = 0;
  assert.equal(brain.runTool({ name: 'tell_mom', args: { text: '第三题怎么做' } }, null, '第三题怎么做呀').text, null);
  assert.equal(momHub.got.length, 0);

  const added = brain.runMomTool({ name: 'add_task', args: { title: '背古诗', time: '19:00', minutes: 15 } });
  assert.equal(added.action.type, 'task-added');
  const task = family.tasks('2026-10-28').find((t) => t.title === '背古诗');
  assert.equal(task.time, '19:00');
  family.markDone(task.id);
  const reviewed = brain.runMomTool({ name: 'review_task', args: { task_id: task.id, approve: true } });
  assert.match(reviewed.text, /已确认：背古诗，好感度加/);
  const day = brain.runMomTool({ name: 'get_day', args: { date: '2026-10-28' } });
  assert.match(day.text, /背古诗（19:00）：你确认过了/);
  const events = brain.runMomTool({ name: 'get_events', args: { date: '2026-10-28' } });
  assert.match(events.text, /MoMo说「背古诗」做完了/);
  assert.match(events.text, /妈妈确认了「背古诗」/);
});

test("the tablet's snapshots are cleared out after a week; what people send is kept", () => {
  const kinds = () => store.db.prepare('SELECT who, COUNT(*) AS n FROM files GROUP BY who ORDER BY who').all().map((r) => `${r.who} ${r.n}`);
  const disk = () => readdirSync(join(dataDir, 'files'), { recursive: true }).filter((f) => /\.\w+$/.test(f)).length;
  const before = kinds();
  assert.ok(before.some((k) => k.startsWith('tablet')) && before.some((k) => k.startsWith('kid')));
  const files0 = disk();
  assert.equal(files.sweep(), 0, 'nothing is a week old yet');
  const snapshots = Number(before.find((k) => k.startsWith('tablet')).split(' ')[1]);
  assert.equal(files.sweep(Date.now() + 8 * 86400000), snapshots);
  assert.deepEqual(kinds(), before.filter((k) => !k.startsWith('tablet')));
  assert.equal(disk(), files0 - snapshots);
  assert.equal(files.sweep(Date.now() + 3650 * 86400000), 0, 'ten years on, still there');
});

test('a PDF is read page by page (with pdftoppm)', async (t) => {
  const { pdfPages } = await import('../server/files.js');
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R 5 0 R]/Count 3>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
      '5 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );
  let pages;
  try {
    pages = await pdfPages(pdf);
  } catch (err) {
    if (err.missing) return t.skip('pdftoppm is not installed here');
    throw err;
  }
  assert.equal(pages.length, 2, 'the first two pages');
  assert.deepEqual([...pages[0].subarray(0, 2)], [0xff, 0xd8]);
});

test("homework Mom sends is told to MoMo on the tablet", async () => {
  hub.got.length = 0;
  picture = {
    kind: 'homework_list', summary: '作业', unsure: '', timetable: null, page: null,
    homework: [{ subject: '英语', title: '背单词', detail: 'Unit 5', due: '', minutes: 15 }],
  };
  const r = await (await mom.post('/api/upload', jpeg(), 'image/jpeg')).json();
  assert.deepEqual(r.changes, ['英语：背单词']);
  assert.match(hub.got.find((e) => e.type === 'say').line, /^MoMo，妈妈把作业发给我啦：英语：背单词。/);
});

// ---- documents ---------------------------------------------------------------------

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const installed = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const notice = {
  kind: 'document', summary: '运动会通知', unsure: '', timetable: null, homework: [], page: null, partial: false,
  doc: { title: '秋季运动会通知', type: '通知', gist: '11月6日在学校操场开秋季运动会。', points: ['穿运动服和运动鞋'], dates: [{ date: '2026-11-06', what: '秋季运动会' }], todo: ['准备水壶和毛巾'], forKid: '学校要开运动会啦！' },
};

test("Mom's Word notice is read and summed up; she can open its card, save it, and ask about it", async () => {
  reading = notice;
  const res = await mom.post('/api/upload?name=运动会通知.docx', fixture('notice.docx'), DOCX);
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.kind, 'document');
  assert.match(readArgs.text, /\n50米跑 \| 8:30 \| 跑道\n/, 'the model read the text, table and all');
  assert.equal(readArgs.name, '运动会通知.docx');
  assert.equal(r.line, '我看完了《秋季运动会通知》。11月6日在学校操场开秋季运动会。里面的日子：11月6日秋季运动会。想知道里面的什么，直接问我。');

  const e = (await (await mom.get('/api/parent/feed')).json()).events.find((x) => x.kind === 'document');
  assert.equal(e.text, '妈妈发来Word文件《秋季运动会通知》：11月6日在学校操场开秋季运动会。');
  assert.equal(e.doc, true);
  const card = await (await mom.get(`/api/parent/docs/${e.fileId}`)).json();
  assert.deepEqual([card.name, card.type, card.doc.title, card.doc.todo[0]], ['运动会通知.docx', 'docx', '秋季运动会通知', '准备水壶和毛巾']);
  const saved = await mom.get(`/api/parent/files/${e.fileId}?download=1`);
  assert.equal(saved.headers.get('content-type'), DOCX);
  assert.match(saved.headers.get('content-disposition'), /^attachment; filename="file.docx"; filename\*=UTF-8''%E8%BF%90%E5%8A%A8/);
  assert.equal((await kid.get(`/api/parent/docs/${e.fileId}`)).status, 401, "Mom's documents are hers");

  // A short document goes to the model whole when Mom asks about it.
  const read = brain.runMomTool({ name: 'read_document', args: { doc_id: e.fileId, question: '运动会要穿什么' } });
  assert.match(read.text, /^《运动会通知.docx》的全文：\n关于举行秋季运动会的通知\n/);
  assert.match(read.text, /当天穿运动服和运动鞋/);
  assert.equal(eyes.documents()[0].id, e.fileId);
  assert.equal(brain.runMomTool({ name: 'read_document', args: { doc_id: 99999, question: '什么' } }).text, '没有这个文件，可能被妈妈删掉了');
  assert.equal(eyes.currentDocument(), null, "Mom's document isn't on MoMo's companion's mind");
});

test("MoMo's slides: what she asks about them is answered from the parts that bear on it", async () => {
  reading = { ...notice, doc: { ...notice.doc, title: '认识分数', gist: '讲什么是几分之一。', dates: [], forKid: '这是讲分数的课件。' } };
  const r = await (await kid.post('/api/upload?name=lesson.pptx', fixture('lesson.pptx'), 'application/octet-stream')).json();
  assert.equal(r.line, '我看完啦！这是讲分数的课件。有不懂的地方，可以问我哦。');
  assert.equal(eyes.currentDocument().name, 'lesson.pptx', 'known by what is inside, not the type it came with');
  const { document } = brain.extras('分子在哪里呀');
  assert.equal(document.title, '认识分数');
  assert.match(document.excerpt, /分数线上面是分子/);
});

test('a timetable in an Excel file changes the courses, like a photo of one', async () => {
  reading = { kind: 'timetable', summary: '课程表', unsure: '', homework: [], page: null, timetable: { cycle: 6, days: [{ day: 1, courses: [{ name: '美术', note: '' }] }] } };
  const before = store.getCourses();
  const r = await (await mom.post('/api/upload?name=课表.xlsx', fixture('scores.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).json();
  assert.equal(r.kind, 'timetable');
  assert.deepEqual(store.getCourses()[1], [{ name: '美术' }]);
  await mom.post(`/api/parent/undo/${r.undo}`, {});
  assert.deepEqual(store.getCourses(), before);
});

test('a scanned PDF is read as pictures: one model call a page, then summed up', { skip: !(installed('pdftotext') && installed('pdftoppm')) && 'poppler is not installed here' }, async () => {
  picture = { kind: 'other', summary: '一张通知', unsure: '', timetable: null, homework: [], page: null };
  reading = { ...notice, doc: { ...notice.doc, title: '家长会通知', gist: '11月12日晚上7点开家长会。', dates: [{ date: '2026-11-12', what: '家长会' }] } };
  ocrCalls = 0;
  const r = await (await mom.post('/api/upload?name=scan.pdf', fixture('scan.pdf'), 'application/pdf')).json();
  assert.equal(ocrCalls, 1);
  assert.equal(readArgs.text, '【第1页】\n家长会通知\n时间：11月12日 晚上7点');
  assert.match(r.line, /^我看完了《家长会通知》。11月12日晚上7点开家长会。里面的日子：11月12日家长会。/);
});

test("any file is kept: one with nothing to read, one she can't read, one the model failed on", async () => {
  const status = (id) => store.getFile(id).status;
  const blank = await (await mom.post('/api/upload?name=空白.txt', Buffer.from('   \n\n    \n'), 'text/plain')).json();
  assert.equal(blank.line, '收到《空白.txt》，我帮你存好了。不过它里面没有能读的文字。');
  assert.equal(status(blank.fileId), 'stored');
  const zip = await (await mom.post('/api/upload?name=照片.zip', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(40)]), 'application/zip')).json();
  assert.equal(zip.line, '收到《照片.zip》，我帮你存好了。不过它是压缩包，我还读不了。');
  const song = await (await kid.post('/api/upload?name=小星星.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)]), 'audio/mpeg')).json();
  assert.match(song.line, /存好了。不过它是音频，我还读不了。/);
  const feed = (await (await mom.get('/api/parent/feed')).json()).events;
  assert.ok(feed.some((e) => e.kind === 'file' && e.text === 'MoMo发来《小星星.mp3》（是音频，我还读不了，先存着）'));
  // The model failing: kept too, marked to be read again.
  reading = new Error('the model is down');
  const failed = await (await mom.post('/api/upload?name=story.txt', fixture('story.txt'), 'text/plain')).json();
  assert.equal(failed.line, '我这会儿没读成这个文件，先帮你存好了，等一下可以再让我读一次。');
  assert.equal(status(failed.fileId), 'failed');
  // ...and when it's read again, it is told on Mom's page.
  reading = { ...notice, doc: { ...notice.doc, title: '四季的森林', gist: '一个关于森林四季的故事。', dates: [], type: '故事' } };
  momHub.got.length = 0;
  await mom.post(`/api/parent/files/${failed.fileId}/reread`, {});
  for (let i = 0; i < 50 && status(failed.fileId) !== 'read'; i += 1) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(status(failed.fileId), 'read');
  assert.match(momHub.got.find((e) => e.type === 'say').line, /^我看完了《四季的森林》/);
});

// ---- the library -----------------------------------------------------------------------

test("Mom's library: every file kept, newest first, found by what is in it; she shares, saves and deletes", async () => {
  const lib = await (await mom.get('/api/parent/library')).json();
  assert.ok(lib.n >= 8 && lib.files.length >= 8);
  assert.ok(lib.files.every((f, i) => i === 0 || f.at <= lib.files[i - 1].at), 'newest first');
  assert.ok(lib.files.every((f) => f.who !== 'tablet'), "the tablet's snapshots aren't in it");

  const found = (await (await mom.get(`/api/parent/library?q=${encodeURIComponent('接力赛')}`)).json()).files;
  assert.equal(found[0].name, '运动会通知.docx');
  assert.match(found[0].snippet, /接力赛/);
  const byName = (await (await mom.get(`/api/parent/library?q=${encodeURIComponent('小星星')}`)).json()).files;
  assert.equal(byName[0].name, '小星星.mp3', 'a file that was never read is found by its name');

  // A school notice of Mom's: the companion may use it with MoMo; she can say no.
  const notice = found[0];
  assert.equal(notice.shared, true);
  const card = await (await mom.post(`/api/parent/files/${notice.id}/share`, { kid: false })).json();
  assert.equal(card.shared, false);
  assert.equal((await mom.post(`/api/parent/files/${byName[0].id}/share`, { kid: false })).status, 400, "MoMo's own files are hers to ask about");

  // Saving it: sent a piece at a time, under its own name.
  const saved = await mom.get(`/api/parent/files/${notice.id}?download=1`);
  assert.equal(saved.headers.get('content-length'), String(fixture('notice.docx').length));
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), fixture('notice.docx'));

  // Deleting a file takes it off the disk, out of the list and out of her reach.
  const before = lib.n;
  const gone = await (await mom.post(`/api/parent/files/${byName[0].id}/delete`, {})).json();
  assert.equal(gone.n, before - 1);
  assert.equal((await mom.get(`/api/parent/files/${byName[0].id}`)).status, 404);
  assert.equal((await mom.post(`/api/parent/files/${byName[0].id}/delete`, {})).status, 404);
});

test('the companion looks things up herself: Mom in every file, MoMo in her own and the shared ones', async () => {
  // Mom's work paper: hers alone.
  reading = { ...notice, doc: { ...notice.doc, title: '项目计划', type: '工作文件', gist: '下季度的项目计划。', dates: [] } };
  const plan = await (await mom.post('/api/upload?name=计划.txt', Buffer.from('项目计划\n第三季度要完成新版官网，预算十二万。'), 'text/plain')).json();
  assert.equal(store.getFile(plan.fileId).shared, 0);

  const momFound = brain.runMomTool({ name: 'search_files', args: { query: '官网预算' } }).text;
  assert.match(momFound, new RegExp(`^\\[doc=${plan.fileId}\\] .*妈妈发来的《计划.txt》：下季度的项目计划。`));
  assert.match(momFound, /相关的一段：.*预算十二万/);
  assert.equal(brain.runMomTool({ name: 'search_files', args: { query: '恐龙化石' } }).text, '没找到相关的文件');

  // Before the model is asked, the words of the files that may answer Mom are put in
  // front of it: the right file, and only when something matches.
  const prompt = brain.promptForMom('我发过的文件里，哪个提到了接力赛？几点？');
  assert.match(prompt, /^【可能和妈妈这句话有关的文件原文】/m);
  assert.match(prompt, /\[doc=\d+\]《运动会通知\.docx》的全文：\n[^]*接力赛 \| 14:00/);
  assert.equal(prompt.match(/^\[doc=\d+\]《/gm).length, 1, 'only the file that matches');
  assert.doesNotMatch(brain.promptForMom('你好呀，今天辛苦了'), /^【可能和妈妈这句话有关的文件原文】/m);

  const kidAsks = (query, said) => brain.runTool({ name: 'look_up_files', args: { query } }, null, said).text;
  assert.equal(kidAsks('官网预算', '妈妈的官网预算是多少'), '在发给你的文件里没找到这个', "Mom's work stays hers");
  assert.match(kidAsks('分子', '课件里分子在哪里'), /^在《lesson.pptx》里找到：\n.*分数线上面是分子/s);
});

test('a file that takes long to read: the upload is answered at once, and the result comes when it is done', async () => {
  config.readWaitMs = 30;
  slow = 200;
  reading = { ...notice, doc: { ...notice.doc, title: '一本长书', gist: '很长的书。', dates: [] } };
  momHub.got.length = 0;
  const r = await (await mom.post('/api/upload?name=长书.txt', fixture('story.txt'), 'text/plain')).json();
  assert.equal(r.pending, true);
  assert.equal(r.line, '收到啦，我先帮你存好了。这个有点长，我慢慢读，读完马上告诉你。');
  assert.equal(store.getFile(r.fileId).status, 'reading');
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(store.getFile(r.fileId).status, 'read');
  assert.match(momHub.got.find((e) => e.type === 'say').line, /^我看完了《一本长书》/);
  config.readWaitMs = undefined;
  slow = 0;
});

test('a file bigger than the server takes is turned away, and nothing of it is left', async () => {
  config.limits.uploadBytes = 1000;
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
  const disk = readdirSync(join(dataDir, 'files'), { recursive: true }).length;
  const res = await mom.post('/api/upload?name=big.bin', Buffer.alloc(5000, 1), 'application/octet-stream');
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /文件太大了/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, rows);
  assert.equal(readdirSync(join(dataDir, 'files'), { recursive: true }).length, disk);
  delete config.limits.uploadBytes;
});

