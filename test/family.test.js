import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { Family, POINTS } from '../server/family.js';
import { splitReply } from '../server/brain.js';

// 2026-10-28 08:05 in Kuala Lumpur (UTC+8) = 00:05 UTC.
function setup(iso = '2026-10-28T00:05:00Z') {
  const store = openDb(':memory:');
  store.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 1 });
  store.setCourses(3, [{ name: '数学' }, { name: '体育', note: '穿运动鞋' }]);
  store.setCourses(4, [{ name: '英语' }]);
  store.saveTemplate({ title: '写作业', icon: '📝', time: '16:00', minutes: 40, days: 'school' });
  let at = new Date(iso);
  const family = new Family(store, { clock: () => at });
  return { store, family, setClock: (s) => (at = new Date(s)) };
}

test('snapshot knows today, tomorrow and the tasks', () => {
  const { family } = setup();
  const s = family.snapshot();
  assert.equal(s.now.date, '2026-10-28');
  assert.equal(s.today.label, 'D3');
  assert.equal(s.tomorrow.label, 'D4');
  assert.equal(s.nextSchool, null);
  assert.deepEqual(s.tasks.map((t) => t.title), ['写作业']);
  const facts = family.factsText(s);
  assert.match(facts, /今天 10月28日 周三：D3，课程依次是 数学、体育（穿运动鞋）/);
  assert.match(facts, /明天 10月29日 周四：D4/);
});

test('on Friday the facts include the next school day', () => {
  const { family } = setup('2026-10-30T02:00:00Z');
  const s = family.snapshot();
  assert.equal(s.tomorrow.label, '休息');
  assert.equal(s.nextSchool.date, '2026-11-02');
  assert.match(family.factsText(s), /下一个上学日 11月2日 周一：D6/);
});

test('points arrive only when Mom confirms, once, with an on-time bonus', () => {
  const { family, store, setClock } = setup();
  const [t] = family.snapshot().tasks;
  setClock('2026-10-28T08:30:00Z'); // 16:30 local, inside 16:00 + 40 min + 15
  assert.equal(family.markDone(t.id).task.status, 'waiting');
  assert.equal(store.affinityTotal(), 0);
  family.review(t.id, true);
  family.review(t.id, true);
  assert.equal(store.affinityTotal(), POINTS.task + POINTS.ontime);
});

test('a late task gets no bonus, and redo resets it', () => {
  const { family, store, setClock } = setup();
  const [t] = family.snapshot().tasks;
  setClock('2026-10-28T12:00:00Z'); // 20:00 local
  family.markDone(t.id);
  family.review(t.id, false);
  assert.equal(store.getInstance(t.id).status, 'redo');
  family.markDone(t.id);
  family.review(t.id, true);
  assert.equal(store.affinityTotal(), POINTS.task);
});

test('alarms roll to tomorrow when the time has passed', () => {
  const { family } = setup(); // 08:05 local
  assert.equal(family.setAlarm('7:00', '起床').alarm.date, '2026-10-29');
  assert.equal(family.setAlarm('09:30', '出门').alarm.date, '2026-10-28');
  assert.equal(family.setAlarm('25:00', 'x').ok, false);
  assert.equal(family.cancelAlarms().cancelled, 2);
});

test('chat points: morning check-in once, chat capped per day', () => {
  const { family, store } = setup(); // 08:05 is in the morning check-in window
  const got = Array.from({ length: 8 }, () => family.awardChat());
  assert.equal(got[0], POINTS.checkin + POINTS.chat);
  assert.equal(store.affinityTotal(), POINTS.checkin + POINTS.chatDailyCap * POINTS.chat);
});

test('splitReply separates the pet action and cleans the text', () => {
  assert.deepEqual(splitReply('明天是 D4，有英语哦！😊【小九晃晃尾巴】'), {
    reply: '明天是 D4，有英语哦！',
    petAction: '小九晃晃尾巴',
  });
  assert.deepEqual(splitReply('**好的**'), { reply: '好的', petAction: null });
});
