// Where the companion is: the scene behind her follows what MoMo is doing. A task whose
// time it is — or one MoMo said she has started — takes her to its place: the study for
// homework and reading, the piano room for practice, the gym or the park for exercise,
// MoMo's bedroom for getting ready for bed. Free time is wherever MoMo likes best, and
// quiet time is her bedroom at night. In the evening each scene has its night picture.

import { timeToMinutes } from './dates.js';

export const SCENES = {
  courtyard: { name: '庭院', free: true },
  sky: { name: '云海', free: true },
  plain: { name: '彩色的', free: true }, // no picture: the girl's and pet's colours, as before
  study: { name: '书房' },
  piano: { name: '琴房' },
  gym: { name: '运动馆' },
  outdoor: { name: '公园' },
  bedroom: { name: '卧室' },
};
export const FREE_SCENES = Object.keys(SCENES).filter((k) => SCENES[k].free);

// A task's place, by what it is called (first match wins). Mom can set one per task
// in 管理 instead ('none': stay where she is).
const PLACES = [
  ['piano', /琴|piano|乐器|音乐|吉他|二胡|笛子|唱歌/i],
  ['outdoor', /跑步|散步|骑车|自行车|踢球|足球|篮球|羽毛球|网球|户外|公园|遛|滑板|轮滑|游泳|爬山|放风筝/],
  ['gym', /跳绳|运动|锻炼|体能|体育|健身|仰卧|俯卧|拉伸|瑜伽|舞|体操|武术|跆拳道|平板支撑|开合跳/],
  ['bedroom', /睡|起床|洗漱|刷牙|洗澡|洗脸|整理书包|收拾书包|穿衣/],
  ['study', /作业|写|练习|语文|数学|英语|英文|华文|科学|阅读|读|看书|背|复习|预习|默写|听写|口算|单词|课文|日记|作文|字帖|书法|画|学/],
];

export function placeOf(task) {
  if (task.scene === 'none') return null;
  if (task.scene && SCENES[task.scene]) return task.scene;
  for (const [scene, re] of PLACES) if (re.test(task.title)) return scene;
  return null;
}

const OPEN = ['todo', 'redo'];
const GRACE = 30; // minutes a task's time stays on after its planned end, if it isn't done

// What MoMo is doing now: the task she started and hasn't finished (for its planned
// time and a while after), or else the task whose time it is (until half an hour after
// its planned end, unless it's done) — the one that started last, if two overlap. null
// in free time. { task, scene, started, from: ms }.
export function activityOf(tasks, now) {
  const started = tasks
    .filter((t) => t.started_at && OPEN.includes(t.status) && now.ms - t.started_at < (t.minutes + 30) * 60000)
    .sort((a, b) => b.started_at - a.started_at)[0];
  if (started) return { task: started, scene: placeOf(started), started: true, from: started.started_at };
  let found = null;
  for (const t of tasks) {
    const s = timeToMinutes(t.time);
    if (s === null || !OPEN.includes(t.status)) continue;
    if (now.minutes >= s && now.minutes < s + t.minutes + GRACE && (!found || s >= found.s)) found = { t, s };
  }
  if (!found) return null;
  return { task: found.t, scene: placeOf(found.t), started: false, from: now.ms - (now.minutes - found.s) * 60000 };
}

const isNight = (minutes) => minutes >= 19 * 60 || minutes < 6 * 60 + 30;

// The scene to show: { key, night }. key 'plain' shows no picture.
export function sceneOf({ activity, quiet, free, minutes }) {
  if (quiet) return { key: 'bedroom', night: true };
  const key = (activity && activity.scene) || (SCENES[free] && SCENES[free].free ? free : 'courtyard');
  return { key, night: key !== 'plain' && isNight(minutes) };
}
