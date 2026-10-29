// The companion's eyes: photos and files people send her, and check-ins where the
// tablet's camera looks at MoMo because Mom asked.
//  - A photo is read (vision.js) and acted on: a timetable replaces the courses, the
//    teacher's homework list becomes today's tasks (both can be undone from Mom's
//    page), a page of homework is kept in mind for an hour or two so the companion
//    can help MoMo with it.
//  - A check-in asks the tablet for a snapshot (and, for the piano, a few seconds of
//    sound). The tablet says out loud that it is taking it. What the picture shows goes
//    to Mom's page; a poor writing posture gets a gentle word to MoMo too.
// Everything lands in the day's record. Pictures are kept a week (files.js).

import { randomBytes } from 'node:crypto';
import { pdfPages } from './files.js';
import { lookAt, readPicture } from './vision.js';
import { addDays, dateZh } from './dates.js';
import { inQuiet } from './events.js';

const HOMEWORK_TTL_MS = 3 * 3600000;
const CHECK_WAIT_MS = 60000;
export const CHECK_WHAT = { look: '看看在做什么', piano: '看看在不在练琴', posture: '看看坐姿' };
const CHECK_LINES = {
  look: (kid) => `${kid}，妈妈想看看你在做什么，我拍一张照片给妈妈哦。`,
  piano: (kid) => `${kid}，妈妈想听听你练琴，我拍张照片、再听几秒钟哦。`,
  posture: (kid) => `${kid}，妈妈让我看看你的坐姿，我拍一张照片哦。`,
};

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

export class Eyes {
  constructor({ family, store, files, hub, momHub, config, read = readPicture, look = lookAt, pdf = pdfPages }) {
    Object.assign(this, { family, store, files, hub, momHub, config, read, look, pdf });
    this.homework = null;
    this.checks = new Map();
  }

  kid() {
    return this.family.profile().kidName;
  }

  overLimit() {
    const today = this.family.now().date;
    if (this.store.usage(today, 'vision') >= this.config.limits.visionPerDay) return true;
    this.store.addUsage(today, 'vision');
    return false;
  }

  // ---- photos and files --------------------------------------------------------

  // who: kid | mom. Returns what was seen, what changed, the event to undo it by, and
  // a line for the companion to say.
  async take({ who, mime, name = '', buf }) {
    if (this.overLimit()) throw Object.assign(new Error('今天看的照片太多啦，明天再发吧'), { status: 429 });
    const fileId = this.files.save({ who, kind: 'photo', mime, name, buf });
    let images;
    if (mime === 'application/pdf') {
      try {
        images = (await this.pdf(buf)).map((b) => dataUrl('image/jpeg', b));
      } catch (err) {
        throw Object.assign(new Error(err.missing ? '服务器还不能读 PDF，请拍照或截图发过来' : '这个 PDF 打不开'), { status: 415 });
      }
      if (!images.length) throw Object.assign(new Error('这个 PDF 是空的'), { status: 415 });
    } else images = [dataUrl(mime, buf)];

    const now = this.family.now();
    const kid = this.kid();
    const r = await this.read({
      apiKey: this.config.arkApiKey,
      model: this.config.visionModel,
      images,
      kidName: kid,
      today: now.date,
      tomorrow: addDays(now.date, 1),
    });
    this.store.setFileResult(fileId, r);

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
    }
    const by = who === 'kid' ? kid : '妈妈';
    const what = {
      timetable: `${by}发来课程表，已更新 ${out.changes.length} 天的课${out.cycle ? `；一轮从 ${out.cycle.from} 天变成 ${out.cycle.to} 天，请到「管理 → 课表」核对今天是 D 几` : ''}`,
      homework_list: out.changes.length ? `${by}发来作业清单，加了 ${out.changes.length} 件作业：${out.changes.join('、')}` : `${by}发来作业清单，里面的作业都已经在任务里了`,
      homework_page: `${by}拍了作业：${r.summary}`,
      other: `${by}发来照片：${r.summary}`,
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
      default:
        return toKid ? `我看到了：${r.summary}。` : `我看了一下：${r.summary}。`;
    }
  }

  // The page of homework MoMo showed lately, while it is fresh.
  currentHomework() {
    return this.homework && Date.now() - this.homework.at < HOMEWORK_TTL_MS ? this.homework.page : null;
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
