// The companion's eyes: photos and documents people send her, and check-ins where the
// tablet's camera looks at MoMo because Mom asked.
//  - A photo is read (vision.js) and acted on: a timetable replaces the courses, the
//    teacher's homework list becomes today's tasks (both can be undone from Mom's
//    page), a page of homework is kept in mind for an hour or two so the companion
//    can help MoMo with it.
//  - A document (Word, Excel, PPT, PDF, text) is turned into text (extract.js) and
//    read (docs.js): a timetable or homework list in it is acted on like a photo of
//    one; anything else is summed up, and its text is kept with the file so questions
//    about it are answered from it later (Mom's, any time in the month it is kept;
//    MoMo's, about the one she sent lately). A scan, or a document of screenshots,
//    is read as pictures first.
//  - A check-in asks the tablet for a snapshot (and, for the piano, a few seconds of
//    sound). The tablet says out loud that it is taking it. What the picture shows goes
//    to Mom's page; a poor writing posture gets a gentle word to MoMo too.
// Everything lands in the day's record. What people send is kept until Mom deletes it,
// read or not; check-in snapshots go after a week (files.js).

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pdfPages } from './files.js';
import { findOnPage, lookAt, pointAt, readPicture, transcribe } from './vision.js';
import { GIRLS } from './characters.js';
import { PART_ZH, TYPE_ZH, detect, extract, roughly, visible } from './extract.js';
import { readDocument, searchFiles } from './docs.js';
import { addDays, dateZh } from './dates.js';
import { inQuiet } from './events.js';

const HOMEWORK_TTL_MS = 3 * 3600000; // how long what MoMo just showed stays on the companion's mind
const SCAN_PAGES = 200; // pages of a scanned PDF read, at most
const READ_MAX = 200 * 1024 * 1024; // bigger files are kept but not read
const RETRY_MS = 3000; // a reading that failed is tried once more after this

// What Mom sends is for MoMo to see too (on her page, and to ask the companion about),
// unless it looks like Mom's own papers: her work, bills, contracts, papers about money
// or health. Of what can't be read, only pictures, music and videos. Mom can change it
// on the file's card.
const PRIVATE = /工作|个人|账单|发票|报销|合同|协议|证件|身份证|护照|户口|银行|保险|贷款|工资|税|病历|体检|诊断|密码/;
const forMoMo = (r) => !PRIVATE.test(r.kind === 'document' ? `${r.doc.type} ${r.doc.title}` : r.summary || '');
const MEDIA = /^(image|audio|video)\//;
const MEDIA_NAME = /\.(jpe?g|png|gif|webp|bmp|heic|mp3|m4a|aac|wav|ogg|oga|opus|flac|amr|mp4|m4v|mov|webm|mkv|avi|3gp)$/i;
const playable = (f) => MEDIA.test(f.mime || '') || MEDIA_NAME.test(f.name || '');
// Whether MoMo may see it is decided once, when it is first read (or first kept): read
// again, it stays as it was, which may be as Mom set it.
const undecided = (f) => !f.result || f.result.kind === 'failed' || (f.result.kind === 'stored' && !f.shared);
const CHECK_WAIT_MS = 60000;
export const CHECK_WHAT = { look: '看看在做什么', piano: '看看在不在练琴', posture: '看看坐姿' };
const CHECK_LINES = {
  look: (kid) => `${kid}，妈妈想看看你在做什么，我拍一张照片给妈妈哦。`,
  piano: (kid) => `${kid}，妈妈想听听你练琴，我拍张照片、再听几秒钟哦。`,
  posture: (kid) => `${kid}，妈妈让我看看你的坐姿，我拍一张照片哦。`,
};

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
const refuse = (status, message) => Object.assign(new Error(message), { status });

// Runs fn over the items, at most n at a time; results in order.
async function inTurns(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export class Eyes {
  // read, readDoc, ocr, look, pdf, text, point, find: the model calls and file readers
  // (stand-ins in tests).
  constructor({ family, store, files, hub, momHub, config, read = readPicture, readDoc = readDocument, ocr = transcribe, look = lookAt, pdf = pdfPages, text = extract, point = pointAt, find = findOnPage }) {
    Object.assign(this, { family, store, files, hub, momHub, config, read, readDoc, ocr, look, pdf, text, point, find });
    this.homework = null;
    this.checks = new Map();
    this.reading = new Map(); // file id -> its reading, while it goes on
    this.index = new Map(); // file id -> its pieces, for searching (docs.js)
  }

  kid() {
    return this.family.profile().kidName;
  }

  // Check-ins: counts one, unless over the day's limit. (What people send has no limit.)
  overLimit() {
    const today = this.family.now().date;
    if (this.store.usage(today, 'vision') >= this.config.limits.visionPerDay) return true;
    this.store.addUsage(today, 'vision');
    return false;
  }

  // ---- what people send ----------------------------------------------------------

  // Reads a file just received (files.receive; who sent it is in its record) and acts
  // on it. Resolves to what was made of it — what was seen, what changed, the event to
  // undo it by — with a line for the companion to say. A file that can't be read is
  // kept all the same, and the line says so.
  take(fileId) {
    const f = this.store.getFile(fileId);
    // The models fail now and then: one more try a moment later, before giving up.
    const again = (err) => {
      if (err.status === 415) throw err;
      console.error('[eyes] reading a file failed, trying once more:', err.message);
      return new Promise((r) => setTimeout(r, this.config.retryMs ?? RETRY_MS)).then(() => this.readNow(f));
    };
    const job = this.readNow(f).catch(again).catch((err) => (err.status === 415 ? this.keep(f, err.message) : this.failed(f, err)));
    this.reading.set(f.id, job);
    job.finally(() => this.reading.delete(f.id));
    return job;
  }

  async readNow(f) {
    if (f.bytes > READ_MAX) return this.keep(f, '太大了，我还读不了');
    const buf = readFileSync(this.files.pathOf(f));
    const kind = detect(buf, f.name, f.mime);
    if (!kind) return this.keep(f, `是${roughly(buf, f.name, f.mime)}，我还读不了`);
    if (kind.type === 'image') {
      this.store.setFileKind(f.id, 'photo', kind.mime);
      return this.done(f, await this.readPictures([dataUrl(kind.mime, buf)]));
    }
    this.store.setFileKind(f.id, 'doc', kind.mime);
    let doc;
    try {
      doc = await this.text(buf, kind);
    } catch (err) {
      console.error(`[eyes] could not open a ${kind.type}:`, err.message);
      return this.keep(f, err.missing ? '是服务器还读不了的格式' : err.locked ? '有密码，打不开' : '打不开，可能已经坏了');
    }
    const { r, ocred } = await this.readDocText({ kind, buf, doc, name: f.name });
    Object.assign(r, { type: kind.type, parts: ocred || doc.parts, cut: doc.cut || (ocred && doc.parts > ocred) || false });
    this.store.setFileText(f.id, doc.text);
    this.index.delete(f.id);
    return this.done(f, r);
  }

  done(f, r) {
    this.store.setFileResult(f.id, r);
    this.store.setFileStatus(f.id, 'read');
    const shown = f.who === 'mom' && undecided(f) && this.store.setFileShared(f.id, forMoMo(r));
    const out = this.act({ who: f.who, fileId: f.id, r, name: f.name });
    if (shown) this.offer(f, r);
    return out;
  }

  // Kept, but not read: why, in a few words. It goes in the day's record all the same.
  keep(f, why) {
    why = String(why).replace(/^这个文件/, '');
    if (f.kind !== 'doc') this.store.setFileKind(f.id, 'file');
    this.store.setFileStatus(f.id, 'stored');
    this.store.setFileResult(f.id, { kind: 'stored', summary: why });
    const by = f.who === 'kid' ? this.kid() : '妈妈';
    const named = f.name ? `《${f.name}》` : '一个文件';
    this.family.log(f.who, 'file', `${by}发来${named}（${why}，先存着）`, { fileId: f.id });
    if (f.who === 'mom' && undecided(f) && this.store.setFileShared(f.id, playable(f))) this.offer(f, { kind: 'stored' });
    return { fileId: f.id, kind: 'stored', summary: why, changes: [], undo: null, line: `收到${f.name ? named : '啦'}，我帮你存好了。不过它${why}。` };
  }

  // Mom shared a file with MoMo: it is new on her page, and the companion tells her when
  // she isn't busy (not at quiet time; a timetable or homework list is news of its own).
  offer(f, r) {
    const kind = r && r.kind;
    if (kind === 'timetable' || kind === 'homework_list' || inQuiet(this.family.now().minutes, this.store.getSetting('quiet'))) {
      this.hub.send({ type: 'refresh' });
      return;
    }
    const name = (f.name || '').replace(/\.[a-z0-9]{1,8}$/i, '');
    const what = kind === 'document' && r.doc ? `《${r.doc.title}》` : kind === 'homework_page' ? '一页作业' : kind === 'other' ? '一张照片' : name ? `《${name}》` : '一个文件';
    this.hub.send({ type: 'files', proactive: true, mood: 'happy', line: `${this.kid()}，妈妈给你发来了${what}，点左边的图书馆就能看。` });
  }

  // The models failed: kept, and Mom can have it read again (文件, on her page).
  failed(f, err) {
    console.error('[eyes] reading a file failed:', err.message);
    this.store.setFileStatus(f.id, 'failed');
    this.store.setFileResult(f.id, { kind: 'failed', summary: '这次没读成' });
    const by = f.who === 'kid' ? this.kid() : '妈妈';
    this.family.log(f.who, 'file', `${by}发来${f.name ? `《${f.name}》` : '一个文件'}（这次没读成，先存着）`, { fileId: f.id });
    return { fileId: f.id, kind: 'failed', summary: '这次没读成', changes: [], undo: null, line: '我这会儿没读成这个文件，先帮你存好了，等一下可以再让我读一次。' };
  }

  // A result that came after the upload was already answered: said on the page of
  // whoever sent it.
  tell(who, r) {
    (who === 'kid' ? this.hub : this.momHub).send({ type: 'say', line: r.line, mood: r.kind === 'failed' || r.kind === 'stored' ? null : 'happy', fileId: r.fileId });
  }

  // Files that were being read when the server stopped (or Mom asks again): read now.
  resume(ids = this.store.filesWithStatus('reading').map((f) => f.id)) {
    for (const id of ids) {
      const f = this.store.getFile(id);
      if (!f || this.reading.has(id)) continue;
      this.store.setFileStatus(id, 'reading');
      this.take(id).then((r) => this.tell(f.who, r));
    }
  }

  // What the models make of a document's text (doc.text is replaced by what is read off
  // its pictures, for a scan). Returns { r, ocred: how many pages were read as pictures }.
  async readDocText({ kind, buf, doc, name }) {
    let r = null;
    let ocred = 0;
    // Hardly any text: a scan, or screenshots pasted into a document. Its pages are
    // pictures, and a picture of a timetable or homework reads best as a picture. (A
    // short note with no pictures is just short: it is read as it is.)
    const had = visible(doc.text);
    if (had < 40) {
      let images = [];
      try {
        images = kind.type === 'pdf'
          ? (await this.pdf(buf, { pages: SCAN_PAGES, dpi: 110 })).map((b) => dataUrl('image/jpeg', b))
          : doc.pictures.slice(0, SCAN_PAGES).map((p) => dataUrl(p.mime, p.buf));
      } catch (err) {
        console.error('[eyes] could not draw the pages:', err.message);
      }
      if (!images.length && !had) throw refuse(415, '这个文件里面没有能读的文字');
      if (images.length && images.length <= 2) {
        r = await this.readPictures(images);
        if (r.kind === 'other') r = null;
      }
      if (images.length && !r) {
        let failed = 0;
        const pages = await inTurns(images, 3, (image) => this.ocr({ apiKey: this.config.arkApiKey, model: this.config.visionModel, image }).catch(() => {
          failed += 1;
          return '';
        }));
        if (failed === pages.length) throw new Error('every page failed to be read');
        const seen = pages.map((t, i) => `【第${i + 1}页】\n${t}`).join('\n');
        if (visible(seen) > had) {
          doc.text = seen;
          ocred = pages.length;
        } else if (!had) throw refuse(415, '这个文件里面没有能读的文字');
      }
    }
    if (!r) {
      const now = this.family.now();
      r = await this.readDoc({
        apiKey: this.config.arkApiKey,
        model: this.config.docModel || this.config.visionModel,
        noteModel: this.config.routerModel,
        text: doc.text,
        name,
        kidName: this.kid(),
        today: now.date,
        tomorrow: addDays(now.date, 1),
      });
    }
    return { r, ocred };
  }

  readPictures(images) {
    const now = this.family.now();
    return this.read({ apiKey: this.config.arkApiKey, model: this.config.visionModel, images, kidName: this.kid(), today: now.date, tomorrow: addDays(now.date, 1) });
  }

  // Does what a photo or document asks for, records it, and says so.
  act({ who, fileId, r, name = '' }) {
    const now = this.family.now();
    const kid = this.kid();
    const out = { fileId, kind: r.kind, summary: r.summary, unsure: r.unsure, changes: [], undo: null };
    let data = null;
    if (r.kind === 'timetable' && r.timetable) {
      data = this.family.applyTimetable(r.timetable);
      out.changes = r.timetable.days.map((d) => `D${d.day}：${d.courses.map((c) => c.name).join('、')}`);
      // A new cycle length moves every day's D number: Mom has to say which day is which.
      if (r.timetable.cycle && r.timetable.cycle !== data.cycleLength) out.cycle = { from: data.cycleLength, to: r.timetable.cycle };
    } else if (r.kind === 'homework_list' && r.homework.length) {
      const { date, added } = this.family.addHomework(r.homework, { source: `file:${fileId}` });
      data = { added: added.map((t) => t.id) };
      out.changes = added.map((t) => t.title);
      out.date = date;
    } else if (r.kind === 'homework_page' && r.page) {
      this.homework = { at: Date.now(), page: r.page, fileId };
      out.page = r.page;
    } else if (r.kind === 'document') {
      out.doc = r.doc;
    }
    const by = who === 'kid' ? kid : '妈妈';
    const file = r.type ? `${TYPE_ZH[r.type] || ''}文件` : '照片';
    const what = {
      timetable: `${by}发来课程表，已更新 ${out.changes.length} 天的课${out.cycle ? `；一轮从 ${out.cycle.from} 天变成 ${out.cycle.to} 天，请到「管理 → 课表」核对今天是 D 几` : ''}`,
      homework_list: out.changes.length ? `${by}发来作业清单，加了 ${out.changes.length} 件作业：${out.changes.join('、')}` : `${by}发来作业清单，里面的作业都已经在任务里了`,
      homework_page: `${by}拍了作业：${r.summary}`,
      document: `${by}发来${file}《${r.doc ? r.doc.title : name}》：${r.doc && r.doc.gist ? r.doc.gist : r.summary}`,
      other: `${by}发来${file}：${r.summary}`,
    }[r.kind];
    const eventId = this.family.log(who, r.kind === 'other' ? 'photo' : r.kind, what, { fileId, data });
    if (data) out.undo = eventId;
    out.line = this.lineFor(who, r, out);
    if (data) this.hub.send({ type: 'refresh' });
    // Homework Mom sent: the tablet tells MoMo (not at quiet time).
    if (who === 'mom' && r.kind === 'homework_list' && out.changes.length && !inQuiet(now.minutes, this.store.getSetting('quiet'))) {
      this.hub.send({ type: 'say', line: `${kid}，妈妈把作业发给我啦：${out.changes.join('、')}。我都记在任务里了，一件一件来！`, mood: 'happy' });
    }
    return out;
  }

  // What the companion says about it, to MoMo or to Mom.
  lineFor(who, r, out) {
    const kid = this.kid();
    const toKid = who === 'kid';
    switch (r.kind) {
      case 'timetable':
        if (toKid) return `我看到课程表啦，已经记下 ${out.changes.length} 天的课，以后问我上什么课就行！${out.cycle ? '轮换的天数变了，我请妈妈核对一下今天是第几天。' : ''}`;
        return `课程表已经更新好了，一共 ${out.changes.length} 天。${out.cycle ? `一轮从 ${out.cycle.from} 天变成了 ${out.cycle.to} 天，请到「管理 → 课表」核对一下今天是 D 几。` : ''}${r.unsure ? `有些地方没看清：${r.unsure}，您再核对一下。` : ''}`;
      case 'homework_list':
        if (!out.changes.length) return toKid ? '这些作业我都已经记下啦。' : '这些作业之前都已经加过了。';
        return toKid
          ? `我帮你把今天的作业记下来啦：${out.changes.join('、')}。一件一件来，加油！`
          : `已经把 ${out.changes.length} 件作业加到${out.date === this.family.now().date ? '今天' : dateZh(out.date)}的任务里：${out.changes.join('、')}。`;
      case 'homework_page': {
        const n = r.page.problems.length;
        return toKid
          ? `我看到啦，是${r.page.subject || ''}作业${n ? `，一共 ${n} 道题` : ''}。哪道题不会，就跟我说是第几题，我们一起想！`
          : `这是一页${r.page.subject || ''}作业${n ? `，${n} 道题` : ''}。${kid}问我的时候，我会一步一步引导她，不直接给答案。`;
      }
      case 'document': {
        const d = r.doc;
        if (toKid) return `我看完啦！${d.forKid || d.gist || d.title}有不懂的地方，可以问我哦。`;
        const size = r.parts > 1 && PART_ZH[r.type] ? `（${r.parts} ${PART_ZH[r.type]}）` : '';
        // A couple of dates are worth saying out loud; the rest are on the document's card.
        const dates = d.dates.length ? `里面的日子：${d.dates.slice(0, 2).map((x) => `${dateZh(x.date).replace(/ .*/, '')}${x.what}`).join('，')}${d.dates.length > 2 ? '，还有几个写在卡片上' : ''}。` : '';
        const long = r.cut ? '文件太长了，我只存下了前面的一大半。' : r.sections > 1 ? `文件很长，我一段一段都读完了，问到哪儿我再翻原文。` : '';
        return `我看完了《${d.title}》${size}。${d.gist}${dates}${long}想知道里面的什么，直接问我。`;
      }
      default:
        return toKid ? `我看到了：${r.summary}。` : `我看了一下：${r.summary}。`;
    }
  }

  // The page of homework MoMo showed lately, while it is fresh.
  currentHomework() {
    return this.homework && Date.now() - this.homework.at < HOMEWORK_TTL_MS ? this.homework.page : null;
  }

  // ---- documents, for answering from ---------------------------------------------

  // Documents that were read, newest first: { id, at, who, name, type, parts, result }.
  // who: only those this person sent.
  documents({ who = null, since = 0, limit = 8 } = {}) {
    return this.store.listDocs({ since, who, limit }).filter((d) => d.result && d.result.type).map((d) => ({ ...d, type: d.result.type, parts: d.result.parts }));
  }

  // One document with its text, or null when there is none (gone, or never read).
  document(id) {
    const f = this.store.getFile(Number(id));
    if (!f || f.kind !== 'doc' || !f.result || !f.result.type) return null;
    return { id: f.id, at: f.at, who: f.who, name: f.name, type: f.result.type, parts: f.result.parts, result: f.result, shared: Boolean(f.shared), text: this.store.getFileText(f.id) || '' };
  }

  // The documents that best match a question, best first: [{ id, name, who, at, result,
  // score, where, snippet }]. forKid: only those the companion may use with MoMo.
  search(query, { forKid = false, limit = 5 } = {}) {
    const files = this.store.textFiles({ forKid });
    const hits = searchFiles(files, query, { index: this.index, textOf: (id) => this.store.getFileText(id) || '', limit });
    return hits.map((h) => ({ ...files.find((f) => f.id === h.id), ...h }));
  }

  // A file is gone, or read again: it is cut up afresh next time it is searched.
  forgetText(id) {
    this.index.delete(id);
  }

  // MoMo opened one of her files on her page: when she asks about "this", it's that one;
  // and a page of homework is the one she is helped with.
  open(id) {
    this.opened = { id: Number(id), at: Date.now() };
    const f = this.store.getFile(Number(id));
    if (f && f.result && f.result.kind === 'homework_page' && f.result.page) this.homework = { at: Date.now(), page: f.result.page, fileId: f.id };
  }

  // The document on MoMo's mind, while fresh: the one she opened on her page, or the one
  // she sent, whichever was later (not a timetable or homework: those are acted on).
  // opened: she is looking at it rather than just sent it.
  currentDocument() {
    const since = Date.now() - HOMEWORK_TTL_MS;
    const [sent] = this.documents({ who: 'kid', since, limit: 1 });
    const o = this.opened;
    if (o && o.at > since && (!sent || o.at > sent.at)) {
      const d = this.document(o.id);
      if (d && d.result.kind === 'document' && (d.who === 'kid' || d.shared)) return { ...d, opened: true };
    }
    return sent && sent.result.kind === 'document' ? this.document(sent.id) : null;
  }

  // ---- pointing at a page (the file viewer) ------------------------------------------

  // Someone touched a spot on a page (x, y: 0…1) and asks about it: { reply, box }. A
  // quicker model than reading: someone is waiting with a finger on the page.
  pointAt({ image, x, y, question, who, title, homework }) {
    const p = this.family.profile();
    return this.point({ apiKey: this.config.arkApiKey, model: this.config.pointModel, image, x, y, question, who, kidName: p.kidName, girl: GIRLS[p.girl], title, homework });
  }

  // Where on a page what is being talked about is: a box, or null.
  findOnPage({ image, text }) {
    return this.find({ apiKey: this.config.arkApiKey, model: this.config.pointModel, image, text });
  }

  // ---- check-ins -----------------------------------------------------------------

  // Asks the tablet for a look. The answer comes later, to Mom's page and the record.
  check(what = 'look', by = 'mom') {
    if (!CHECK_LINES[what]) what = 'look';
    if (!this.hub.size) return { ok: false, text: `平板现在没打开，我看不到${this.kid()}。` };
    if (this.overLimit()) return { ok: false, text: '今天看得太多次啦，明天再看吧。' };
    const id = randomBytes(6).toString('hex');
    const timer = setTimeout(() => this.finish(id, { ok: false, text: '平板没有回应，可能没人在用平板。' }), CHECK_WAIT_MS);
    timer.unref?.();
    this.checks.set(id, { what, by, timer });
    this.hub.send({ type: 'check', id, what, listen: what === 'piano', line: CHECK_LINES[what](this.kid()) });
    return { ok: true, id, pending: true, text: `我去${CHECK_WHAT[what]}，马上告诉你。` };
  }

  // The look is over: what it saw, or why it saw nothing, goes into the day's record
  // (so Mom finds it even if her page was closed) and to Mom's page.
  finish(id, result, data = null) {
    const c = this.checks.get(id);
    if (!c) return;
    this.checks.delete(id);
    clearTimeout(c.timer);
    this.family.log('tablet', 'check', `${CHECK_WHAT[c.what]}：${result.text}`, { fileId: result.fileId || null, data });
    this.momHub.send({ type: 'check', id, what: c.what, ...result });
    if (result.fileId) this.hub.send({ type: 'refresh' }); // MoMo's page counts Mom's looks
  }

  // The tablet's answer: a JPEG (base64), maybe a WAV, or the reason it couldn't. The
  // tablet hears back at once; what the picture shows reaches Mom when it is read
  // (`done` settles then).
  answer(id, { image, wav, error }) {
    const c = this.checks.get(id);
    if (!c) return { ok: false, reason: 'gone' };
    if (error || !image) {
      this.finish(id, { ok: false, text: error === 'camera' ? '平板的摄像头没打开（可能没给权限），这次没拍到。' : '这次没拍到照片。' });
      return { ok: true, done: Promise.resolve() };
    }
    const buf = Buffer.from(String(image), 'base64');
    if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) {
      this.finish(id, { ok: false, text: '这次的照片坏了，没看成。' });
      return { ok: true, done: Promise.resolve() };
    }
    clearTimeout(c.timer); // reading it has its own deadline
    const fileId = this.files.save({ who: 'tablet', kind: 'check', mime: 'image/jpeg', buf });
    return { ok: true, done: this.see(id, c, fileId, buf, wav) };
  }

  async see(id, c, fileId, buf, wav) {
    let r;
    try {
      r = await this.look({ apiKey: this.config.arkApiKey, model: this.config.visionModel, image: dataUrl('image/jpeg', buf), wav: wav || undefined, what: c.what, kidName: this.kid() });
    } catch (err) {
      console.error('[eyes] look failed:', err.message);
      this.finish(id, { ok: false, text: '照片拍到了，但我一时没看明白，您可以点开照片看看。', fileId });
      return;
    }
    this.store.setFileResult(fileId, r);
    if (c.what === 'posture' && r.posture.ok === false && r.posture.tip) this.hub.send({ type: 'say', line: r.posture.tip, mood: 'happy' });
    this.finish(id, { ok: true, text: r.summary || r.doing || '看到了。', fileId, seen: r.seen, piano: r.piano, posture: r.posture }, r);
  }
}
