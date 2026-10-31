// Reading pictures with Ark's vision model. Five jobs:
//  - readPicture: a photo or file someone sent (a timetable, the teacher's homework
//    list, a page of homework, or anything else), read into structured facts;
//  - transcribe: the words on a page that is only a picture (a scanned PDF), as text;
//  - lookAt: what the tablet's camera (and a few seconds of sound) shows when Mom
//    looks in on MoMo: what she is doing, whether she is at the piano, how she sits;
//  - pointAt: someone touched a spot on a page in the file viewer and asks about it;
//  - findOnPage: where on a page the thing being talked about is, to mark it.
// Places on a picture are boxes [x1, y1, x2, y2] in thousandths of its width and height
// (top left 0,0; bottom right 1000,1000), as the model gives them.
// Answers come in JSON, checked here so the rest of the server can trust their shape.
// (docs.js reads documents' text into the same shapes.)

import { arkChat } from './ark.js';

export const str = (v, max = 60) => String(v ?? '').trim().slice(0, max);
const int = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

export function parseJson(content) {
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
const PLACE = '千分比坐标：图的左上角是 (0,0)，右下角是 (1000,1000)';

// A place on a picture as the model gave it, checked: [x1, y1, x2, y2] in thousandths,
// or null.
export function box(b) {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => Number.isFinite(Number(v)))) return null;
  const [x1, y1, x2, y2] = b.map((v) => Math.min(1000, Math.max(0, Math.round(Number(v)))));
  return x2 - x1 >= 5 && y2 - y1 >= 5 ? [x1, y1, x2, y2] : null;
}

// What a timetable, a homework list and a page of homework read into (pictures here,
// documents' text in docs.js), and how to tell them apart.
export const READ_SHAPES = [
  ' "timetable":{"cycle":轮换天数,"days":[{"day":1,"courses":[{"name":"课名","note":"备注，没有就空字符串"}]}]},',
  ' "homework":[{"subject":"科目","title":"简短的任务名，12 字以内","detail":"具体内容","due":"YYYY-MM-DD，看不出就空字符串","minutes":预计分钟数}],',
  ' "page":{"subject":"科目","problems":[{"n":"题号","text":"题目原文，算式照抄","done":"孩子已经写的答案，没写就空字符串"}],"hint":"整体的思路提示，说给孩子听，不直接给答案"},',
];
export const READ_RULES = ({ today, tomorrow }) => [
  '- timetable 是学校课程表：按 D1、Day 1、第一天这样轮换，或者按星期一到星期五。每天的课按从上到下的顺序；同一天两节一样的课各写一次。按星期排的课表，cycle 写 5，day 1 是星期一。',
  `- homework_list 是老师布置的作业清单，常见的是家长群的截图、黑板或记作业本的照片。今天是 ${today}，明天是 ${tomorrow}。`,
  '- homework_page 是一页具体的练习题、试卷或作业本。',
];

const READ_PROMPT = ({ kid, today, tomorrow }) =>
  [
    `你在帮一个家庭整理 8 岁的${kid}的学习安排。看这张图（可能是照片、截图或文件的一页），判断它是哪一种，只输出 JSON：`,
    '{"kind":"timetable、homework_list、homework_page 或 other",',
    ' "summary":"一句话说清图里是什么，20 字以内",',
    ...READ_SHAPES,
    ' "unsure":"看不清或拿不准的地方，没有就空字符串"}',
    '规则：',
    ...READ_RULES({ today, tomorrow }),
    '- 不是这三种就是 other。',
    '- 只填和 kind 对应的那一项，其余写空对象或空数组。看不清的字不要猜。',
    `- homework_page 的每道题再加一项 "box":[x1,y1,x2,y2]：这道题（题目和作答的地方）在图上的位置，${PLACE}。`,
  ].join('\n');

// images: data: URLs (one per page). Returns { kind, summary, timetable, homework, page, unsure }
// (a problem's box only when there was one picture: where it is on it).
export async function readPicture({ apiKey, model, images, kidName = '孩子', today, tomorrow }) {
  const r = await arkChat({
    apiKey,
    model,
    json: true,
    maxTokens: 2000,
    timeoutMs: 60000,
    messages: [{ role: 'user', content: [...images.map(imagePart), { type: 'text', text: READ_PROMPT({ kid: kidName, today, tomorrow }) }] }],
  });
  const out = shapeRead(parseJson(r.content));
  if (out.page && images.length > 1) out.page.problems.forEach((p) => delete p.box);
  return out;
}

// The model's reading, checked: kind is timetable, homework_list, homework_page or
// other, and only the part that goes with it is filled in.
export function shapeRead(j) {
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
        .map((p) => ({ n: str(p.n, 8), text: str(p.text, 200), done: str(p.done, 40), box: box(p.box) }))
        .filter((p) => p.text)
        .slice(0, 20),
      hint: str(j.page.hint, 200),
    };
  }
  return out;
}

// The words on one page that is a picture, as plain text (tables as rows with " | ").
export async function transcribe({ apiKey, model, image }) {
  const r = await arkChat({
    apiKey,
    model,
    maxTokens: 3000,
    timeoutMs: 90000,
    messages: [{ role: 'user', content: [imagePart(image), { type: 'text', text: '把这页上的文字原样转写出来：保留段落；表格每行一行，格子之间用 | 隔开；看不清的字写成□。只输出转写的文字，不要解释。' }] }],
  });
  return String(r.content || '').trim();
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
  const j = parseJson(r.content);
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

// Someone touched a spot on a page in the file viewer (x, y: 0…1 of its width and
// height) and asks about it. She answers in her own way, and says where on the page
// the thing she talks about is: { reply, box }. who: 'kid' (8 years old; a homework
// page is helped with, not answered) or 'mom'.
export async function pointAt({ apiKey, model, image, x, y, question = '这是什么？', who = 'kid', kidName = '孩子', girl, title = '', homework = false }) {
  const asker = who === 'kid' ? `8 岁的${kidName}` : `${kidName}的妈妈`;
  const r = await arkChat({
    apiKey,
    model,
    json: true,
    maxTokens: 500,
    timeoutMs: 45000,
    messages: [{
      role: 'user',
      content: [
        imagePart(image),
        {
          type: 'text',
          text: [
            `你是「${girl.name}」，${girl.style}。${asker}在看${title ? `《${title}》的` : ''}这一页，用手指点了图上的一个位置：(${Math.round(x * 1000)}, ${Math.round(y * 1000)})（${PLACE}），问：「${question}」`,
            '只输出 JSON：{"reply":"你的回答","box":[x1,y1,x2,y2]}',
            who === 'kid'
              ? `reply 用孩子听得懂的口语，1 到 3 句，不用表情符号。${homework ? '这是作业：不说出答案，也不说出做法（比如"涂出它的 3/8"这种题，不要说"平均分成 8 份、涂 3 份"）。先照题目说这是第几题、要她做什么，再只问一个小问题，引她自己想第一步（比如问她题目里的某个数表示什么）。她已经写了答案的，告诉她对不对；不对就问一个小问题帮她找到哪里错了。' : ''}`
              : 'reply 简洁清楚，1 到 3 句，不用表情符号。',
            `box 是你说的那部分在图上的位置（${PLACE}）；说不清在哪就写 null。`,
          ].join('\n'),
        },
      ],
    }],
  });
  const j = parseJson(r.content);
  return { reply: str(j.reply, 300), box: box(j.box) };
}

// Where on a page the thing being talked about is (text: what was asked, or said), to
// mark it: [x1, y1, x2, y2] in thousandths, or null when it isn't on the page.
export async function findOnPage({ apiKey, model, image, text }) {
  const r = await arkChat({
    apiKey,
    model,
    json: true,
    maxTokens: 120,
    timeoutMs: 30000,
    messages: [{
      role: 'user',
      content: [
        imagePart(image),
        { type: 'text', text: `下面这句话说的是图上的哪一部分？「${String(text).slice(0, 200)}」\n只输出 JSON：{"box":[x1,y1,x2,y2]}，${PLACE}；图上没有相关的地方就输出 {"box":null}。` },
      ],
    }],
  });
  return box(parseJson(r.content).box);
}
