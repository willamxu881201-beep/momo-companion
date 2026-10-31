import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleDay, describeDay, nextSchoolDay } from '../server/schedule.js';
import { nowIn, dateZh } from '../server/dates.js';

// 2026-10-26 is a Monday.
const base = {
  cycleLength: 6,
  anchorDate: '2026-10-26',
  anchorDay: 1,
  schoolWeekdays: [1, 2, 3, 4, 5],
  overrides: {},
};

test('advances one step per school day and wraps after D6', () => {
  const got = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03'].map(
    (d) => cycleDay(base, d),
  );
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 1]);
});

test('weekends have no cycle day', () => {
  assert.equal(cycleDay(base, '2026-10-31'), null);
  assert.equal(cycleDay(base, '2026-11-01'), null);
});

test('a holiday is skipped without consuming a cycle day', () => {
  const cfg = { ...base, overrides: { '2026-10-28': 'off' } };
  assert.equal(cycleDay(cfg, '2026-10-28'), null);
  assert.equal(cycleDay(cfg, '2026-10-29'), 3);
  assert.equal(cycleDay(cfg, '2026-11-03'), 6);
});

test('a hand-set day becomes the new anchor for later days', () => {
  const cfg = { ...base, overrides: { '2026-11-02': 4 } };
  assert.equal(cycleDay(cfg, '2026-10-30'), 5);
  assert.equal(cycleDay(cfg, '2026-11-02'), 4);
  assert.equal(cycleDay(cfg, '2026-11-03'), 5);
});

test('dates before the anchor count backward', () => {
  assert.equal(cycleDay(base, '2026-10-23'), 6); // Friday before
  assert.equal(cycleDay(base, '2026-10-19'), 2);
});

test('a Saturday make-up class can be set by hand', () => {
  const cfg = { ...base, overrides: { '2026-10-31': 6 } };
  assert.equal(cycleDay(cfg, '2026-10-31'), 6);
  assert.equal(cycleDay(cfg, '2026-11-02'), 1);
});

test('describeDay returns label and courses', () => {
  const courses = { 3: [{ name: '数学' }, { name: '体育', note: '穿运动鞋' }] };
  assert.deepEqual(describeDay(base, courses, '2026-10-28'), {
    date: '2026-10-28',
    day: 3,
    label: 'D3',
    courses: [{ name: '数学' }, { name: '体育', note: '穿运动鞋' }],
  });
  assert.equal(describeDay(base, courses, '2026-10-31').label, '休息');
});

test('nextSchoolDay skips the weekend', () => {
  assert.equal(nextSchoolDay(base, '2026-10-30'), '2026-11-02');
});

test('no anchor means no cycle', () => {
  assert.equal(cycleDay({ ...base, anchorDate: null, anchorDay: null }, '2026-10-28'), null);
});

test('nowIn reads the wall clock in the family time zone', () => {
  const at = new Date('2026-10-27T17:30:00Z');
  assert.deepEqual(nowIn('Asia/Kuala_Lumpur', at), { date: '2026-10-28', time: '01:30', minutes: 90 });
  assert.equal(dateZh('2026-10-28'), '10月28日 周三');
});
