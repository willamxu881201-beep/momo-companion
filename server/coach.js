// The companion speaks up on her own as MoMo's day goes, instead of waiting to be
// talked to. For each task: a few minutes before it, at its time (as the scene changes
// to its place), a nudge if it hasn't begun a quarter of an hour later, a word or two
// while it goes on (sit up straight, rest the eyes, a sip of water, loose wrists),
// when its time is up, once more if it runs well over, and what comes next once it is
// done. For the day: good morning with today's lessons, the homework still to do now
// and then in free time, and the bedtime routine before quiet hours.
// Each is said once, at most one every few minutes, only while the tablet is on and
// never in quiet hours; the tablet waits until MoMo isn't talking. The words come from
// the character model (brain.speakUp), so they sound like her and fit the moment,
// and from set lines when it can't. The scene change is pushed to both pages here too.

import { SCENES, sceneOf } from './activity.js';
import { dateZh, timeToMinutes } from './dates.js';
import { inQuiet } from './events.js';

const GAP_MS = 3 * 60000; // between two things she says on her own
const HEARD_MS = 60000; // after MoMo said something, the companion lets her talk
const PENDING_MS = 45 * 60000; // between two reminders of untimed homework
// When she checks in during a task (minutes after it began), by where it happens.
const CHECK_INS = { study: [15, 30, 45], piano: [10, 20], gym: [10], outdoor: [10], bedroom: [], other: [20] };
const CHECK_KIND = { study: ['posture', 'eyes', 'water'], piano: ['relax', 'slow'], gym: ['water'], outdoor: ['water'], other: ['cheer'] };

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const open = (t) => t.status === 'todo' || t.status === 'redo';
const said = (t, key) => (t.coached || '').split(',').includes(key);

// Set lines, for when the model can't be reached. (kid, task, extra) → line.
const START = {
  study: (k, t) => `${k}，${t.title}时间到！我们去书房吧，先把要用的书本拿出来。`,
  piano: (k, t) => `${k}，${t.title}时间到！琴房准备好啦，先弹一遍音阶热热身？`,
  gym: (k, t) => `${k}，${t.title}时间到！我们去运动馆，先活动活动手脚～`,
  outdoor: (k, t) => `${k}，${t.title}时间到！我们去公园吧，记得带上水壶。`,
  bedroom: (k, t) => `${k}，该${t.title}啦，我们回房间吧。`,
};
const REMIND = {
  a: (k, t) => `${k}，${t}的时间到了呢，我陪着你，慢慢来呀。`,
  b: (k, t) => `${k}，${t}时间到！出发，拿下它！`,
  c: (k, t) => `${k}，该${t}啦，做完了回来告诉我呀。`,
  d: (k, t) => `提醒：${k}，现在是${t}时间，准备好了就开始吧。`,
};
const CHECK_LINE = {
  posture: (k) => `${k}，写了一会儿啦，坐直一点，眼睛离本子一尺远哦。`,
  eyes: (k) => `${k}，看看窗外远处，让眼睛休息二十秒吧～`,
  water: (k) => `${k}，喝口水吧，歇一下再接着来。`,
  relax: (k) => `${k}，手腕放松，慢一点弹没关系。`,
  slow: (k) => `弹错了也没关系，${k}，一个音一个音弹清楚就好。`,
  cheer: (k, t) => `${k}，${t.title}做得怎么样啦？加油哦！`,
};

export class Coach {
  // say: brain.speakUp(what, facts) → a line or null. momHub: Mom's page, told when the scene changes.
  constructor({ family, hub, momHub = null, say = null, note = null, gapMs = GAP_MS }) {
    Object.assign(this, { family, hub, momHub, say, note, gapMs });
    this.lastSaid = 0;
    this.lastScene = null;
    this.heardAt = 0;
    this.busy = false;
  }

  // MoMo just said something to the companion (she shouldn't be talked over).
  heard() {
    this.heardAt = this.family.now().ms;
  }

  // Every half minute or so. Resolves to the moment spoken (its key), if any.
  async tick() {
    const f = this.family;
    const snap = f.snapshot();
    const { now } = snap;
    const quietHours = f.store.getSetting('quiet');
    const quiet = inQuiet(now.minutes, quietHours);
    const scene = sceneOf({ activity: snap.activity, quiet, free: snap.profile.scene, minutes: now.minutes });
    const where = `${scene.key}/${scene.night}`;
    if (this.lastScene !== null && where !== this.lastScene) {
      this.hub.send({ type: 'refresh' });
      if (this.momHub) this.momHub.send({ type: 'refresh' });
    }
    this.lastScene = where;
    if (!this.hub.size || quiet || this.busy || now.ms - this.heardAt < HEARD_MS) return null;
    const moment = this.due(snap, quietHours).find((m) => m.urgent || now.ms - this.lastSaid >= this.gapMs);
    if (!moment) return null;
    this.mark(moment, now); // first, so a slow model can't make her say it twice
    this.busy = true;
    try {
      const line = await this.lineFor(moment, snap);
      const t = moment.task;
      this.hub.send({
        type: moment.key === 'start' || moment.key === 'nudge' ? 'reminder' : 'say',
        line,
        mood: moment.mood || null,
        proactive: true,
        ...(t ? { task: { id: t.id, title: t.title } } : {}),
        ...(moment.key === 'nudge' ? { gentle: true } : {}),
      });
      if (this.note) this.note(line); // so a reply to it makes sense to her
      this.lastSaid = now.ms;
      if (moment.key === 'start') f.log('tablet', 'reminder', `提醒了${snap.profile.kidName}：${t.title}`);
      return moment.key;
    } finally {
      this.busy = false;
    }
  }

  // What is due now, most pressing first.
  due(snap, quietHours) {
    const { now, activity: act, tasks } = snap;
    const m = now.minutes;
    const out = [];
    if (act) {
      const t = act.task;
      const s = timeToMinutes(t.time);
      const gone = (now.ms - act.from) / 60000; // minutes since it began
      const place = act.scene || 'other';
      if (!act.started && s !== null && m < s + 10 && !said(t, 'start')) out.push({ key: 'start', task: t, place: act.scene, urgent: true, mood: 'cheer' });
      if (!act.started && s !== null && m >= s + 15 && m < s + 25 && t.status === 'todo' && !said(t, 'nudge')) out.push({ key: 'nudge', task: t });
      (CHECK_INS[place] || []).forEach((at, i) => {
        if (at <= t.minutes - 5 && gone >= at && gone < at + 8 && !said(t, `mid${at}`)) out.push({ key: `mid${at}`, task: t, place, gone: Math.round(gone), check: CHECK_KIND[place][i] });
      });
      if (gone >= t.minutes && gone < t.minutes + 10 && !said(t, 'end')) out.push({ key: 'end', task: t });
      if (gone >= t.minutes + 15 && gone < t.minutes + 25 && !said(t, 'over')) out.push({ key: 'over', task: t });
    } else {
      const soon = tasks.find((t) => {
        const s = timeToMinutes(t.time);
        return s !== null && open(t) && !t.started_at && m >= s - 5 && m < s && !said(t, 'soon');
      });
      if (soon) out.push({ key: 'soon', task: soon });
    }
    const done = tasks.find((t) => !open(t) && t.done_at && now.ms - t.done_at < 10 * 60000 && !said(t, 'next'));
    if (done) out.push({ key: 'next', task: done, mood: 'cheer' });

    const day = this.day(now.date);
    const qs = timeToMinutes(quietHours.start);
    const qe = timeToMinutes(quietHours.end);
    if (qe !== null && m >= qe && m < qe + 180 && !day.said.includes('morning')) out.push({ key: 'morning', daily: true, mood: 'happy' });
    if (qs !== null && m >= qs - 15 && m < qs && !day.said.includes('bedtime')) out.push({ key: 'bedtime', daily: true });
    const left = tasks.filter((t) => open(t) && !t.time && !t.started_at);
    if (!act && left.length && m >= 15 * 60 + 30 && (qs === null || m < qs - 30) && day.pending < 3 && now.ms - (day.pendingAt || 0) >= PENDING_MS) {
      out.push({ key: 'pending', daily: true, left });
    }
    return out;
  }

  // The day's own moments, kept with the date so a restart doesn't repeat them.
  day(date) {
    const d = this.family.store.getSetting('coach');
    return d && d.date === date ? { pending: 0, ...d } : { date, said: [], pending: 0 };
  }

  mark(moment, now) {
    if (moment.task) {
      this.family.store.markCoached(moment.task.id, moment.key);
      return;
    }
    const d = this.day(now.date);
    if (moment.key === 'pending') Object.assign(d, { pending: d.pending + 1, pendingAt: now.ms });
    else d.said.push(moment.key);
    this.family.store.setSetting('coach', d);
  }

  // Her words for the moment: from the model, told what is going on, or a set line.
  async lineFor(moment, snap) {
    const { what, line } = this.words(moment, snap);
    if (this.say) {
      try {
        const said = await this.say(what);
        if (said) return said;
      } catch (err) {
        console.error('[coach] speaking up failed:', err.message);
      }
    }
    return line;
  }

  // what: the moment told to the model; line: the set line.
  words(moment, snap) {
    const { profile, now, tasks } = snap;
    const k = profile.kidName;
    const t = moment.task;
    const place = moment.place && SCENES[moment.place] ? SCENES[moment.place].name : '';
    const homework = tasks.filter((x) => open(x) && !x.time).map((x) => x.title);
    const courses = (d) => (d.day ? `${d.label}，课程：${d.courses.map((c) => (c.note ? `${c.name}（${c.note}）` : c.name)).join('、') || '还没填'}` : '不上学');
    switch (moment.key) {
      case 'soon':
        return {
          what: `再过 5 分钟就是「${t.title}」（${t.time} 开始，约 ${t.minutes} 分钟）。提醒 TA 先准备一下，比如喝口水、上个厕所、把要用的东西拿出来。`,
          line: `${k}，再过五分钟就是${t.title}啦，先去喝口水、准备一下吧。`,
        };
      case 'start':
        return {
          what: `「${t.title}」的时间到了${place ? `，你们一起到${place}去` : ''}，高高兴兴地邀请 TA 开始。${moment.place === 'study' && homework.length ? `今天要做的作业有：${homework.join('、')}，可以建议先做哪一件。` : ''}`,
          line: (moment.place && START[moment.place] ? START[moment.place](k, t) : (REMIND[profile.girl] || REMIND.b)(k, t.title)),
        };
      case 'nudge':
        return {
          what: `「${t.title}」${t.time} 就该开始了，过了一刻钟还没听 TA 说开始。温柔地鼓励 TA 先做五分钟，别催。`,
          line: `${k}，${t.title}开始了吗？先做五分钟也很棒哦。`,
        };
      case 'end':
        return {
          what: `「${t.title}」计划的 ${t.minutes} 分钟到了。问问 TA 做完了没有；做完了就跟你说一声，你会记下来给妈妈看。`,
          line: `${k}，${t.title}的时间到啦，做完了吗？做完了就跟我说一声。`,
        };
      case 'over':
        return {
          what: `「${t.title}」比计划多做了一刻钟，还没听 TA 说做完。温柔地问 TA 要不要歇一下、需不需要帮忙，别催。`,
          line: `${k}，${t.title}还没做完也没关系，要不要歇一下再继续？需要帮忙就叫我。`,
        };
      case 'next': {
        const later = tasks.filter((x) => open(x) && x.time && timeToMinutes(x.time) > now.minutes).sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time))[0];
        const left = homework.filter((h) => h !== t.title);
        const then = later ? `下一件是 ${later.time} 的「${later.title}」，还有 ${timeToMinutes(later.time) - now.minutes} 分钟` : left.length ? `还有${left.slice(0, 3).join('、')}没做` : '今天的任务都做完了，可以好好休息、玩一会儿';
        return {
          what: `TA 刚做完「${t.title}」。先具体地夸一句，再告诉 TA：${then}。`,
          line: `${t.title}做完啦，真棒！${later ? `下一件是${later.time}${later.title}，先休息一下吧。` : left.length ? `还有${left.slice(0, 3).join('、')}没做哦。` : '今天的任务都做完啦，真了不起！'}`,
        };
      }
      case 'morning': {
        const today = snap.today;
        const first = today.day && today.courses[0];
        const bring = today.day ? today.courses.filter((c) => c.note).map((c) => c.note) : [];
        const list = tasks.map((x) => `${x.title}${x.time ? `（${x.time}）` : ''}`).join('、');
        return {
          what: `早上了，和 TA 打个招呼。今天：${courses(today)}。今天的任务：${list || '没有'}。只挑最要紧的一两件说，不要全念一遍。`,
          line: `早上好，${k}！今天是${dateZh(now.date).replace(/^.* /, '')}${today.day ? `，${today.label}${first ? `，第一节是${first.name}` : ''}` : '，不用上学'}${bring.length ? `，记得${bring[0]}` : ''}。`,
        };
      }
      case 'bedtime': {
        const tomorrow = snap.tomorrow;
        const bring = tomorrow.day ? tomorrow.courses.filter((c) => c.note).map((c) => `${c.name}${c.note}`) : [];
        return {
          what: `再过 15 分钟就到睡觉时间了。提醒 TA 整理书包、刷牙洗脸，准备睡觉。明天：${courses(tomorrow)}。${bring.length ? '如果明天要带东西，提醒一下。' : ''}`,
          line: `${k}，还有一刻钟就该睡觉啦，把书包整理好、刷牙洗脸吧。${bring.length ? `明天${bring[0]}，别忘了哦。` : ''}`,
        };
      }
      case 'pending': {
        const list = moment.left.slice(0, 3).map((x) => x.title).join('、');
        return {
          what: `现在是空闲时间。TA 还有这些没定时间的任务没做：${list}。轻松地问 TA 要不要现在开始做一件，别催。`,
          line: `${k}，${list}还没做哦，要不要现在开始一件？`,
        };
      }
      default: {
        // a check-in during a task
        const doing = `TA 在${place || ''}${place ? '' : '做'}「${t.title}」，已经 ${moment.gone} 分钟了。`;
        const ask = {
          posture: '提醒 TA 坐直、眼睛离本子远一点，顺便鼓励一句。',
          eyes: '提醒 TA 看看窗外远处，让眼睛休息二十秒。',
          water: '提醒 TA 喝口水、歇一下。',
          relax: '提醒 TA 手腕放松、慢慢弹。',
          slow: '鼓励 TA：弹错了没关系，慢慢弹清楚。',
          cheer: '问问 TA 进展怎么样，鼓励一句。',
        }[moment.check] || '鼓励一句。';
        return { what: doing + ask, line: (CHECK_LINE[moment.check] || CHECK_LINE.cheer)(k, t) };
      }
    }
  }
}
