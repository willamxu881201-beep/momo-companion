// HTTP routes. No framework: a small table of (method, path) → handler.
// Pages and assets are served from web/; everything else is JSON under /api.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { addDays, dateZh, isDate, nowIn, timeToMinutes } from './dates.js';
import { KID_COOKIE, KID_TTL_S, PARENT_COOKIE, cookie, parseCookies } from './auth.js';
import { GIRLS, PETS, STAGE_NAMES, STAGE_UP, STAGES } from './characters.js';
import { inQuiet } from './events.js';
import { MIME_EXT } from './files.js';
import { PART_ZH, TYPE_ZH } from './extract.js';
import { ARK_ORIGIN } from './ark.js';
import { warm } from './client.js';
import { Clip, PCM_RATE, SPEECH_ORIGIN, synthesizeStream, transcribe, transcribeFlash, wavRms, wavSeconds } from './speech.js';

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
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
};
const PAGES = { '/': 'kid.html', '/parent': 'parent.html' };
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}


export function createHandler({
  config, store, family, brain, auth, hub, momHub = null, files = null, eyes = null, post = null, notify = null, webDir,
  tts = synthesizeStream, flashAsr = transcribeFlash, arkAsr = transcribe,
}) {
  // Speech is made once per (voice, line): the chat route starts it as soon as the
  // reply exists, and the tablet's /api/tts request joins the same clip and gets the
  // audio as it is made. Finished clips stay for repeats; failed ones are dropped.
  const clips = new Map();
  function speech(raw) {
    const text = String(raw || '').slice(0, 300);
    if (!text || !config.ttsAppId) return null;
    const speaker = family.profile().girlInfo.voice;
    const key = `${speaker}|${text}`;
    let clip = clips.get(key);
    if (!clip) {
      const today = family.now().date;
      if (store.usage(today, 'tts') + text.length > config.limits.ttsCharsPerDay) return null;
      store.addUsage(today, 'tts', text.length);
      clip = new Clip();
      const t0 = Date.now();
      let first = 0;
      const onAudio = (audio) => {
        if (!first) first = Date.now() - t0;
        clip.add(audio);
      };
      tts({ appId: config.ttsAppId, token: config.ttsToken, speaker, text, onAudio })
        .then(() => console.log(`[tts] ${text.length} chars: first audio ${first} ms, whole line ${Date.now() - t0} ms`))
        .catch((err) => {
          console.error('[tts]', err.message);
          clips.delete(key);
        })
        .finally(() => clip.end());
      clips.set(key, clip);
      if (clips.size > 40) clips.delete(clips.keys().next().value); // about 250 KB each
    }
    return clip;
  }
  // Doubao's flash recogniser is far faster from here than Ark. Until the speech app
  // has it enabled, fall back to Ark and only try flash again every ten minutes.
  let flashOffUntil = 0;
  const routes = [];
  // opts.limit: largest JSON body; opts.raw: take the body as bytes, up to that size.
  const on = (method, path, access, fn, opts = {}) => routes.push({ method, path, access, fn, opts });
  const need = (thing, what) => {
    if (!thing) throw new HttpError(503, `${what}还没开通`);
    return thing;
  };

  // ---- public --------------------------------------------------------------

  on('GET', '/healthz', null, () => ({ ok: true }));

  on('POST', '/api/parent/login', null, (ctx) => {
    if (!config.parentPassword) throw new HttpError(503, '服务器还没设置家长密码（PARENT_PASSWORD）');
    const r = auth.login(ctx.ip, String(ctx.body.password || ''));
    if (!r.ok) throw new HttpError(401, r.reason);
    ctx.setCookie(cookie(PARENT_COOKIE, r.token, { maxAge: r.maxAge, secure: ctx.secure }));
    return { ok: true };
  });

  // ---- the kid page (anyone with the kid link; Mom's session works too) ------

  on('GET', '/api/state', 'kid', () => kidState());

  on('GET', '/api/events', 'kid', (ctx) => {
    hub.attach(ctx.req, ctx.res, () => post && post.offer({ fresh: true })); // Mom's words that are still waiting
    return undefined; // response stays open
  });

  on('POST', '/api/chat', 'kid', async (ctx) => {
    const today = family.now().date;
    if (store.usage(today, 'chat') >= config.limits.chatPerDay) {
      return { reply: '今天我们聊了好多啦，我的嗓子要休息一下，明天再陪你聊好不好？', petAction: null, actions: [], limited: true };
    }
    store.addUsage(today, 'chat');
    // The voice for the character's first answer starts while the router still decides;
    // if a tool changes the answer, that clip just goes unused.
    const r = await brain.reply(ctx.kid ? 'kid' : 'parent', ctx.body.text, { onEarly: speech });
    speech(r.reply);
    return { ...r, state: kidState() };
  });

  // A photo or document for the companion to read (from MoMo's page or Mom's): a
  // picture, PDF, Word, Excel, PPT or text file. The body is the file itself; ?name= is
  // its name. She acts on it and says what she did.
  on('POST', '/api/upload', 'kid', async (ctx) => {
    const mime = String(ctx.req.headers['content-type'] || '').split(';')[0].trim();
    if (ctx.body.length < 10) throw new HttpError(400, '文件是空的');
    const who = ctx.kid ? 'kid' : 'mom';
    const t0 = Date.now();
    const r = await need(eyes, '看照片').take({ who, mime, name: ctx.url.searchParams.get('name') || '', buf: ctx.body });
    console.log(`[eyes] ${who} sent ${Math.round(ctx.body.length / 1024)} KB: ${r.kind}, ${r.changes.length} changes, ${Date.now() - t0} ms`);
    speech(r.line);
    return { ...r, state: kidState() };
  }, { raw: 30_000_000 });

  // The tablet's answer to a check-in: { image: JPEG base64, wav?: base64, error? }.
  on('POST', '/api/checks/:id', 'kid', (ctx) => {
    const r = need(eyes, '查看').answer(ctx.params.id, ctx.body);
    if (!r.ok) throw new HttpError(404, '这次查看已经结束了');
    return { ok: true };
  }, { limit: 6_000_000 });

  // The tablet has said one of Mom's messages out loud.
  on('POST', '/api/messages/:id/heard', 'kid', (ctx) => {
    need(post, '传话').heard(ctx.params.id);
    return { ok: true };
  });

  on('POST', '/api/asr', 'kid', async (ctx) => {
    const wav = Buffer.from(String(ctx.body.wav || ''), 'base64');
    const seconds = wavSeconds(wav);
    if (seconds < 0.3) return { text: '', reason: 'short' };
    if (seconds > 30) throw new HttpError(413, '说得太长啦，30 秒以内哦');
    if (wavRms(wav) < 0.008) return { text: '', reason: 'quiet' };
    const today = family.now().date;
    if (store.usage(today, 'asr') >= config.limits.asrPerDay) throw new HttpError(429, '今天的语音次数用完了');
    store.addUsage(today, 'asr');
    const t0 = Date.now();
    const took = (how) => console.log(`[asr] ${how} ${Date.now() - t0} ms for ${seconds.toFixed(1)} s of speech`);
    if (config.ttsAppId && Date.now() > flashOffUntil) {
      try {
        const text = await flashAsr({ appId: config.ttsAppId, token: config.ttsToken, wav });
        took('flash');
        return { text };
      } catch (err) {
        // Not granted, or the keys are refused: stop asking for a while. Anything else
        // (busy, a network hiccup) only sends this one clip to Ark.
        if (err.code === 45000030 || err.status === 401 || err.status === 403) flashOffUntil = Date.now() + 10 * 60000;
        console.warn('[asr] flash recogniser not used:', err.message);
      }
    }
    const text = await arkAsr({ apiKey: config.arkApiKey, model: config.asrModel, wavBase64: wav.toString('base64') });
    took('ark');
    return { text };
  });

  // A kid page just woke up: note its screen and browser, to tune the layout for real devices.
  on('POST', '/api/hello', 'kid', (ctx) => {
    const n = (v) => Math.round(Math.min(Math.max(Number(v) || 0, 0), 10000) * 100) / 100;
    const ua = String(ctx.req.headers['user-agent'] || '').replace(/[^\x20-\x7e]/g, '').slice(0, 240);
    console.log(`[kid] screen ${n(ctx.body.w)}x${n(ctx.body.h)} @${n(ctx.body.dpr)} ${ua}`);
    return { ok: true };
  });

  // The mic just opened: get connections ready while the child talks.
  on('POST', '/api/warm', 'kid', () => {
    warm([ARK_ORIGIN], 2);
    if (config.ttsAppId) warm([SPEECH_ORIGIN]);
    return { ok: true };
  });

  // The voice as it is made: PCM pieces, sent the moment they arrive. 204 means no
  // voice for this line (none configured, over the daily limit, or the service
  // failed), and the tablet uses its own.
  on('POST', '/api/tts', 'kid', async (ctx) => {
    const clip = speech(ctx.body.text);
    if (!clip) return { status: 204 };
    await clip.started();
    if (!clip.chunks.length) return { status: 204 };
    return { status: 200, type: 'application/octet-stream', headers: { 'X-Audio-Format': `pcm_s16le;rate=${PCM_RATE}` }, stream: clip.read() };
  });

  on('POST', '/api/tasks/:id/done', 'kid', (ctx) => {
    const r = family.markDone(Number(ctx.params.id));
    if (!r.ok) throw new HttpError(400, r.reason);
    return { ok: true, state: kidState() };
  });

  on('POST', '/api/profile', 'kid', (ctx) => {
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
    brain.forget(ctx.kid ? 'kid' : 'parent');
    return { ok: true, state: kidState() };
  });

  // ---- Mom -------------------------------------------------------------------

  on('POST', '/api/parent/logout', 'parent', (ctx) => {
    auth.logout(ctx.cookies);
    ctx.setCookie(cookie(PARENT_COOKIE, '', { maxAge: 0, secure: ctx.secure }));
    return { ok: true };
  });

  on('GET', '/api/parent/state', 'parent', () => parentState());

  // Mom's page, live: the day's new events, check-in results, MoMo's messages.
  on('GET', '/api/parent/events', 'parent', (ctx) => {
    need(momHub, '妈妈页面的推送').attach(ctx.req, ctx.res);
    return undefined;
  });

  // Mom talking with the companion.
  on('POST', '/api/parent/chat', 'parent', async (ctx) => {
    const today = family.now().date;
    if (store.usage(today, 'momchat') >= config.limits.momChatPerDay) return { reply: '今天我们聊得太多啦，明天再说吧。', actions: [], limited: true };
    store.addUsage(today, 'momchat');
    const r = await brain.momReply(ctx.body.text);
    speech(r.reply);
    return r;
  });

  // Mom's buttons: look in on MoMo now; pass her a message.
  on('POST', '/api/parent/check', 'parent', (ctx) => {
    const r = need(eyes, '查看').check(String(ctx.body.what || 'look'));
    speech(r.text);
    return r;
  });

  on('POST', '/api/parent/tell', 'parent', (ctx) => {
    const id = need(post, '传话').toKid(ctx.body.text);
    if (!id) throw new HttpError(400, '要说的话是空的');
    return { ok: true, id, tablets: hub.size, quiet: inQuiet(family.now().minutes, store.getSetting('quiet')) };
  });

  // The day's record (newest first), with MoMo's messages Mom hasn't seen yet.
  on('GET', '/api/parent/feed', 'parent', (ctx) => {
    const date = isDate(ctx.url.searchParams.get('date')) ? ctx.url.searchParams.get('date') : family.now().date;
    const events = store.listEvents(date, 80).map((e) => ({
      id: e.id, at: e.at, who: e.who, kind: e.kind, text: e.text, fileId: e.file_kind ? e.file_id : null, doc: e.file_kind === 'doc',
      undo: Boolean(e.data && (e.data.courses || (e.data.added && e.data.added.length)) && !e.data.undone),
      undone: Boolean(e.data && e.data.undone),
    }));
    return { date, events, unread: post ? post.unreadForMom() : [] };
  });

  // A photo or document, for Mom's eyes only; ?download=1 saves it under its own name.
  on('GET', '/api/parent/files/:id', 'parent', (ctx) => {
    const f = need(files, '照片').read(Number(ctx.params.id));
    if (!f) throw new HttpError(404, '这个文件已经过期删除了');
    const name = f.file.name || `文件${f.file.id}.${MIME_EXT[f.file.mime] || 'bin'}`;
    const headers = ctx.url.searchParams.get('download') ? { 'Content-Disposition': `attachment; filename="file.${MIME_EXT[f.file.mime] || 'bin'}"; filename*=UTF-8''${encodeURIComponent(name)}` } : {};
    return { status: 200, type: f.file.mime, body: f.buf, private: true, headers };
  });

  // What the companion made of a document: its title, gist, points, dates, things to do.
  on('GET', '/api/parent/docs/:id', 'parent', (ctx) => {
    const d = need(eyes, '文件').document(ctx.params.id);
    if (!d) throw new HttpError(404, '这个文件已经过期删除了');
    const r = d.result;
    const doc = r.doc ? { ...r.doc, dates: r.doc.dates.map((x) => ({ ...x, dateZh: dateZh(x.date) })) } : null;
    return {
      id: d.id, at: d.at, who: d.who, name: d.name, type: d.type, typeZh: TYPE_ZH[d.type] || '', size: d.parts > 1 && PART_ZH[d.type] ? `${d.parts} ${PART_ZH[d.type]}` : '',
      kind: r.kind, summary: r.summary, doc, cut: Boolean(r.cut || r.partial), chars: d.text.length,
    };
  });

  // Takes back what a photo changed: the old timetable, or the homework tasks it added.
  on('POST', '/api/parent/undo/:id', 'parent', (ctx) => {
    const e = store.getEvent(Number(ctx.params.id));
    if (!e || !e.data || e.data.undone) throw new HttpError(404, '没有可以撤销的');
    family.undo(e.data);
    store.setEventData(e.id, { ...e.data, undone: true });
    family.log('mom', 'undo', `妈妈撤销了：${e.text}`);
    hub.send({ type: 'refresh' });
    return parentState();
  });

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
    const approve = Boolean(ctx.body.approve);
    const r = family.review(Number(ctx.body.id), approve);
    if (!r.ok) throw new HttpError(404, '找不到这件任务');
    // The tablet cheers out loud, except at night when it only updates quietly.
    const asleep = inQuiet(family.now().minutes, store.getSetting('quiet'));
    hub.send(asleep ? { type: 'refresh' } : { type: 'reviewed', approve, title: r.task.title, points: r.points });
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

  // A new key retires the old link and every device that opened it.
  on('POST', '/api/parent/kid-link', 'parent', () => {
    auth.rotateKidKey();
    return parentState();
  });

  on('POST', '/api/parent/test-reminder', 'parent', () => {
    const { kidName } = family.profile();
    hub.send({ type: 'reminder', task: { title: '测试' }, line: `${kidName}，这是妈妈发来的测试提醒。` });
    return { ok: true, tablets: hub.size };
  });

  // Sends a test push to Mom's phone, so she knows it reaches her.
  on('POST', '/api/parent/test-push', 'parent', () => need(notify, '手机推送').test());

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
      affinity: {
        ...s.affinity,
        stageName: STAGE_NAMES[s.profile.pet]?.[s.affinity.stage - 1],
        stageUp: STAGE_UP[s.profile.pet]?.[s.affinity.stage - 2] || null,
      },
      profile: { kidName: s.profile.kidName, girl: s.profile.girl, pet: s.profile.pet },
      girls: Object.fromEntries(Object.entries(GIRLS).filter(([k]) => !hidden.girls.includes(k)).map(([k, g]) => [k, { name: g.name }])),
      pets: Object.fromEntries(Object.entries(PETS).filter(([k]) => !hidden.pets.includes(k)).map(([k, p]) => [k, { name: p.name, kind: p.kind, sound: p.sound, moves: p.moves }])),
      tts: Boolean(config.ttsAppId),
      quiet: inQuiet(s.now.minutes, store.getSetting('quiet')),
      looked: lookedToday(s.now.date), // MoMo sees how often Mom looked in through the camera
    };
  }

  function lookedToday(date) {
    const { n, last } = store.eventCount(date, 'check', { withFile: true });
    return n ? { n, last: nowIn(family.timeZone, new Date(last)).time } : null;
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
      kidKey: auth.kidKey(),
      tablets: hub.size,
      usage: { chat: store.usage(now.date, 'chat'), asr: store.usage(now.date, 'asr'), tts: store.usage(now.date, 'tts'), vision: store.usage(now.date, 'vision'), momchat: store.usage(now.date, 'momchat'), notify: store.usage(now.date, 'notify'), limits: config.limits },
      tts: Boolean(config.ttsAppId),
      push: notify && notify.on ? notify.target.name : null, // the service Mom's phone hears from
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

  async function serveStatic(req, res, pathname) {
    const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
    const file = normalize(join(webDir, rel));
    if (!file.startsWith(webDir + sep) || rel.includes('..')) return false;
    let st;
    try {
      st = await stat(file);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    const type = TYPES[extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = CSP;
      headers['Cache-Control'] = 'no-cache';
    } else {
      headers['Cache-Control'] = /^(img|vid)\//.test(rel) ? 'public, max-age=604800' : 'no-cache';
    }
    // Safari won't play a video unless it can fetch byte ranges of it.
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      } else {
        start = Math.max(0, st.size - Number(range[2]));
      }
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return true;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (!st.size) {
      res.end();
      return true;
    }
    pipeline(createReadStream(file, { start, end }), res, () => {});
    return true;
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
      // The kid link: a valid key becomes a cookie, then the key leaves the address bar.
      if (req.method === 'GET' && pathname === '/' && url.searchParams.has('k')) {
        const headers = { Location: '/', 'Cache-Control': 'no-store' };
        if (auth.keyMatches(url.searchParams.get('k'))) {
          headers['Set-Cookie'] = cookie(KID_COOKIE, auth.kidCookieValue(), { maxAge: KID_TTL_S, secure });
        }
        res.writeHead(302, headers);
        res.end();
        return;
      }
      const m = match(req.method, pathname);
      if (!m) {
        if (req.method === 'GET' && (await serveStatic(req, res, pathname))) return;
        throw new HttpError(404, '没有这个页面');
      }
      const ctx = { req, res, url, params: m.params, cookies, secure, ip, body: {}, setCookie: (c) => pending.push(c) };
      if (m.route.access === 'parent' && !auth.isParent(cookies)) throw new HttpError(401, '请先登录家长后台');
      if (m.route.access === 'kid') {
        ctx.kid = auth.isKid(cookies);
        if (!ctx.kid && !auth.isParent(cookies)) throw new HttpError(401, '这个链接已经失效，请向妈妈要新的链接');
      }
      if (req.method === 'POST') {
        const o = m.route.opts;
        ctx.body = o.raw ? await readRaw(req, o.raw) : await readJson(req, o.limit || (pathname === '/api/asr' ? 2_000_000 : 64_000));
      }

      const out = await m.route.fn(ctx);
      if (out === undefined) return; // streaming response (SSE)
      if (pending.length) res.setHeader('Set-Cookie', pending);
      if (out && out.stream) {
        res.writeHead(out.status, { 'Content-Type': out.type, 'Cache-Control': 'no-store', ...out.headers });
        for await (const piece of out.stream) {
          if (res.destroyed) break; // the tablet stopped listening
          res.write(piece);
        }
        res.end();
        return;
      }
      if (out && out.status && (out.body || out.status === 204)) {
        res.writeHead(out.status, out.body ? { 'Content-Type': out.type, 'Content-Length': out.body.length, 'Cache-Control': out.private ? 'private, max-age=3600' : 'no-store', ...out.headers } : {});
        res.end(out.body);
        return;
      }
      sendJson(res, 200, out);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[http]', req.method, pathname, err);
      if (res.headersSent) res.destroy(); // a stream broke off midway
      else sendJson(res, status, { error: status >= 500 && !err.status ? '服务器出错了，请稍后再试' : err.message });
    }
  };
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '文件太大了'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
