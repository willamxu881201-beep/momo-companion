// Live pushes (Server-Sent Events) to the tablet and to Mom's page, and the
// half-minute scheduler that rings alarms, lets the companion speak up about the day's
// tasks (coach.js), passes on Mom's messages once the tablet is on, and clears out old
// photos and old records.

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

  // onOpen runs once the stream is open, e.g. to send what is waiting for this page.
  attach(req, res, onOpen) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    if (onOpen) onOpen();
  }

  write(chunk) {
    for (const res of this.clients) res.write(chunk);
  }

  send(event) {
    this.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

const ALARM = (kid, label) => `${kid}，${label}时间到啦！`;

const KEEP_DAYS = 90; // the day's record and the messages; photos go after a week (files.js)

export function inQuiet(minutes, quiet) {
  const s = timeToMinutes(quiet?.start);
  const e = timeToMinutes(quiet?.end);
  if (s === null || e === null || s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

export class Scheduler {
  // All optional: coach (what the companion says about the tasks), post (messages to
  // pass on), files (photos to clear out).
  constructor(family, hub, { coach = null, post = null, files = null } = {}) {
    this.family = family;
    this.hub = hub;
    this.coach = coach;
    this.post = post;
    this.files = files;
  }

  start(everyMs = 30000) {
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
    this.tick();
  }

  // Resolves when the coach has spoken (its line can take the model a few seconds).
  tick() {
    let spoke = Promise.resolve(null);
    try {
      this.checkAlarms();
      if (this.coach) spoke = this.coach.tick().catch((err) => console.error('[coach]', err));
      if (this.post) this.post.offer();
      if (Date.now() - (this.swept || 0) > 3600000) {
        this.swept = Date.now();
        if (this.files) this.files.sweep();
        this.family.store.prune(Date.now() - KEEP_DAYS * 86400000);
      }
    } catch (err) {
      console.error('[scheduler]', err);
    }
    return spoke;
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
      if (!stale) {
        this.hub.send({ type: 'alarm', alarm: a, line: ALARM(kidName, a.label) });
        this.family.log('tablet', 'alarm', `闹钟响了：${a.label}`);
      }
    }
  }
}
