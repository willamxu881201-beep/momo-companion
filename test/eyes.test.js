import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// What the vision model "sees", set per test.
let picture = null;
let view = null;
const files = new Files(store, dataDir);
const eyes = new Eyes({ family, store, files, hub, momHub, config, read: async () => picture, look: async () => view });
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

test('a page of homework is kept in mind for helping, and only images and PDFs are read', async () => {
  picture = {
    kind: 'homework_page', summary: '数学练习', unsure: '', timetable: null, homework: [],
    page: { subject: '数学', problems: [{ n: '三', text: '6箱粉笔，每箱48盒，一共多少盒？', done: '' }], hint: '想想乘法' },
  };
  const r = await (await kid.post('/api/upload', jpeg(), 'image/jpeg')).json();
  assert.match(r.line, /一共 1 道题/);
  assert.equal(eyes.currentHomework().problems[0].n, '三');
  assert.equal(brain.extras().homework.subject, '数学');
  assert.equal((await kid.post('/api/upload', 'hello', 'text/plain')).status, 415);
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

test('old pictures are cleared out after a week', () => {
  const count = () => readdirSync(join(dataDir, 'files'), { recursive: true }).filter((f) => /\.(jpg|png)$/.test(f)).length;
  const n = count();
  assert.ok(n > 0);
  assert.equal(files.sweep(), 0, 'nothing is a week old yet');
  assert.equal(files.sweep(Date.now() + 8 * 86400000), n);
  assert.equal(count(), 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
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
