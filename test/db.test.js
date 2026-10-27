import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, templateApplies } from '../server/db.js';

test('settings merge with defaults', () => {
  const s = openDb(':memory:');
  assert.equal(s.getSetting('profile').kidName, 'MoMo');
  s.setSetting('profile', { girl: 'a' });
  assert.deepEqual(s.getSetting('profile'), { kidName: 'MoMo', girl: 'a', pet: '3' });
});

test('courses round-trip in order with notes', () => {
  const s = openDb(':memory:');
  s.setCourses(3, [{ name: '数学' }, { name: '体育', note: '穿运动鞋' }]);
  s.setCourses(3, [{ name: '英语' }, { name: '体育', note: '穿运动鞋' }]);
  assert.deepEqual(s.getCourses(), { 3: [{ name: '英语' }, { name: '体育', note: '穿运动鞋' }] });
});

test('overrides become part of the cycle config', () => {
  const s = openDb(':memory:');
  s.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 1 });
  s.setOverride('2026-12-25', 'off', '圣诞');
  s.setOverride('2026-11-02', 4);
  const cfg = s.cycleConfig();
  assert.equal(cfg.cycleLength, 6);
  assert.deepEqual(cfg.overrides, { '2026-12-25': 'off', '2026-11-02': 4 });
  s.setOverride('2026-11-02', null);
  assert.deepEqual(s.cycleConfig().overrides, { '2026-12-25': 'off' });
});

test('templates expand into one instance per day, idempotently', () => {
  const s = openDb(':memory:');
  s.saveTemplate({ title: '写作业', icon: '📝', time: '16:00', minutes: 40, days: 'school' });
  s.saveTemplate({ title: '练琴', icon: '🎹', time: '17:00', days: 'every' });
  s.saveTemplate({ title: '游泳', time: '10:00', days: '6' });
  s.ensureInstances('2026-10-28', true); // Wednesday, school
  s.ensureInstances('2026-10-28', true);
  assert.deepEqual(
    s.listInstances('2026-10-28').map((t) => t.title),
    ['写作业', '练琴'],
  );
  s.ensureInstances('2026-10-31', false); // Saturday
  assert.deepEqual(
    s.listInstances('2026-10-31').map((t) => t.title),
    ['游泳', '练琴'],
  );
});

test('task status flow and affinity ledger', () => {
  const s = openDb(':memory:');
  s.saveTemplate({ title: '写作业', time: '16:00', days: 'every' });
  s.ensureInstances('2026-10-28', true);
  const [t] = s.listInstances('2026-10-28');
  s.setInstanceStatus(t.id, 'waiting', 1000);
  assert.equal(s.listWaiting().length, 1);
  s.setInstanceStatus(t.id, 'confirmed', 2000);
  assert.equal(s.getInstance(t.id).confirmed_at, 2000);
  s.addAffinity('2026-10-28', 10, 'task', String(t.id));
  s.addAffinity('2026-10-28', 1, 'chat');
  assert.equal(s.affinityTotal(), 11);
  assert.equal(s.affinitySum('2026-10-28', 'chat'), 1);
  assert.ok(s.hasAffinity('2026-10-28', 'task', String(t.id)));
  assert.ok(!s.hasAffinity('2026-10-28', 'task', '999'));
});

test('alarms, pairing codes and usage', () => {
  const s = openDb(':memory:');
  s.addAlarm('2026-10-29', '07:00', '起床');
  assert.equal(s.pendingAlarms().length, 1);
  assert.equal(s.cancelAlarms(), 1);
  assert.equal(s.pendingAlarms().length, 0);
  s.addPairingCode('h1', Date.now() + 60000);
  assert.equal(s.takePairingCode('h1'), true);
  assert.equal(s.takePairingCode('h1'), false);
  s.addUsage('2026-10-28', 'chat');
  s.addUsage('2026-10-28', 'chat', 2);
  assert.equal(s.usage('2026-10-28', 'chat'), 3);
});

test('templateApplies covers every rule', () => {
  assert.equal(templateApplies('every', 0, false), true);
  assert.equal(templateApplies('school', 3, true), true);
  assert.equal(templateApplies('school', 3, false), false);
  assert.equal(templateApplies('offday', 6, false), true);
  assert.equal(templateApplies('1,3,5', 3, true), true);
  assert.equal(templateApplies('1,3,5', 2, true), false);
});
