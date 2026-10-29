// Documents sent to the companion: what they are, and what they say.
//  - readDocument: the model reads the text once. A timetable or a homework list in a
//    document gives the same facts as a photo of one (eyes.js acts on both alike);
//    anything else — a notice, a score sheet, slides from class, a story, Mom's own
//    papers — gets a title, a short gist, its main points, the dates in it and what
//    somebody has to do.
//  - excerpts: later questions are answered from the text itself. It is cut into
//    pieces of a few hundred characters, each knowing its page, sheet or slide, and
//    the pieces that best match the question go to the model (Chinese is matched by
//    pairs of characters, other words whole), so asking about a long document costs
//    little and the answer can say where it found things.

import { arkChat } from './ark.js';
import { READ_RULES, READ_SHAPES, isDate, parseJson, shapeRead, str } from './vision.js';

const READ_CHARS = 24000; // of a document's text, what the model reads at first
const PIECE = 600; // characters in one piece of a document

const DOC_PROMPT = ({ kid, name, today, tomorrow, partial }) =>
  [
    `你在帮一个家庭整理 8 岁的${kid}的学习和生活。下面是一个文件里的文字（文件名：${name || '没有名字'}${partial ? '；文件很长，这里只有开头和结尾' : ''}），【】里是页、工作表或幻灯片的分隔。判断它是哪一种，只输出 JSON：`,
    '{"kind":"timetable、homework_list、homework_page 或 document",',
    ' "summary":"一句话说清这是什么，20 字以内",',
    ...READ_SHAPES,
    ' "doc":{"title":"文件的标题，没有就起一个，20 字以内","type":"通知、成绩、课件、作业要求、阅读材料、表格、工作文件或其他","gist":"两三句话说清主要内容，80 字以内","points":["要点，每条 30 字以内，最多 6 条"],"dates":[{"date":"YYYY-MM-DD","what":"那天发生什么、要做什么，20 字以内"}],"todo":["家长或孩子要做的事，每条 20 字以内，最多 5 条"],"forKid":"用 8 岁孩子听得懂的话说一句这是什么，30 字以内"},',
    ' "unsure":"拿不准的地方，没有就空字符串"}',
    '规则：',
    ...READ_RULES({ today, tomorrow }),
    '- 其他的都是 document：通知、成绩单、课件、文章、表格、家长自己的文件等等，只填 doc。',
    `- 日期按今天 ${today} 推算成 YYYY-MM-DD，推不出来的不写。只依据文件里的文字，不要编造。`,
    '- 只填和 kind 对应的那一项，其余写空对象或空数组。',
  ].join('\n');

// text: from extract.js. Returns readPicture's shape with kind timetable, homework_list,
// homework_page or document; a document has doc: { title, type, gist, points, dates,
// todo, forKid }. partial: the text was too long to read whole at first.
export async function readDocument({ apiKey, model, text, name = '', kidName = '孩子', today, tomorrow }) {
  const partial = text.length > READ_CHARS;
  const body = partial ? `${text.slice(0, READ_CHARS - 4000)}\n……（中间省略）……\n${text.slice(-4000)}` : text;
  const r = await arkChat({
    apiKey,
    model,
    json: true,
    maxTokens: 2500,
    timeoutMs: 120000,
    messages: [{ role: 'user', content: `${DOC_PROMPT({ kid: kidName, name, today, tomorrow, partial })}\n\n文件里的文字：\n${body}` }],
  });
  const j = parseJson(r.content);
  const out = shapeRead(j);
  // A timetable or homework that didn't come out whole is just a document.
  const usable = (out.kind === 'timetable' && out.timetable) || (out.kind === 'homework_list' && out.homework.length) || (out.kind === 'homework_page' && out.page);
  if (!usable) {
    out.kind = 'document';
    out.doc = shapeDoc(j.doc, name);
    if (!out.summary) out.summary = str(out.doc.gist, 60);
  }
  out.partial = partial;
  return out;
}

function shapeDoc(d, name) {
  d = d && typeof d === 'object' ? d : {};
  const list = (v, max, n) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);
  return {
    title: str(d.title, 30) || str(String(name).replace(/\.[^.]+$/, ''), 30) || '文件',
    type: str(d.type, 10),
    gist: str(d.gist, 160),
    points: list(d.points, 60, 6),
    dates: (Array.isArray(d.dates) ? d.dates : [])
      .filter((x) => x && isDate(x.date))
      .map((x) => ({ date: x.date, what: str(x.what, 30) }))
      .filter((x) => x.what)
      .slice(0, 8),
    todo: list(d.todo, 40, 5),
    forKid: str(d.forKid, 60),
  };
}

// ---- answering from the text -----------------------------------------------------------

// A document's text in pieces of about PIECE characters, cut at line ends, each with
// the page, sheet or slide it is on (`where`). A sheet's pieces start with its first
// row, so a row far down still says what its columns are.
export function pieces(text) {
  const out = [];
  let where = '';
  let head = '';
  let lines = [];
  let size = 0;
  const flush = () => {
    if (lines.some((l) => l !== head)) out.push({ where, text: lines.join('\n') });
    lines = head ? [head] : [];
    size = head.length;
  };
  for (const line of String(text).split('\n')) {
    const label = /^【([^】\n]{1,40})】$/.exec(line.trim());
    if (label) {
      flush();
      [head, lines, size, where] = ['', [], 0, label[1]];
      continue;
    }
    if (!line.trim()) continue;
    for (const s of line.length > PIECE ? line.match(new RegExp(`[\\s\\S]{1,${PIECE}}`, 'g')) : [line]) {
      if (size && size + s.length > PIECE) flush();
      lines.push(s);
      size += s.length + 1;
    }
    if (where.startsWith('工作表') && !head) head = line.slice(0, 300);
  }
  flush();
  return out;
}

// What a question and a piece are compared by: pairs of Chinese characters (a single
// one when it stands alone), and whole Latin words and numbers.
function terms(text) {
  const t = String(text).toLowerCase();
  const out = t.match(/[a-z]+|\d+(?:[.:]\d+)*/g) || [];
  for (const run of t.match(/\p{Script=Han}+/gu) || []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

const WHOLE = /总结|概括|归纳|讲了什么|讲的是什么|说了什么|写了什么|主要内容|大意|全文|整体|分析|简介|介绍一下/;

// The parts of a document's text that best answer `question`, within `budget`
// characters: { text, whole }. whole: the document fits and is all there. A question
// about the whole thing ("总结一下") gets pieces from all through it.
export function excerpts(text, question = '', budget = 6000) {
  const all = pieces(text);
  if (all.reduce((n, p) => n + p.text.length + 8, 0) <= budget) return { text: String(text).trim(), whole: true };
  const show = (p) => (p.where ? `（${p.where}）${p.text}` : p.text);
  const asked = [...new Set(terms(question))];
  const docs = all.map((p) => {
    const tf = new Map();
    const ts = terms(p.text);
    for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
    return { tf, len: ts.length || 1 };
  });
  const avg = docs.reduce((n, d) => n + d.len, 0) / docs.length;
  const idf = new Map(asked.map((t) => {
    const df = docs.filter((d) => d.tf.has(t)).length;
    return [t, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
  }));
  // BM25, then a little of each neighbour's score: an answer often runs on into the next piece.
  const raw = docs.map((d) => asked.reduce((s, t) => {
    const f = d.tf.get(t);
    return f ? s + (idf.get(t) * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.len) / avg)) : s;
  }, 0));
  const score = raw.map((s, i) => s + 0.3 * ((raw[i - 1] || 0) + (raw[i + 1] || 0)));
  const order = WHOLE.test(question) || !raw.some((x) => x > 0)
    ? spread(all.length)
    : score.map((x, i) => [x, i]).filter(([x]) => x > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const picked = [];
  let used = 0;
  for (const i of order) {
    const len = show(all[i]).length + 4;
    if (used + len > budget) continue;
    picked.push(i);
    used += len;
  }
  picked.sort((a, b) => a - b);
  return { text: picked.map((i) => show(all[i])).join('\n……\n'), whole: false };
}

// 0..n-1 in an order that covers the whole range early: the start, the end, the
// middle, the quarters, and so on.
function spread(n) {
  const out = [0];
  if (n > 1) out.push(n - 1);
  const spans = [[0, n - 1]];
  while (spans.length && out.length < n) {
    const [a, b] = spans.shift();
    if (b - a < 2) continue;
    const m = (a + b) >> 1;
    out.push(m);
    spans.push([a, m], [m, b]);
  }
  return out;
}

// What the companion said a document was, in a few lines (for the model, when the whole
// of it doesn't fit).
export function aboutDoc(result) {
  const d = result && result.doc;
  if (!d) return result ? result.summary || '' : '';
  return [
    `标题：${d.title}${d.type ? `（${d.type}）` : ''}`,
    d.gist && `大意：${d.gist}`,
    d.points.length && `要点：${d.points.join('；')}`,
    d.dates.length && `日期：${d.dates.map((x) => `${x.date} ${x.what}`).join('；')}`,
    d.todo.length && `要做的：${d.todo.join('；')}`,
  ]
    .filter(Boolean)
    .join('\n');
}
