// HTTP routes. No framework: a small table of (method, path) → handler.
// Pages and assets are served from web/; everything else is JSON under /api.

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { addDays, dateZh, isDate, timeToMinutes } from './dates.js';
import { DEVICE_COOKIE, PARENT_COOKIE, cookie, parseCookies } from './auth.js';
import { GIRLS, PETS, STAGE_NAMES, STAGES } from './characters.js';
import { synthesize, transcribe, wavRms, wavSeconds } from './speech.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};
const PAGES = { '/': 'kid.html', '/parent': 'parent.html', '/pair': 'pair.html' };
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createHandler({ config, store, family, brain, auth, hub, webDir }) {
  const ttsCache = new Map();
  const routes = [];
  const on = (method, path, access, fn) => routes.push({ method, path, access, fn });

  // ---- public --------------------------------------------------------------

  on('GET', '/healthz', null, () => ({ ok: true }));

  on('POST', '/api/pair', null, (ctx) => {
    const r = auth.pair(ctx.body.code, ctx.body.name);
    if (!r.ok) throw new HttpError(400, r.reason);
    ctx.setCookie(cookie(DEVICE_COOKIE, r.token, { maxAge: r.maxAge, secure: ctx.secure }));
    return { ok: true };
  });

  on('POST', '/api/parent/login', null, (ctx) => {
    if (!config.parentPassword) throw new HttpError(503, '服务器还没设置家长密码（PARENT_PASSWORD）');
    const r = auth.login(ctx.ip, String(ctx.body.password || ''));
    if (!r.ok) throw new HttpError(401, r.reason);
    ctx.setCookie(cookie(PARENT_COOKIE, r.token, { maxAge: r.maxAge, secure: ctx.secure }));
    return { ok: true };
  });

  // ---- the tablet (a paired device; Mom's session works too) ---------------

  on('GET', '/api/state', 'device', () => kidState());

  on('GET', '/api/events', 'device', (ctx) => {
    hub.attach(ctx.req, ctx.res);
    return undefined; // response stays open
  });

  on('POST', '/api/chat', 'device', async (ctx) => {
    const today = family.now().date;
    if (store.usage(today, 'chat') >= config.limits.chatPerDay) {
      return { reply: '今天我们聊了好多啦，我的嗓子要休息一下，明天再陪你聊好不好？', petAction: null, actions: [], limited: true };
    }
    store.addUsage(today, 'chat');
    const key = ctx.device ? `d${ctx.device.id}` : 'parent';
    const r = await brain.reply(key, ctx.body.text);
    return { ...r, state: kidState() };
  });

  on('POST', '/api/asr', 'device', async (ctx) => {
    const wav = Buffer.from(String(ctx.body.wav || ''), 'base64');
    const seconds = wavSeconds(wav);
    if (seconds < 0.3) return { text: '', reason: 'short' };
    if (seconds > 30) throw new HttpError(413, '说得太长啦，30 秒以内哦');
    if (wavRms(wav) < 0.008) return { text: '', reason: 'quiet' };
    const today = family.now().date;
    if (store.usage(today, 'asr') >= config.limits.asrPerDay) throw new HttpError(429, '今天的语音次数用完了');
    store.addUsage(today, 'asr');
    const text = await transcribe({ apiKey: config.arkApiKey, model: config.asrModel, wavBase64: wav.toString('base64') });
    return { text };
  });

  on('POST', '/api/tts', 'device', async (ctx) => {
    const text = String(ctx.body.text || '').slice(0, 300);
    if (!text || !config.ttsAppId) return { status: 204 };
    const { girlInfo } = family.profile();
    const speaker = girlInfo.voice;
    const key = `${speaker}|${text}`;
    let audio = ttsCache.get(key);
    if (!audio) {
      const today = family.now().date;
      if (store.usage(today, 'tts') + text.length > config.limits.ttsCharsPerDay) return { status: 204 };
      store.addUsage(today, 'tts', text.length);
      audio = await synthesize({ appId: config.ttsAppId, token: config.ttsToken, speaker, text });
      if (!audio) return { status: 204 };
      ttsCache.set(key, audio);
      if (ttsCache.size > 80) ttsCache.delete(ttsCache.keys().next().value);
    }
    return { status: 200, type: 'audio/mpeg', body: audio };
  });

  on('POST', '/api/tasks/:id/done', 'device', (ctx) => {
    const r = family.markDone(Number(ctx.params.id));
    if (!r.ok) throw new HttpError(400, r.reason);
    return { ok: true, state: kidState() };
  });

  on('POST', '/api/profile', 'device', (ctx) => {
    const hidden = store.getSetting('hidden');
    const p = store.getSetting('profile');
    const { girl, pet } = ctx.body;
    if (girl !== undefined) {
      if (!GIRLS[girl] || hidden.girls.includes(girl)) throw new HttpError(400, '没有这个伙伴');
      p.girl = girl;
    }
    if (pet !== undefined) {
      if (!PETS[pet] || hidden.pets.includes(String(pet))) throw new HttpError(400, '没有这个宠物');
      p.pet = String(pet);
    }
    store.setSetting('profile', p);
    brain.forget(ctx.device ? `d${ctx.device.id}` : 'parent');
    return { ok: true, state: kidState() };
  });

  // ---- Mom -------------------------------------------------------------------

  on('POST', '/api/parent/logout', 'parent', (ctx) => {
    auth.logout(ctx.cookies);
    ctx.setCookie(cookie(PARENT_COOKIE, '', { maxAge: 0, secure: ctx.secure }));
    return { ok: true };
  });

  on('GET', '/api/parent/state', 'parent', () => parentState());

  on('POST', '/api/parent/cycle', 'parent', (ctx) => {
    const b = ctx.body;
    const cycleLength = Number(b.cycleLength) || 6;
    if (cycleLength < 2 || cycleLength > 10) throw new HttpError(400, '轮换天数要在 2 到 10 之间');
    if (b.anchorDate && !isDate(b.anchorDate)) throw new HttpError(400, '日期格式不对');
    const anchorDay = b.anchorDay ? Number(b.anchorDay) : null;
    if (anchorDay !== null && (anchorDay < 1 || anchorDay > cycleLength)) throw new HttpError(400, `D 几要在 1 到 ${cycleLength} 之间`);
    const schoolWeekdays = Array.isArray(b.schoolWeekdays) ? b.schoolWeekdays.map(Number).filter((n) => n >= 0 && n <= 6) : [1, 2, 3, 4, 5];
    store.setSetting('cycle', { cycleLength, anchorDate: b.anchorDate || null, anchorDay, schoolWeekdays });
    return parentState();
  });

  on('POST', '/api/parent/courses', 'parent', (ctx) => {
    const day = Number(ctx.body.day);
    const n = store.getSetting('cycle').cycleLength;
    if (!(day >= 1 && day <= n)) throw new HttpError(400, `D 几要在 1 到 ${n} 之间`);
    const list = (Array.isArray(ctx.body.list) ? ctx.body.list : [])
      .map((c) => ({ name: String(c.name || '').trim().slice(0, 20), note: String(c.note || '').trim().slice(0, 30) }))
      .filter((c) => c.name);
    store.setCourses(day, list.slice(0, 12));
    return parentState();
  });

  on('POST', '/api/parent/override', 'parent', (ctx) => {
    const { date, value, note } = ctx.body;
    if (!isDate(date)) throw new HttpError(400, '日期格式不对');
    if (value !== null && value !== 'off' && !(Number(value) >= 1)) throw new HttpError(400, '只能设成"放假"或 D 几');
    store.setOverride(date, value === 'off' || value === null ? value : Number(value), String(note || '').slice(0, 20));
    return parentState();
  });

  on('POST', '/api/parent/holidays', 'parent', (ctx) => {
    const { from, to, note } = ctx.body;
    if (!isDate(from) || !isDate(to) || to < from) throw new HttpError(400, '日期范围不对');
    let n = 0;
    for (let d = from; d <= to && n < 120; d = addDays(d, 1), n += 1) store.setOverride(d, 'off', String(note || '假期').slice(0, 20));
    return parentState();
  });

  on('POST', '/api/parent/templates', 'parent', (ctx) => {
    const t = ctx.body;
    const title = String(t.title || '').trim().slice(0, 20);
    if (!title) throw new HttpError(400, '任务名不能为空');
    if (t.time && timeToMinutes(t.time) === null) throw new HttpError(400, '时间格式是 HH:MM，比如 16:30');
    store.saveTemplate({ ...t, title, icon: String(t.icon || '').slice(0, 4), minutes: Math.min(Math.max(Number(t.minutes) || 30, 5), 240) });
    return parentState();
  });

  on('POST', '/api/parent/templates/:id/delete', 'parent', (ctx) => {
    store.deleteTemplate(Number(ctx.params.id));
    return parentState();
  });

  on('POST', '/api/parent/review', 'parent', (ctx) => {
    const r = family.review(Number(ctx.body.id), Boolean(ctx.body.approve));
    if (!r.ok) throw new HttpError(404, '找不到这件任务');
    hub.send({ type: 'refresh' });
    return parentState();
  });

  on('POST', '/api/parent/settings', 'parent', (ctx) => {
    const b = ctx.body;
    if (b.profile) {
      const p = store.getSetting('profile');
      if (b.profile.kidName) p.kidName = String(b.profile.kidName).trim().slice(0, 12) || p.kidName;
      if (GIRLS[b.profile.girl]) p.girl = b.profile.girl;
      if (PETS[b.profile.pet]) p.pet = String(b.profile.pet);
      store.setSetting('profile', p);
    }
    if (b.hidden) {
      const girls = (b.hidden.girls || []).filter((k) => GIRLS[k]);
      const pets = (b.hidden.pets || []).map(String).filter((k) => PETS[k]);
      if (girls.length >= Object.keys(GIRLS).length || pets.length >= Object.keys(PETS).length) {
        throw new HttpError(400, '至少要留一个少女和一个宠物');
      }
      store.setSetting('hidden', { girls, pets });
      const p = store.getSetting('profile');
      if (girls.includes(p.girl)) p.girl = Object.keys(GIRLS).find((k) => !girls.includes(k));
      if (pets.includes(p.pet)) p.pet = Object.keys(PETS).find((k) => !pets.includes(k));
      store.setSetting('profile', p);
    }
    if (b.quiet) {
      if (timeToMinutes(b.quiet.start) === null || timeToMinutes(b.quiet.end) === null) throw new HttpError(400, '安静时间格式是 HH:MM');
      store.setSetting('quiet', { start: b.quiet.start, end: b.quiet.end });
    }
    if (b.voices) {
      const v = {};
      for (const k of Object.keys(GIRLS)) if (b.voices[k]) v[k] = String(b.voices[k]).trim().slice(0, 80);
      store.setSetting('voices', v);
    }
    hub.send({ type: 'refresh' });
    return parentState();
  });

  on('POST', '/api/parent/pair', 'parent', (ctx) => {
    const code = auth.createPairingCode();
    const base = config.publicUrl || `${ctx.secure ? 'https' : 'http'}://${ctx.req.headers.host}`;
    return { url: `${base}/pair#${code}`, minutes: 15 };
  });

  on('POST', '/api/parent/devices/:id/delete', 'parent', (ctx) => {
    store.removeDevice(Number(ctx.params.id));
    return parentState();
  });

  on('POST', '/api/parent/test-reminder', 'parent', () => {
    const { kidName } = family.profile();
    hub.send({ type: 'reminder', task: { title: '测试' }, line: `${kidName}，这是妈妈发来的测试提醒。` });
    return { ok: true, tablets: hub.size };
  });

  // ---- state builders --------------------------------------------------------

  function kidState() {
    const s = family.snapshot();
    const hidden = store.getSetting('hidden');
    return {
      now: s.now,
      dateZh: dateZh(s.now.date),
      today: s.today,
      tomorrow: { ...s.tomorrow, dateZh: dateZh(s.tomorrow.date) },
      tasks: s.tasks.map(({ id, title, icon, time, minutes, status }) => ({ id, title, icon, time, minutes, status })),
      alarms: s.alarms.map(({ id, date, time, label }) => ({ id, date, time, label })),
      affinity: { ...s.affinity, stageName: STAGE_NAMES[s.profile.pet]?.[s.affinity.stage - 1] },
      profile: { kidName: s.profile.kidName, girl: s.profile.girl, pet: s.profile.pet },
      girls: Object.fromEntries(Object.entries(GIRLS).filter(([k]) => !hidden.girls.includes(k)).map(([k, g]) => [k, { name: g.name }])),
      pets: Object.fromEntries(Object.entries(PETS).filter(([k]) => !hidden.pets.includes(k)).map(([k, p]) => [k, { name: p.name, kind: p.kind, sound: p.sound, moves: p.moves }])),
      tts: Boolean(config.ttsAppId),
    };
  }

  function parentState() {
    const now = family.now();
    const cfg = store.cycleConfig();
    const days = [];
    for (let i = 0; i < 14; i += 1) {
      const d = family.day(addDays(now.date, i));
      days.push({ date: d.date, dateZh: dateZh(d.date), label: d.label, override: cfg.overrides[d.date] ?? null });
    }
    return {
      now,
      cycle: store.getSetting('cycle'),
      courses: store.getCourses(),
      overrides: store.listOverrides(),
      days,
      templates: store.listTemplates(),
      today: family.tasks(now.date),
      waiting: store.listWaiting(),
      affinity: family.affinity(),
      stages: STAGES,
      ledger: store.affinityLedger(30),
      profile: store.getSetting('profile'),
      hidden: store.getSetting('hidden'),
      quiet: store.getSetting('quiet'),
      voices: Object.fromEntries(Object.entries(GIRLS).map(([k, g]) => [k, (store.getSetting('voices') || {})[k] || g.voice])),
      girls: Object.fromEntries(Object.entries(GIRLS).map(([k, g]) => [k, { name: g.name }])),
      pets: Object.fromEntries(Object.entries(PETS).map(([k, p]) => [k, { name: p.name, kind: p.kind }])),
      devices: store.listDevices(),
      tablets: hub.size,
      usage: { chat: store.usage(now.date, 'chat'), asr: store.usage(now.date, 'asr'), tts: store.usage(now.date, 'tts'), limits: config.limits },
      tts: Boolean(config.ttsAppId),
    };
  }

  // ---- dispatch ----------------------------------------------------------------

  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const a = r.path.split('/');
      const b = pathname.split('/');
      if (a.length !== b.length) continue;
      const params = {};
      if (a.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(b[i])), true) : seg === b[i]))) {
        return { route: r, params };
      }
    }
    return null;
  }

  async function serveStatic(res, pathname) {
    const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
    const file = normalize(join(webDir, rel));
    if (!file.startsWith(webDir + sep) || rel.includes('..')) return false;
    try {
      const st = await stat(file);
      if (!st.isFile()) return false;
      const body = await readFile(file);
      const type = TYPES[extname(file)] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Content-Length': body.length };
      if (type.startsWith('text/html')) {
        headers['Content-Security-Policy'] = CSP;
        headers['Cache-Control'] = 'no-cache';
      } else {
        headers['Cache-Control'] = rel.startsWith('img/') ? 'public, max-age=604800' : 'no-cache';
      }
      res.writeHead(200, headers);
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  return async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const cookies = parseCookies(req.headers.cookie);
    const secure = req.headers['x-forwarded-proto'] === 'https' || config.publicUrl.startsWith('https://');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const pending = [];

    try {
      const m = match(req.method, pathname);
      if (!m) {
        if (req.method === 'GET' && (await serveStatic(res, pathname))) return;
        throw new HttpError(404, '没有这个页面');
      }
      const ctx = { req, res, url, params: m.params, cookies, secure, ip, body: {}, setCookie: (c) => pending.push(c) };
      if (m.route.access === 'parent' && !auth.isParent(cookies)) throw new HttpError(401, '请先登录家长后台');
      if (m.route.access === 'device') {
        ctx.device = auth.device(cookies);
        if (!ctx.device && !auth.isParent(cookies)) throw new HttpError(401, '这台设备还没配对');
      }
      if (req.method === 'POST') ctx.body = await readJson(req, pathname === '/api/asr' ? 2_000_000 : 64_000);

      const out = await m.route.fn(ctx);
      if (out === undefined) return; // streaming response (SSE)
      if (pending.length) res.setHeader('Set-Cookie', pending);
      if (out && out.status && (out.body || out.status === 204)) {
        res.writeHead(out.status, out.body ? { 'Content-Type': out.type, 'Content-Length': out.body.length, 'Cache-Control': 'no-store' } : {});
        res.end(out.body);
        return;
      }
      sendJson(res, 200, out);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[http]', req.method, pathname, err);
      sendJson(res, status, { error: status >= 500 && !err.status ? '服务器出错了，请稍后再试' : err.message });
    }
  };
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '内容太大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求格式不对'));
      }
    });
    req.on('error', reject);
  });
}
