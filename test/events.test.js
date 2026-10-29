import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { Family } from '../server/family.js';
import { Scheduler, inQuiet } from '../server/events.js';

function setup(iso) {
  const store = openDb(':memory:');
  store.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 1 });
  store.saveTemplate({ title: '写作业', time: '16:00', minutes: 40, days: 'school' });
  let at = new Date(iso);
  const family = new Family(store, { clock: () => at });
  const sent = [];
  const hub = { size: 1, send: (e) => sent.push(e) };
  return { store, family, hub, sent, scheduler: new Scheduler(family, hub), setClock: (s) => (at = new Date(s)) };
}

test('quiet hours wrap around midnight', () => {
  const q = { start: '21:30', end: '06:30' };
  assert.equal(inQuiet(22 * 60, q), true);
  assert.equal(inQuiet(5 * 60, q), true);
  assert.equal(inQuiet(12 * 60, q), false);
});

test('a task is reminded once at its time, then nudged once', () => {
  const { scheduler, sent, setClock } = setup('2026-10-28T07:59:00Z'); // 15:59 local
  scheduler.tick();
  assert.equal(sent.length, 0);
  setClock('2026-10-28T08:01:00Z');
  scheduler.tick();
  scheduler.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].line, /写作业时间到/);
  setClock('2026-10-28T08:16:00Z');
  scheduler.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].gentle, true);
});

test('no reminder for a task already marked done', () => {
  const { scheduler, sent, family, setClock } = setup('2026-10-28T07:30:00Z');
  const [t] = family.snapshot().tasks;
  family.markDone(t.id);
  setClock('2026-10-28T08:01:00Z');
  scheduler.tick();
  assert.equal(sent.length, 0);
});

test('reminders wait while no tablet is connected', () => {
  const { scheduler, sent, hub, setClock } = setup('2026-10-28T08:01:00Z');
  hub.size = 0;
  scheduler.tick();
  hub.size = 1;
  setClock('2026-10-28T08:03:00Z');
  scheduler.tick();
  assert.equal(sent.length, 1);
});

test('alarms fire once; stale ones are dropped silently', () => {
  const { scheduler, sent, family, store, setClock } = setup('2026-10-27T22:00:00Z'); // 06:00 local
  family.setAlarm('06:30', '起床');
  store.addAlarm('2026-10-27', '05:00', '旧的'); // yesterday, never delivered
  setClock('2026-10-27T22:31:00Z');
  scheduler.tick();
  scheduler.tick();
  assert.deepEqual(sent.map((e) => e.alarm.label), ['起床']);
  assert.equal(store.pendingAlarms().length, 0);
});

test('the record and the messages are kept 90 days', (t) => {
  const { scheduler, family, store } = setup('2026-10-28T08:30:00Z');
  const real = Date.now();
  t.mock.method(Date, 'now', () => real - 91 * 86400000);
  family.log('kid', 'done', '很久以前的事');
  store.addMessage('kid', 'mom', '很久以前的话');
  t.mock.restoreAll();
  family.log('kid', 'done', '今天的事');
  store.addMessage('kid', 'mom', '今天的话');
  scheduler.tick();
  assert.deepEqual(store.listEvents('2026-10-28').map((e) => e.text), ['今天的事']);
  assert.deepEqual(store.recentMessages('mom', 0).map((m) => m.text), ['今天的话']);
});
