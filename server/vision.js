// Reading pictures with Ark's vision model. Two jobs:
//  - readPicture: a photo or file someone sent (a timetable, the teacher's homework
//    list, a page of homework, or anything else), read into structured facts;
//  - lookAt: what the tablet's camera (and a few seconds of sound) shows when Mom
//    looks in on MoMo: what she is doing, whether she is at the piano, how she sits.
// Both answer in JSON, checked here so the rest of the server can trust its shape.

import { arkChat } from './ark.js';

const str = (v, max = 60) => String(v ?? '').trim().slice(0, max);
const int = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function parse(content) {
  const text = String(content || '');
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('the vision model did not answer in JSON');
  }
}

const imagePart = (dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } });

const READ_PROMPT = ({ kid, today, tomorrow }) =>
  [
    `你在帮一个家庭整理 8 岁的${kid}的学习安排。看这张图（可能是照片、截图或文件的一页），判断它是哪一种，只输出 JSON：`,
    '{"kind":"timetable、homework_list、homework_page 或 other",',
    ' "summary":"一句话说清图里是什么，20 字以内",',
    ' "timetable":{"cycle":轮换天数,"days":[{"day":1,"courses":[{"name":"课名","note":"备注，没有就空字符串"}]}]},',
    ' "homework":[{"subject":"科目","title":"简短的任务名，12 字以内","detail":"具体内容","due":"YYYY-MM-DD，看不出就空字符串","minutes":预计分钟数}],',
    ' "page":{"subject":"科目","problems":[{"n":"题号","text":"题目原文，算式照抄","done":"孩子已经写的答案，没写就空字符串"}],"hint":"整体的思路提示，说给孩子听，不直接给答案"},',
    ' "unsure":"看不清或拿不准的地方，没有就空字符串"}',
    '规则：',
    '- timetable 是学校课程表：按 D1、Day 1、第一天这样轮换，或者按星期一到星期五。每天的课按从上到下的顺序；同一天两节一样的课各写一次。按星期排的课表，cycle 写 5，day 1 是星期一。',
    `- homework_list 是老师布置的作业清单，常见的是家长群的截图、黑板或记作业本的照片。今天是 ${today}，明天是 ${tomorrow}。`,
    '- homework_page 是一页具体的练习题、试卷或作业本。',
    '- 不是这三种就是 other。',
    '- 只填和 kind 对应的那一项，其余写空对象或空数组。看不清的字不要猜。',
  ].join('\n');

// images: data: URLs (one per page). Returns { kind, summary, timetable, homework, page, unsure }.
export async function readPicture({ apiKey, model, images, kidName = '孩子', today, tomorrow }) {
  const r = await arkChat({
    apiKey,
    model,
    json: true,
    maxTokens: 2000,
    timeoutMs: 60000,
    messages: [{ role: 'user', content: [...images.map(imagePart), { type: 'text', text: READ_PROMPT({ kid: kidName, today, tomorrow }) }] }],
  });
  const j = parse(r.content);
  const kind = ['timetable', 'homework_list', 'homework_page'].includes(j.kind) ? j.kind : 'other';
  const out = { kind, summary: str(j.summary, 60), unsure: str(j.unsure, 120), timetable: null, homework: [], page: null };
  if (kind === 'timetable' && Array.isArray(j.timetable?.days)) {
    const days = j.timetable.days
      .map((d) => ({
        day: int(d.day, 1, 10, 0),
        courses: (Array.isArray(d.courses) ? d.courses : [])
          .map((c) => ({ name: str(c.name, 20), note: str(c.note, 30) }))
          .filter((c) => c.name)
          .slice(0, 12),
      }))
      .filter((d) => d.day && d.courses.length);
    const cycle = int(j.timetable.cycle, 2, 10, Math.max(...days.map((d) => d.day), 0));
    if (days.length) out.timetable = { cycle, days };
  }
  if (kind === 'homework_list' && Array.isArray(j.homework)) {
    out.homework = j.homework
      .map((h) => ({
        subject: str(h.subject, 8),
        title: str(h.title, 20),
        detail: str(h.detail, 80),
        due: isDate(h.due) ? h.due : '',
        minutes: int(h.minutes, 5, 120, 20),
      }))
      .filter((h) => h.title)
      .slice(0, 10);
  }
  if (kind === 'homework_page' && j.page) {
    out.page = {
      subject: str(j.page.subject, 8),
      problems: (Array.isArray(j.page.problems) ? j.page.problems : [])
        .map((p) => ({ n: str(p.n, 8), text: str(p.text, 200), done: str(p.done, 40) }))
        .filter((p) => p.text)
        .slice(0, 20),
      hint: str(j.page.hint, 200),
    };
  }
  return out;
}

const QUESTIONS = {
  look: '她现在在做什么',
  piano: '她是不是在弹钢琴',
  posture: '她写作业的坐姿对不对',
};

const LOOK_PROMPT = ({ kid, what, heard }) =>
  [
    `这是平板电脑的摄像头刚拍的照片${heard ? '，还有同时录下的几秒钟声音' : ''}，拍的是 8 岁的${kid}。妈妈想知道：${QUESTIONS[what] || QUESTIONS.look}。只输出 JSON：`,
    '{"seen":照片里能不能看到孩子(true/false),',
    ' "doing":"她在做什么，15 字以内",',
    ' "piano":是否在弹钢琴(true/false/null，看不出就 null),',
    ' "posture":{"ok":坐姿好不好(true/false/null),"issues":["具体问题，比如 头太低、眼睛离本子太近、趴在桌上、身子歪"],"tip":"一句温柔的提醒，说给孩子听，20 字以内"},',
    ' "summary":"给妈妈的一句话，30 字以内"}',
    '规则：看不到孩子时 seen 为 false，summary 说看不到。坐姿只在她坐着写字或看书时判断，否则 ok 为 null、issues 为空。',
    heard ? '声音里有没有钢琴声也算判断依据。' : '',
    '只说照片里看得到的，不要猜。',
  ]
    .filter(Boolean)
    .join('\n');

// image: a data: URL; wav: base64 WAV (optional). Returns { seen, doing, piano, posture, summary }.
export async function lookAt({ apiKey, model, image, wav, what = 'look', kidName = '孩子' }) {
  const content = [imagePart(image)];
  if (wav) content.push({ type: 'input_audio', input_audio: { data: wav, format: 'wav' } });
  content.push({ type: 'text', text: LOOK_PROMPT({ kid: kidName, what, heard: Boolean(wav) }) });
  const r = await arkChat({ apiKey, model, json: true, maxTokens: 400, timeoutMs: 45000, messages: [{ role: 'user', content }] });
  const j = parse(r.content);
  const tri = (v) => (v === true || v === false ? v : null);
  const p = j.posture || {};
  return {
    seen: j.seen !== false,
    doing: str(j.doing, 30),
    piano: tri(j.piano),
    posture: {
      ok: tri(p.ok),
      issues: (Array.isArray(p.issues) ? p.issues : []).map((s) => str(s, 20)).filter(Boolean).slice(0, 4),
      tip: str(p.tip, 40),
    },
    summary: str(j.summary, 60),
  };
}
