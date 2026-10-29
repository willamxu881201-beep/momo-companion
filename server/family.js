// Family service: everything the companion knows and can do, built on the
// store plus the family's time zone. Both the HTTP routes and the brain call
// into this, so the same rules (e.g. "points only after Mom confirms") apply
// whether MoMo taps a button or says it out loud.

import { addDays, dateZh, nowIn, timeToMinutes } from './dates.js';
import { cycleDay, describeDay, nextSchoolDay } from './schedule.js';
import { GIRLS, PETS, stageFor } from './characters.js';

export const POINTS = {
  task: 10, // Mom confirmed a task
  ontime: 5, // ...and it was marked done within the planned window
  checkin: 3, // first chat of the morning / evening
  chat: 1, // per chat turn, capped below
  chatDailyCap: 5,
};

const STATUS_ZH = { todo: '还没做', waiting: '做完了，等妈妈确认', confirmed: '妈妈确认过了', redo: '妈妈说要再做一下' };

export class Family {
  constructor(store, { timeZone = 'Asia/Kuala_Lumpur', clock = () => new Date() } = {}) {
    this.store = store;
    this.timeZone = timeZone;
    this.clock = clock;
  }

  now() {
    return nowIn(this.timeZone, this.clock());
  }

  day(date) {
    return describeDay(this.store.cycleConfig(), this.store.getCourses(), date);
  }

  tasks(date) {
    const isSchool = cycleDay(this.store.cycleConfig(), date) !== null;
    this.store.ensureInstances(date, isSchool);
    return this.store.listInstances(date);
  }

  profile() {
    const p = this.store.getSetting('profile');
    const girl = GIRLS[p.girl] ? p.girl : 'b';
    const pet = PETS[p.pet] ? p.pet : '3';
    const voices = this.store.getSetting('voices') || {};
    return {
      kidName: p.kidName || 'MoMo',
      girl,
      pet,
      girlInfo: { ...GIRLS[girl], voice: voices[girl] || GIRLS[girl].voice },
      petInfo: PETS[pet],
    };
  }

  affinity() {
    return stageFor(this.store.affinityTotal());
  }

  // One object with everything the kid page and the brain need.
  snapshot() {
    const now = this.now();
    const today = this.day(now.date);
    const tomorrowDate = addDays(now.date, 1);
    const tomorrow = this.day(tomorrowDate);
    const cfg = this.store.cycleConfig();
    const next = tomorrow.day ? null : nextSchoolDay(cfg, tomorrowDate);
    return {
      now,
      today,
      tomorrow,
      nextSchool: next ? this.day(next) : null,
      tasks: this.tasks(now.date),
      alarms: this.store.pendingAlarms(),
      affinity: this.affinity(),
      profile: this.profile(),
      cycleReady: Boolean(cfg.anchorDate && cfg.anchorDay),
    };
  }

  // ---- actions -------------------------------------------------------------

  markDone(taskId) {
    const t = this.store.getInstance(taskId);
    const now = this.now();
    if (!t || t.date !== now.date) return { ok: false, reason: '今天没有这件任务' };
    if (t.status === 'waiting' || t.status === 'confirmed') return { ok: true, task: t, already: true };
    const start = timeToMinutes(t.time);
    const onTime = start === null || now.minutes <= start + t.minutes + 15;
    this.store.setInstanceStatus(t.id, 'waiting', Date.now(), onTime);
    this.log('kid', 'done', `${this.profile().kidName}说「${t.title}」做完了`);
    return { ok: true, task: this.store.getInstance(t.id) };
  }

  // Mom's decision. Points are granted once per task, at confirmation.
  review(taskId, approve) {
    const t = this.store.getInstance(taskId);
    if (!t) return { ok: false };
    if (!approve) {
      this.store.setInstanceStatus(t.id, 'redo');
      this.log('mom', 'review', `妈妈让「${t.title}」再做一下`);
      return { ok: true, task: this.store.getInstance(t.id), points: 0 };
    }
    this.store.setInstanceStatus(t.id, 'confirmed');
    this.log('mom', 'review', `妈妈确认了「${t.title}」`);
    const ref = String(t.id);
    let points = 0;
    if (!this.store.hasAffinity(t.date, 'task', ref)) {
      this.store.addAffinity(t.date, POINTS.task, 'task', ref);
      points += POINTS.task;
      if (t.on_time) {
        this.store.addAffinity(t.date, POINTS.ontime, 'ontime', ref);
        points += POINTS.ontime;
      }
    }
    return { ok: true, task: this.store.getInstance(t.id), points };
  }

  setAlarm(time, label, date) {
    const now = this.now();
    const mins = timeToMinutes(time);
    if (mins === null) return { ok: false, reason: '时间格式不对' };
    const hhmm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    let day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : now.date;
    if (day === now.date && mins <= now.minutes) day = addDays(now.date, 1);
    if (day < now.date) return { ok: false, reason: '这个时间已经过去了' };
    const cleanLabel = String(label || '提醒').slice(0, 12);
    const id = this.store.addAlarm(day, hhmm, cleanLabel);
    return { ok: true, alarm: { id, date: day, time: hhmm, label: cleanLabel } };
  }

  cancelAlarms() {
    return { ok: true, cancelled: this.store.cancelAlarms() };
  }

  // A line in the day's record for Mom. who: kid | mom | tablet. onEvent (set by the
  // server) lets Mom's page know.
  log(who, kind, text, { fileId = null, data = null } = {}) {
    const id = this.store.addEvent({ date: this.now().date, who, kind, text: String(text).slice(0, 200), fileId, data });
    if (this.onEvent) this.onEvent(id);
    return id;
  }

  // Homework read off a photo becomes today's tasks (tomorrow's, after 8 pm), unless the
  // same title is already there. Returns the tasks added.
  addHomework(items, { source = null } = {}) {
    const now = this.now();
    const date = now.minutes >= 20 * 60 ? addDays(now.date, 1) : now.date;
    const have = new Set(this.tasks(date).map((t) => t.title));
    const added = [];
    for (const h of items) {
      const title = String(h.subject && !h.title.startsWith(h.subject) ? `${h.subject}：${h.title}` : h.title).slice(0, 20);
      if (!title || have.has(title)) continue;
      have.add(title);
      const note = [h.detail && h.detail !== h.title ? h.detail : '', h.due && h.due !== date ? `${dateZh(h.due)}交` : ''].filter(Boolean).join('，');
      const id = this.store.addOneOffTask(date, { title, icon: '📝', minutes: Math.max(10, Number(h.minutes) || 20), note: note.slice(0, 80), source });
      added.push(this.store.getInstance(id));
    }
    return { date, added };
  }

  // A timetable read off a photo replaces the courses for the days it shows (and the
  // number of days in the rotation). The old ones are returned, for undo.
  applyTimetable(tt) {
    const cycle = this.store.getSetting('cycle');
    const before = { courses: this.store.getCourses(), cycleLength: cycle.cycleLength, anchorDay: cycle.anchorDay };
    if (tt.cycle && tt.cycle !== cycle.cycleLength) {
      this.store.setSetting('cycle', { ...cycle, cycleLength: tt.cycle, anchorDay: cycle.anchorDay && cycle.anchorDay <= tt.cycle ? cycle.anchorDay : null });
    }
    for (const d of tt.days) if (d.day <= tt.cycle) this.store.setCourses(d.day, d.courses);
    return before;
  }

  // Puts back what a photo changed: the timetable as it was, or the tasks it added
  // (those not yet started).
  undo(data) {
    if (data.courses) {
      for (const day of Object.keys({ ...this.store.getCourses(), ...data.courses })) this.store.setCourses(Number(day), data.courses[day] || []);
      const cycle = this.store.getSetting('cycle');
      this.store.setSetting('cycle', { ...cycle, cycleLength: data.cycleLength || cycle.cycleLength, anchorDay: data.anchorDay === undefined ? cycle.anchorDay : data.anchorDay });
    }
    for (const id of data.added || []) {
      const t = this.store.getInstance(id);
      if (t && t.status === 'todo') this.store.deleteTask(id);
    }
  }

  // Called after each chat turn. Returns the points actually granted.
  awardChat() {
    const now = this.now();
    let granted = 0;
    const slot = now.minutes >= 300 && now.minutes < 600 ? 'checkin-am' : now.minutes >= 1140 && now.minutes < 1350 ? 'checkin-pm' : null;
    if (slot && !this.store.hasAffinity(now.date, slot, null)) {
      this.store.addAffinity(now.date, POINTS.checkin, slot);
      granted += POINTS.checkin;
    }
    if (this.store.affinitySum(now.date, 'chat') < POINTS.chatDailyCap) {
      this.store.addAffinity(now.date, POINTS.chat, 'chat');
      granted += POINTS.chat;
    }
    return granted;
  }

  // ---- text for the language model ----------------------------------------

  factsText(snap = this.snapshot()) {
    const lines = [];
    const fmtDay = (d) => {
      if (!d.day) return `${dateZh(d.date)}：休息，不上学`;
      const list = d.courses.length
        ? d.courses.map((c) => (c.note ? `${c.name}（${c.note}）` : c.name)).join('、')
        : '（妈妈还没填这天的课）';
      return `${dateZh(d.date)}：${d.label}，课程依次是 ${list}`;
    };
    lines.push(`现在：${dateZh(snap.now.date)} ${snap.now.time}`);
    if (!snap.cycleReady) lines.push('（妈妈还没设置课表轮换，所以不知道今天是 D 几）');
    lines.push(`今天 ${fmtDay(snap.today)}`);
    lines.push(`明天 ${fmtDay(snap.tomorrow)}`);
    if (snap.nextSchool) lines.push(`下一个上学日 ${fmtDay(snap.nextSchool)}`);
    if (snap.tasks.length) {
      lines.push(
        '今天的任务：' +
          snap.tasks
            .map((t) => `[id=${t.id}] ${t.title}${t.note ? `〔${t.note}〕` : ''}${t.time ? `（${t.time}，约 ${t.minutes} 分钟）` : ''}：${STATUS_ZH[t.status] || t.status}`)
            .join('；'),
      );
    } else {
      lines.push('今天没有安排任务');
    }
    lines.push(
      snap.alarms.length
        ? '已设的闹钟：' + snap.alarms.map((a) => `${dateZh(a.date)} ${a.time} ${a.label}`).join('；')
        : '没有设闹钟',
    );
    const a = snap.affinity;
    lines.push(
      `好感度 ${a.points}，${snap.profile.petInfo.name}现在是第 ${a.stage} 阶段` +
        (a.next ? `，再攒 ${a.next - a.points} 点进化` : '，已经是最高阶段'),
    );
    return lines.join('\n');
  }
}
