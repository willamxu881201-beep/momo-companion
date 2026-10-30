// SQLite storage (node:sqlite, no native modules). One file holds the family's
// data: timetable, tasks, alarms, affinity ledger, settings, the day's events (what
// happened, in a line each, for Mom), messages passed between Mom and MoMo, and the
// list of photos and documents kept for a while (the files themselves are on disk, see
// files.js; a document's text is kept here with it). Nothing the child says to the companion is stored; chat history lives
// in memory only (see brain.js).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { weekday } from './dates.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS courses (
  day INTEGER NOT NULL, idx INTEGER NOT NULL,
  name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (day, idx)
);
CREATE TABLE IF NOT EXISTS day_overrides (
  date TEXT PRIMARY KEY, value TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS task_templates (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '',
  time TEXT, minutes INTEGER NOT NULL DEFAULT 30,
  days TEXT NOT NULL DEFAULT 'school',
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_instances (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL, template_id INTEGER,
  title TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '',
  time TEXT, minutes INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'todo',
  done_at INTEGER, confirmed_at INTEGER,
  reminded INTEGER NOT NULL DEFAULT 0,
  on_time INTEGER NOT NULL DEFAULT 0,
  UNIQUE (date, template_id)
);
CREATE TABLE IF NOT EXISTS alarms (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL, time TEXT NOT NULL, label TEXT NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS affinity (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL, date TEXT NOT NULL,
  delta INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT
);
CREATE TABLE IF NOT EXISTS parent_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage (
  date TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, kind)
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL, who TEXT NOT NULL, kind TEXT NOT NULL,
  mime TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, bytes INTEGER NOT NULL,
  result TEXT, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL, date TEXT NOT NULL, who TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, file_id INTEGER, data TEXT
);
CREATE INDEX IF NOT EXISTS events_date ON events (date, at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL, from_who TEXT NOT NULL, to_who TEXT NOT NULL,
  text TEXT NOT NULL, delivered_at INTEGER
);
`;

// Columns added after the first release, for databases made before them.
const COLUMNS = {
  task_templates: { scene: 'TEXT' }, // where the task happens (activity.js); null: by its name
  task_instances: {
    note: "TEXT NOT NULL DEFAULT ''",
    source: 'TEXT',
    scene: 'TEXT',
    started_at: 'INTEGER', // MoMo said she started it
    coached: "TEXT NOT NULL DEFAULT ''", // what the companion has already said about it (coach.js)
  },
  files: { text: 'TEXT' },
};

export const DEFAULT_SETTINGS = {
  cycle: { cycleLength: 6, anchorDate: null, anchorDay: null, schoolWeekdays: [1, 2, 3, 4, 5] },
  profile: { kidName: 'MoMo', girl: 'b', pet: '3' },
  hidden: { girls: [], pets: [] },
  quiet: { start: '21:30', end: '06:30' },
  kidLink: { key: null },
};

const plain = (row) => (row ? { ...row } : row);

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  // ---- settings ----------------------------------------------------------

  getSetting(k) {
    const row = this.db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
    const fallback = DEFAULT_SETTINGS[k];
    if (!row) return structuredClone(fallback);
    const v = JSON.parse(row.v);
    return fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? { ...fallback, ...v } : v;
  }

  setSetting(k, v) {
    this.db
      .prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, JSON.stringify(v));
  }

  // ---- timetable ---------------------------------------------------------

  getCourses() {
    const out = {};
    for (const r of this.db.prepare('SELECT day, idx, name, note FROM courses ORDER BY day, idx').all()) {
      (out[r.day] ||= []).push(r.note ? { name: r.name, note: r.note } : { name: r.name });
    }
    return out;
  }

  setCourses(day, list) {
    this.db.prepare('DELETE FROM courses WHERE day = ?').run(day);
    const ins = this.db.prepare('INSERT INTO courses (day, idx, name, note) VALUES (?, ?, ?, ?)');
    list.forEach((c, i) => ins.run(day, i, c.name, c.note || ''));
  }

  getOverrides() {
    const out = {};
    for (const r of this.db.prepare('SELECT date, value FROM day_overrides').all()) {
      out[r.date] = r.value === 'off' ? 'off' : Number(r.value);
    }
    return out;
  }

  listOverrides() {
    return this.db.prepare('SELECT date, value, note FROM day_overrides ORDER BY date').all().map(plain);
  }

  setOverride(date, value, note = '') {
    if (value === null || value === undefined || value === '') {
      this.db.prepare('DELETE FROM day_overrides WHERE date = ?').run(date);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO day_overrides (date, value, note) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET value = excluded.value, note = excluded.note',
      )
      .run(date, String(value), note);
  }

  cycleConfig() {
    return { ...this.getSetting('cycle'), overrides: this.getOverrides() };
  }

  // ---- task templates ----------------------------------------------------

  listTemplates() {
    return this.db.prepare('SELECT * FROM task_templates ORDER BY sort, time, id').all().map(plain);
  }

  saveTemplate(t) {
    const row = {
      title: t.title,
      icon: t.icon || '',
      time: t.time || null,
      minutes: Number(t.minutes) || 30,
      days: t.days || 'school',
      active: t.active === false || t.active === 0 ? 0 : 1,
      sort: Number(t.sort) || 0,
      scene: t.scene || null,
    };
    if (t.id) {
      this.db
        .prepare(
          'UPDATE task_templates SET title = ?, icon = ?, time = ?, minutes = ?, days = ?, active = ?, sort = ?, scene = ? WHERE id = ?',
        )
        .run(row.title, row.icon, row.time, row.minutes, row.days, row.active, row.sort, row.scene, t.id);
      // Today's and later copies follow where it happens.
      this.db.prepare("UPDATE task_instances SET scene = ? WHERE template_id = ? AND status = 'todo'").run(row.scene, t.id);
      return Number(t.id);
    }
    const r = this.db
      .prepare('INSERT INTO task_templates (title, icon, time, minutes, days, active, sort, scene) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.title, row.icon, row.time, row.minutes, row.days, row.active, row.sort, row.scene);
    return Number(r.lastInsertRowid);
  }

  deleteTemplate(id) {
    this.db.prepare('DELETE FROM task_templates WHERE id = ?').run(id);
    // Today's untouched copies go too; finished ones stay in the record.
    this.db.prepare("DELETE FROM task_instances WHERE template_id = ? AND status = 'todo'").run(id);
  }

  // ---- daily task instances ----------------------------------------------

  // Copies the templates that apply to `date` into concrete tasks, once.
  ensureInstances(date, isSchoolDay) {
    const wd = weekday(date);
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO task_instances (date, template_id, title, icon, time, minutes, scene) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const t of this.listTemplates()) {
      if (!t.active || !templateApplies(t.days, wd, isSchoolDay)) continue;
      ins.run(date, t.id, t.title, t.icon, t.time, t.minutes, t.scene ?? null);
    }
  }

  listInstances(date) {
    return this.db
      .prepare("SELECT * FROM task_instances WHERE date = ? ORDER BY COALESCE(time, '99:99'), id")
      .all(date)
      .map(plain);
  }

  getInstance(id) {
    return plain(this.db.prepare('SELECT * FROM task_instances WHERE id = ?').get(id));
  }

  setInstanceStatus(id, status, at = Date.now(), onTime = false) {
    if (status === 'waiting') {
      this.db
        .prepare('UPDATE task_instances SET status = ?, done_at = ?, on_time = ? WHERE id = ?')
        .run(status, at, onTime ? 1 : 0, id);
    } else if (status === 'confirmed') {
      this.db.prepare('UPDATE task_instances SET status = ?, confirmed_at = ? WHERE id = ?').run(status, at, id);
    } else {
      this.db
        .prepare('UPDATE task_instances SET status = ?, done_at = NULL, confirmed_at = NULL, on_time = 0 WHERE id = ?')
        .run(status, id);
    }
  }

  markReminded(id, n) {
    this.db.prepare('UPDATE task_instances SET reminded = ? WHERE id = ?').run(n, id);
  }

  setStarted(id, at = Date.now()) {
    this.db.prepare('UPDATE task_instances SET started_at = ? WHERE id = ?').run(at, id);
  }

  // The companion has said `key` about this task (coach.js); each is said once.
  markCoached(id, key) {
    this.db.prepare("UPDATE task_instances SET coached = coached || ? || ',' WHERE id = ?").run(key, id);
  }

  listWaiting() {
    return this.db.prepare("SELECT * FROM task_instances WHERE status = 'waiting' ORDER BY date, time").all().map(plain);
  }

  // A task for one day only (homework read off a photo, or one Mom asked for).
  addOneOffTask(date, { title, icon = '', time = null, minutes = 30, note = '', source = null }) {
    const r = this.db
      .prepare('INSERT INTO task_instances (date, template_id, title, icon, time, minutes, note, source) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)')
      .run(date, title, icon, time, minutes, note, source);
    return Number(r.lastInsertRowid);
  }

  deleteTask(id) {
    this.db.prepare('DELETE FROM task_instances WHERE id = ?').run(id);
  }

  // ---- alarms ------------------------------------------------------------

  addAlarm(date, time, label) {
    const r = this.db
      .prepare('INSERT INTO alarms (date, time, label, created_at) VALUES (?, ?, ?, ?)')
      .run(date, time, label, Date.now());
    return Number(r.lastInsertRowid);
  }

  pendingAlarms() {
    return this.db.prepare('SELECT * FROM alarms WHERE fired = 0 ORDER BY date, time').all().map(plain);
  }

  cancelAlarms() {
    return Number(this.db.prepare('UPDATE alarms SET fired = 2 WHERE fired = 0').run().changes);
  }

  markAlarmFired(id) {
    this.db.prepare('UPDATE alarms SET fired = 1 WHERE id = ?').run(id);
  }

  // ---- affinity ----------------------------------------------------------

  addAffinity(date, delta, reason, ref = null) {
    this.db
      .prepare('INSERT INTO affinity (at, date, delta, reason, ref) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), date, delta, reason, ref);
  }

  affinityTotal() {
    return Number(this.db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM affinity').get().s);
  }

  affinitySum(date, reason) {
    return Number(
      this.db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM affinity WHERE date = ? AND reason = ?').get(date, reason).s,
    );
  }

  hasAffinity(date, reason, ref) {
    return !!this.db.prepare('SELECT 1 FROM affinity WHERE date = ? AND reason = ? AND ref IS ?').get(date, reason, ref);
  }

  affinityLedger(limit = 50) {
    return this.db.prepare('SELECT * FROM affinity ORDER BY id DESC LIMIT ?').all(limit).map(plain);
  }

  // ---- parent sessions -----------------------------------------------------

  addParentSession(tokenHash, expiresAt) {
    this.db.prepare('DELETE FROM parent_sessions WHERE expires_at < ?').run(Date.now());
    this.db.prepare('INSERT INTO parent_sessions (token_hash, expires_at) VALUES (?, ?)').run(tokenHash, expiresAt);
  }

  hasParentSession(tokenHash) {
    const row = this.db.prepare('SELECT expires_at FROM parent_sessions WHERE token_hash = ?').get(tokenHash);
    return !!row && row.expires_at > Date.now();
  }

  removeParentSession(tokenHash) {
    this.db.prepare('DELETE FROM parent_sessions WHERE token_hash = ?').run(tokenHash);
  }

  // ---- photos and files ------------------------------------------------------

  addFile({ who, kind, mime, name = '', path, bytes, expires }) {
    const r = this.db
      .prepare('INSERT INTO files (at, who, kind, mime, name, path, bytes, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), who, kind, mime, name, path, bytes, expires);
    return Number(r.lastInsertRowid);
  }

  getFile(id) {
    const f = plain(this.db.prepare('SELECT * FROM files WHERE id = ?').get(id));
    if (f && f.result) f.result = JSON.parse(f.result);
    return f;
  }

  setFileResult(id, result) {
    this.db.prepare('UPDATE files SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
  }

  setFileText(id, text) {
    this.db.prepare('UPDATE files SET text = ? WHERE id = ?').run(text, id);
  }

  getFileText(id) {
    const r = this.db.prepare('SELECT text FROM files WHERE id = ?').get(id);
    return r ? r.text || '' : null;
  }

  // Documents (not photos), newest first, from `since` (ms) on; who: only theirs.
  listDocs({ since = 0, who = null, limit = 8 } = {}) {
    return this.db
      .prepare(`SELECT id, at, who, mime, name, bytes, result, length(text) AS chars FROM files WHERE kind = 'doc' AND at >= ?${who ? ' AND who = ?' : ''} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...[since, who, limit].filter((v) => v !== null))
      .map((f) => ({ ...f, result: f.result ? JSON.parse(f.result) : null }));
  }

  expiredFiles(now = Date.now()) {
    return this.db.prepare('SELECT id, path FROM files WHERE expires < ?').all(now).map(plain);
  }

  deleteFile(id) {
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
    this.db.prepare('UPDATE events SET file_id = NULL WHERE file_id = ?').run(id);
  }

  // ---- the day's events ------------------------------------------------------

  addEvent({ date, who, kind, text, fileId = null, data = null }) {
    const r = this.db
      .prepare('INSERT INTO events (at, date, who, kind, text, file_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), date, who, kind, text, fileId, data === null ? null : JSON.stringify(data));
    return Number(r.lastInsertRowid);
  }

  getEvent(id) {
    const e = plain(this.db.prepare('SELECT * FROM events WHERE id = ?').get(id));
    if (e && e.data) e.data = JSON.parse(e.data);
    return e;
  }

  setEventData(id, data) {
    this.db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
  }

  // file_kind: photo, check or doc, for events with a file still kept.
  listEvents(date, limit = 60) {
    return this.db
      .prepare('SELECT e.*, f.kind AS file_kind FROM events e LEFT JOIN files f ON f.id = e.file_id WHERE e.date = ? ORDER BY e.at DESC, e.id DESC LIMIT ?')
      .all(date, limit)
      .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
  }

  // How many events of a kind a day has, and when the last one was (ms). withFile:
  // only those with a picture (a look-in that really took one).
  eventCount(date, kind, { withFile = false } = {}) {
    return plain(this.db.prepare(`SELECT COUNT(*) AS n, MAX(at) AS last FROM events WHERE date = ? AND kind = ?${withFile ? ' AND file_id IS NOT NULL' : ''}`).get(date, kind));
  }

  // Forgets the record and the messages from before `before` (ms).
  prune(before) {
    const events = this.db.prepare('DELETE FROM events WHERE at < ?').run(before).changes;
    const messages = this.db.prepare('DELETE FROM messages WHERE at < ?').run(before).changes;
    return { events: Number(events), messages: Number(messages) };
  }

  // ---- messages between Mom and MoMo ------------------------------------------

  addMessage(from, to, text) {
    const r = this.db.prepare('INSERT INTO messages (at, from_who, to_who, text) VALUES (?, ?, ?, ?)').run(Date.now(), from, to, text);
    return Number(r.lastInsertRowid);
  }

  undelivered(to) {
    return this.db.prepare('SELECT * FROM messages WHERE to_who = ? AND delivered_at IS NULL ORDER BY id').all(to).map(plain);
  }

  markDelivered(id) {
    this.db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(Date.now(), id);
  }

  // Messages to `to` that arrived since `since` (ms), newest last.
  recentMessages(to, since) {
    return this.db.prepare('SELECT * FROM messages WHERE to_who = ? AND at >= ? ORDER BY id').all(to, since).map(plain);
  }

  // ---- daily usage counters (cost guard) ---------------------------------

  usage(date, kind) {
    const row = this.db.prepare('SELECT n FROM usage WHERE date = ? AND kind = ?').get(date, kind);
    return row ? Number(row.n) : 0;
  }

  addUsage(date, kind, n = 1) {
    this.db
      .prepare('INSERT INTO usage (date, kind, n) VALUES (?, ?, ?) ON CONFLICT(date, kind) DO UPDATE SET n = n + excluded.n')
      .run(date, kind, n);
  }
}

// days: 'every' | 'school' | 'offday' | comma list of weekdays '1,3,5' (0 = Sunday)
export function templateApplies(days, wd, isSchoolDay) {
  if (days === 'every') return true;
  if (days === 'school') return isSchoolDay;
  if (days === 'offday') return !isSchoolDay;
  return String(days)
    .split(',')
    .map((s) => Number(s.trim()))
    .includes(wd);
}
