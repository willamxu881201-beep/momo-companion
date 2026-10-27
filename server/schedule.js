// Rotating timetable: the school labels each school day D1..Dn (n = 6 for
// MoMo's school) and the label advances one step per school day, skipping
// weekends and holidays. Mom tells us one known day ("10-27 is D3"); any
// day she sets by hand also becomes an anchor, so a surprise reset by the
// school is a one-line fix in the parent console.
//
// cfg = {
//   cycleLength: 6,
//   anchorDate: '2026-10-27', anchorDay: 3,
//   schoolWeekdays: [1, 2, 3, 4, 5],          // 0 = Sunday
//   overrides: { '2026-12-25': 'off', '2026-11-02': 4 },
// }

import { addDays, parseDate, weekday } from './dates.js';

function overrideFor(cfg, date) {
  const v = cfg.overrides?.[date];
  return v === undefined ? undefined : v;
}

function isSchoolDay(cfg, date) {
  const o = overrideFor(cfg, date);
  if (o === 'off') return false;
  if (typeof o === 'number') return true;
  return cfg.schoolWeekdays.includes(weekday(date));
}

function anchors(cfg) {
  const list = [];
  if (cfg.anchorDate && cfg.anchorDay) list.push({ date: cfg.anchorDate, day: cfg.anchorDay });
  for (const [date, v] of Object.entries(cfg.overrides || {})) {
    if (typeof v === 'number') list.push({ date, day: v });
  }
  return list.sort((a, b) => parseDate(a.date) - parseDate(b.date));
}

function wrap(day, n) {
  return ((((day - 1) % n) + n) % n) + 1;
}

// Returns the cycle day number (1..n) for a date, or null when there is no school.
export function cycleDay(cfg, date) {
  const n = cfg.cycleLength || 6;
  const o = overrideFor(cfg, date);
  if (o === 'off') return null;
  if (typeof o === 'number') return wrap(o, n);
  if (!isSchoolDay(cfg, date)) return null;

  const list = anchors(cfg);
  if (list.length === 0) return null;
  const t = parseDate(date);

  // Count forward from the latest anchor on or before the date.
  let before = null;
  for (const a of list) if (parseDate(a.date) <= t) before = a;
  if (before) {
    let steps = 0;
    for (let d = addDays(before.date, 1); parseDate(d) <= t; d = addDays(d, 1)) {
      if (isSchoolDay(cfg, d)) steps += 1;
    }
    // An anchor that itself falls on a non-school day still counts as its label.
    return wrap(before.day + steps, n);
  }

  // Date precedes every anchor: count backward from the earliest one.
  const after = list[0];
  let steps = 0;
  for (let d = date; parseDate(d) < parseDate(after.date); d = addDays(d, 1)) {
    if (isSchoolDay(cfg, d)) steps += 1;
  }
  return wrap(after.day - steps, n);
}

// courses: { 1: [{ name, note }], 2: [...] }
export function describeDay(cfg, courses, date) {
  const day = cycleDay(cfg, date);
  return {
    date,
    day,
    label: day ? `D${day}` : '休息',
    courses: day ? courses[day] || [] : [],
  };
}

// The next date after `date` (exclusive) that has school, within `limit` days.
export function nextSchoolDay(cfg, date, limit = 30) {
  for (let i = 1; i <= limit; i += 1) {
    const d = addDays(date, i);
    if (cycleDay(cfg, d)) return d;
  }
  return null;
}
