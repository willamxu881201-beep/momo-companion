import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { Family } from '../server/family.js';
import { Coach } from '../server/coach.js';
import { Scheduler } from '../server/events.js';
import { placeOf } from '../server/activity.js';

// A family on Wednesday 28 October 2026, in Kuala Lumpur time; `at('16:00')` sets the clock.
function setup({ templates = [{ title: '写作业', time: '16:00', minutes: 40, days: 'every' }], say = null } = {}) {
  const store = openDb(':memory:');
  store.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 1 });
  store.setSetting('profile', { kidName: '沫沫', girl: 'b', pet: '3' });
  store.setCourses(3, [{ name: '数学' }, { name: '体育', note: '穿运动鞋' }]);
  for (const t of templates) store.saveTemplate(t);
  let clock = new Date('2026-10-28T12:00:00+08:00');
  const family = new Family(store, { clock: () => clock });
  const sent = [];
  const hub = { size: 1, send: (e) => sent.push(e) };
  const coach = new Coach({ family, hub, say });
  const at = (hhmm) => (clock = new Date(`2026-10-28T${hhmm}:00+08:00`));
  const scene = () => {
    const s = family.snapshot();
    return s.activity ? s.activity.scene : null;
  };
  return { store, family, hub, sent, coach, at, scene };
}

// Ticks once a minute from `from` to `to` (HH:MM), noting what she says when.
async function run(c, from, to) {
  const said = {};
  for (let m = toMin(from); m <= toMin(to); m += 1) {
    c.at(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    const key = await c.coach.tick();
    if (key) said[`${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`] = key;
  }
  return said;
}
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

test('where a task happens: by its name, or where Mom says', () => {
  const at = (title, scene) => placeOf({ title, scene });
  assert.equal(at('写作业'), 'study');
  assert.equal(at('阅读 20 分钟'), 'study');
  assert.equal(at('练琴'), 'piano');
  assert.equal(at('跳绳 500 下'), 'gym');
  assert.equal(at('去公园跑步'), 'outdoor');
  assert.equal(at('整理书包'), 'bedroom');
  assert.equal(at('帮妈妈洗碗'), null, 'nowhere in particular: she stays where she is');
  assert.equal(at('帮妈妈洗碗', 'study'), 'study');
  assert.equal(at('写作业', 'none'), null);
});

test("the scene follows the task whose time it is, then free time; Mom's page and the tablet hear of each change", async () => {
  const c = setup({ templates: [{ title: '写作业', time: '16:00', minutes: 40, days: 'every' }, { title: '练琴', time: '19:30', minutes: 20, days: 'every' }] });
  c.hub.size = 0; // the tablet is off: nothing is said, but the scene still changes
  const scenes = [];
  for (const t of ['15:59', '16:00', '16:50', '17:10', '19:30', '22:00']) {
    c.at(t);
    await c.coach.tick();
    const s = c.family.snapshot();
    scenes.push(`${t} ${s.activity ? s.activity.scene : 'free'}`);
  }
  assert.deepEqual(scenes, ['15:59 free', '16:00 study', '16:50 study', '17:10 free', '19:30 piano', '22:00 free']);
  assert.equal(c.sent.filter((e) => e.type === 'refresh').length, 4, 'to the study, back to free time, the piano room, the bedroom at quiet time');
});

test('she speaks up through a task: before it, at its time, a nudge, check-ins, time up, over time, and what is next', async () => {
  const c = setup();
  const said = await run(c, '15:50', '16:57');
  assert.deepEqual(said, { '15:55': 'soon', '16:00': 'start', '16:15': 'nudge', '16:18': 'mid15', '16:30': 'mid30', '16:40': 'end', '16:55': 'over' });
  const lines = c.sent.filter((e) => e.proactive);
  assert.match(lines[0].line, /^沫沫，再过五分钟就是写作业啦/);
  const late = setup(); // the tablet opened a minute before
  await run(late, '15:59', '15:59');
  assert.match(late.sent.find((e) => e.proactive).line, /^沫沫，马上就是写作业啦/);
  assert.equal(lines[1].type, 'reminder');
  assert.equal(lines[1].line, '沫沫，写作业时间到！我们去书房吧，先把要用的书本拿出来。');
  assert.equal(lines[2].gentle, true);
  assert.match(lines[3].line, /坐直/);
  assert.match(c.store.listEvents('2026-10-28')[0].text, /提醒了沫沫：写作业/, 'the start is in the record');

  // Done: she says what's next — here, that everything is.
  c.at('16:58');
  c.family.markDone(c.family.snapshot().tasks[0].id);
  assert.equal(await c.coach.tick(), 'next');
  assert.match(c.sent.at(-1).line, /写作业做完啦，真棒！今天的任务都做完啦/);
  assert.equal(await c.coach.tick(), null, 'each thing once');
});

test('a task MoMo starts herself: no "time\'s up", and the check-ins count from when she began', async () => {
  const c = setup();
  c.at('15:50');
  const r = c.family.startTask(c.family.snapshot().tasks[0].id);
  assert.equal(r.ok, true);
  assert.equal(c.scene(), 'study');
  const said = await run(c, '15:50', '16:45');
  assert.deepEqual(said, { '16:05': 'mid15', '16:20': 'mid30', '16:30': 'end', '16:45': 'over' });
});

test("she doesn't talk over MoMo, with the tablet off, or in quiet hours", async () => {
  const c = setup();
  c.at('16:00');
  c.coach.heard();
  assert.equal(await c.coach.tick(), null, 'MoMo just spoke');
  c.at('16:01');
  c.hub.size = 0;
  assert.equal(await c.coach.tick(), null, 'nobody to hear it');
  c.hub.size = 1;
  assert.equal(await c.coach.tick(), 'start');
  const q = setup({ templates: [{ title: '看书', time: '22:00', minutes: 20, days: 'every' }] });
  assert.deepEqual(await run(q, '21:50', '22:30'), {}, 'quiet hours (21:30–6:30)');
});

test('her own words from the model, told what is going on; set lines when it fails', async () => {
  const asked = [];
  const c = setup({ say: async (what) => (asked.push(what), '沫沫，作业时间到啦，今天先做数学吧！') });
  c.store.addOneOffTask('2026-10-28', { title: '数学练习册', minutes: 20 });
  c.at('16:00');
  assert.equal(await c.coach.tick(), 'start');
  assert.equal(c.sent.at(-1).line, '沫沫，作业时间到啦，今天先做数学吧！');
  assert.match(asked[0], /「写作业」的时间到了，你们一起到书房去/);
  assert.match(asked[0], /今天要做的作业有：数学练习册/);

  const d = setup({ say: async () => { throw new Error('model down'); } });
  d.at('16:00');
  await d.coach.tick();
  assert.equal(d.sent.at(-1).line, '沫沫，写作业时间到！我们去书房吧，先把要用的书本拿出来。');
});

test('the day: good morning with the lessons, untimed homework now and then, and bedtime', async () => {
  const c = setup({ templates: [] });
  c.store.addOneOffTask('2026-10-28', { title: '数学练习册', minutes: 20 });
  c.at('07:00');
  assert.equal(await c.coach.tick(), 'morning');
  assert.match(c.sent.at(-1).line, /^早上好，沫沫！今天是周三，D3，第一节是数学，记得穿运动鞋。/);
  const said = await run(c, '15:00', '17:20');
  assert.deepEqual(said, { '15:30': 'pending', '16:15': 'pending', '17:00': 'pending' }, 'every 45 minutes, three at most');
  assert.match(c.sent.filter((e) => e.proactive)[1].line, /数学练习册还没做哦/);
  c.at('21:15');
  assert.equal(await c.coach.tick(), 'bedtime');
  assert.match(c.sent.at(-1).line, /还有一刻钟就该睡觉啦/);
  c.at('07:10');
  assert.equal(await c.coach.tick(), null, 'good morning once a day');
});

test('the scheduler lets the coach speak, and waits for it', async () => {
  const c = setup();
  c.at('16:00');
  const scheduler = new Scheduler(c.family, c.hub, { coach: c.coach });
  assert.equal(await scheduler.tick(), 'start');
});
