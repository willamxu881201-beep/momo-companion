// A throwaway database for the browser checks: a D1–D6 timetable, two daily tasks,
// 290 points (just short of the pet's next stage), and quiet hours well away from now,
// so a check run late at night doesn't find everyone asleep.
import { openDb } from '../../server/db.js';
import { nowIn } from '../../server/dates.js';

const store = openDb(process.argv[2]);
const hhmm = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, '0')}`;
const now = nowIn(process.env.MOMO_TZ || 'Asia/Kuala_Lumpur').minutes;

store.setSetting('cycle', { cycleLength: 6, anchorDate: '2026-10-26', anchorDay: 1, schoolWeekdays: [1, 2, 3, 4, 5] });
const COURSES = [
  ['华文', '数学', '英文'],
  ['数学', '美术：带彩笔', '音乐'],
  ['数学', '体育：穿运动鞋', '英语'],
  ['华文', '科学', '英文'],
  ['数学', '华文', '道德'],
  ['英文', '体育：穿运动鞋', '华文'],
];
COURSES.forEach((day, i) => store.setCourses(i + 1, day.map((c) => {
  const [name, note] = c.split('：');
  return note ? { name, note } : { name };
})));
store.saveTemplate({ title: '写作业', icon: '📝', time: '16:00', minutes: 40, days: 'every' });
store.saveTemplate({ title: '练琴', icon: '🎹', time: '19:30', minutes: 20, days: 'every' });
store.setSetting('profile', { kidName: '沫沫', girl: 'b', pet: '3' });
store.setSetting('quiet', { start: hhmm(now + 180), end: hhmm(now + 240) });
store.addAffinity('2026-10-27', 290, 'seed');
