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

const READ_CHARS = 24000; // a document this long is read in one go
const SECTION = 16000; // a longer one is read a section of about this many characters at a time
const PIECE = 600; // characters in one piece of a document

const DOC_PROMPT = ({ kid, name, today, tomorrow, long }) =>
  [
    `你在帮一个家庭整理 8 岁的${kid}的学习和生活。下面是一个文件里的文字（文件名：${name || '没有名字'}${long ? '；文件很长，下面是它开头的原文，和你一段一段读过的每一部分的要点' : ''}），【】里是页、工作表或幻灯片的分隔。判断它是哪一种，只输出 JSON：`,
    '{"kind":"timetable、homework_list、homework_page 或 document",',
    ' "summary":"一句话说清这是什么，20 字以内",',
    ...READ_SHAPES,
    ' "doc":{"title":"文件的标题，没有就起一个，20 字以内","type":"通知、成绩、课件、作业要求、阅读材料、表格、工作文件、个人文件（账单、合同、证件、病历等）或其他","gist":"两三句话说清主要内容，80 字以内","points":["要点，每条 30 字以内，最多 6 条"],"dates":[{"date":"YYYY-MM-DD","what":"那天发生什么、要做什么，20 字以内"}],"todo":["家长或孩子要做的事，每条 20 字以内，最多 5 条"],"forKid":"用 8 岁孩子听得懂的话说一句这是什么，30 字以内"},',
    ' "unsure":"拿不准的地方，没有就空字符串"}',
    '规则：',
    ...READ_RULES({ today, tomorrow }),
    '- 其他的都是 document：通知、成绩单、课件、文章、表格、家长自己的文件等等，只填 doc。',
    `- 日期按今天 ${today} 推算成 YYYY-MM-DD，推不出来的不写。只依据文件里的文字，不要编造。`,
    '- 只填和 kind 对应的那一项，其余写空对象或空数组。',
  ].join('\n');

// text: from extract.js. Returns readPicture's shape with kind timetable, homework_list,
// homework_page or document; a document has doc: { title, type, gist, points, dates,
// todo, forKid }. A long document is read all through: a section at a time for notes
// (noteModel, a few at once), then once more from its beginning and all those notes.
// chat: arkChat (a stand-in in tests).
export async function readDocument({ apiKey, model, noteModel = model, text, name = '', kidName = '孩子', today, tomorrow, chat = arkChat }) {
  let body = text;
  let sections = 0;
  if (text.length > READ_CHARS) {
    const parts = sectionsOf(text);
    sections = parts.length;
    let failed = 0;
    const notes = await inTurns(parts, 3, (part, i) =>
      chat({
        apiKey,
        model: noteModel,
        maxTokens: 500,
        timeoutMs: 120000,
        messages: [{ role: 'user', content: `下面是一个长文件《${name || '没有名字'}》的第 ${i + 1}/${parts.length} 部分。用几句话写下这部分讲了什么，记下重要的事实、数字、日期和要做的事，不超过 300 字，只依据这部分的文字：\n\n${part}` }],
      }).then((r) => String(r.content || '').trim(), () => {
        failed += 1;
        return '（这部分没读成）';
      }));
    if (failed === parts.length) throw new Error('no section of the document could be read');
    body = `${text.slice(0, 8000)}\n……\n【每一部分的要点】\n${notes.map((n, i) => `第 ${i + 1} 部分：${n}`).join('\n')}`;
  }
  const r = await chat({
    apiKey,
    model,
    json: true,
    maxTokens: 2500,
    timeoutMs: 120000,
    messages: [{ role: 'user', content: `${DOC_PROMPT({ kid: kidName, name, today, tomorrow, long: sections > 0 })}\n\n文件里的文字：\n${body}` }],
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
  out.sections = sections;
  return out;
}

// A long text in sections of about SECTION characters, cut at line ends.
function sectionsOf(text) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length > SECTION && cur) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line.slice(0, SECTION);
  }
  if (cur.trim()) out.push(cur);
  return out;
}

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

function shapeDoc(d, name) {
  d = d && typeof d === 'object' ? d : {};
  const list = (v, max, n) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);
  return {
    title: str(d.title, 30) || str(String(name).replace(/\.[^.]+$/, ''), 30) || '文件',
    type: str(String(d.type || '').replace(/[（(].*$/, ''), 10), // "个人文件（账单…）" -> "个人文件"
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

// ---- searching all of them ------------------------------------------------------------

function cut(text) {
  return pieces(text).map((p) => {
    const tf = new Map();
    const ts = terms(p.text);
    for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
    return { where: p.where, text: p.text, tf, len: ts.length || 1 };
  });
}

// The files that best match a question, among `files` ({ id, name, result }; textOf(id)
// gives a file's words): each scored by its best piece (BM25 over all the files' pieces
// together, so a word common everywhere counts for little) and by its name and summary.
// index: kept by the caller (file id -> its pieces), so each file is cut up once.
// Returns [{ id, score, where, snippet }], best first. The words of asking ("什么",
// "多少") say nothing of which file is meant, and are left out.
const ASKING = new Set(['什么', '怎么', '多少', '哪个', '哪些', '哪里', '有什', '是什', '为什', '一下']);

export function searchFiles(files, query, { index = new Map(), textOf, limit = 5 } = {}) {
  const asked = [...new Set(terms(query))].filter((t) => !ASKING.has(t));
  if (!asked.length || !files.length) return [];
  const all = [];
  for (const f of files) {
    if (!index.has(f.id)) index.set(f.id, cut(textOf(f.id)));
    for (const p of index.get(f.id)) all.push({ id: f.id, p });
  }
  if (!all.length) return [];
  const avg = all.reduce((n, x) => n + x.p.len, 0) / all.length;
  const idf = new Map(asked.map((t) => {
    const df = all.filter((x) => x.p.tf.has(t)).length;
    return [t, Math.log(1 + (all.length - df + 0.5) / (df + 0.5))];
  }));
  const best = new Map(); // file id -> { score, piece }
  for (const { id, p } of all) {
    const score = asked.reduce((s, t) => {
      const f = p.tf.get(t);
      return f ? s + (idf.get(t) * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * p.len) / avg)) : s;
    }, 0);
    if (score > (best.get(id)?.score || 0)) best.set(id, { score, p });
  }
  const hits = files.map((f) => {
    const about = new Set(terms(`${f.name} ${aboutDoc(f.result)}`));
    const named = asked.reduce((s, t) => (about.has(t) ? s + idf.get(t) : s), 0);
    const b = best.get(f.id);
    return { id: f.id, score: (b ? b.score : 0) + 0.5 * named, where: b ? b.p.where : '', snippet: b ? around(b.p.text, asked, idf) : '' };
  });
  return hits.filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

// A bit of a piece around the rarest of the asked words it holds.
function around(text, asked, idf) {
  const found = asked.filter((t) => text.toLowerCase().includes(t)).sort((a, b) => idf.get(b) - idf.get(a))[0];
  const at = found ? text.toLowerCase().indexOf(found) : 0;
  const from = Math.max(0, at - 50);
  return `${from ? '…' : ''}${text.slice(from, from + 140).replace(/\s+/g, ' ')}${from + 140 < text.length ? '…' : ''}`;
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
