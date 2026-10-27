// Live push to the tablet (Server-Sent Events) and the minute-by-minute
// scheduler that fires task reminders and alarms.

import { timeToMinutes } from './dates.js';

export class Hub {
  constructor() {
    this.clients = new Set();
    this.timer = setInterval(() => this.write(': ping\n\n'), 25000);
    this.timer.unref();
  }

  get size() {
    return this.clients.size;
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  write(chunk) {
    for (const res of this.clients) res.write(chunk);
  }

  send(event) {
    this.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

const REMIND = {
  a: (kid, t) => `${kid}，${t}的时间到了呢，我陪着你，慢慢来呀。`,
  b: (kid, t) => `${kid}，${t}时间到！出发，拿下它！`,
  c: (kid, t) => `${kid}，该${t}啦，做完了回来告诉我呀。`,
  d: (kid, t) => `提醒：${kid}，现在是${t}时间，准备好了就开始吧。`,
};
const NUDGE = (kid, t) => `${kid}，${t}开始了吗？先做五分钟也很棒哦。`;
const ALARM = (kid, label) => `${kid}，${label}时间到啦！`;

export function inQuiet(minutes, quiet) {
  const s = timeToMinutes(quiet?.start);
  const e = timeToMinutes(quiet?.end);
  if (s === null || e === null || s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

export class Scheduler {
  constructor(family, hub) {
    this.family = family;
    this.hub = hub;
  }

  start(everyMs = 30000) {
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
    this.tick();
  }

  tick() {
    try {
      this.checkAlarms();
      this.checkTasks();
    } catch (err) {
      console.error('[scheduler]', err);
    }
  }

  checkAlarms() {
    const { store } = this.family;
    const now = this.family.now();
    const { kidName } = this.family.profile();
    for (const a of store.pendingAlarms()) {
      const at = timeToMinutes(a.time);
      const due = a.date < now.date || (a.date === now.date && at <= now.minutes);
      if (!due) continue;
      const stale = a.date < now.date || now.minutes - at > 30;
      if (!stale && this.hub.size === 0) continue; // wait for the tablet to come back
      store.markAlarmFired(a.id);
      if (!stale) this.hub.send({ type: 'alarm', alarm: a, line: ALARM(kidName, a.label) });
    }
  }

  checkTasks() {
    const { store } = this.family;
    const now = this.family.now();
    if (inQuiet(now.minutes, store.getSetting('quiet')) || this.hub.size === 0) return;
    const { kidName, girl } = this.family.profile();
    for (const t of this.family.tasks(now.date)) {
      if (t.status !== 'todo') continue;
      const start = timeToMinutes(t.time);
      if (start === null) continue;
      if (t.reminded === 0 && now.minutes >= start && now.minutes < start + 10) {
        store.markReminded(t.id, 1);
        this.hub.send({ type: 'reminder', task: t, line: (REMIND[girl] || REMIND.b)(kidName, t.title) });
      } else if (t.reminded === 1 && now.minutes >= start + 15 && now.minutes < start + 25) {
        store.markReminded(t.id, 2);
        this.hub.send({ type: 'reminder', task: t, line: NUDGE(kidName, t.title), gentle: true });
      }
    }
  }
}
