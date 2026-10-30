// With MoMo, a two-step conversation:
//  1. a small router model (supports function calling) decides whether to look up
//     another day's timetable, mark a task done, set an alarm, or pass a word to Mom;
//  2. the character model (doubao-seed-character, no tool calling) speaks, reading
//     only the facts and the results of step 1, plus the page of homework MoMo just
//     showed her (to help without giving answers away), the parts of a document MoMo
//     just sent that bear on what she said, and Mom's recent messages.
// With Mom (momReply), the router model alone: it looks things up, reads the documents
// sent lately, asks the tablet to look at MoMo, passes messages, adds and confirms
// tasks, then answers in the companion's voice.
// Dates and timetable facts always come from our data, never from the model.
// Conversation history is kept in memory for a few minutes and never saved.

import { arkChat } from './ark.js';
import { STAGE_LOOKS } from './characters.js';
import { addDays, dateZh, isDate, nowIn, timeToMinutes, weekdayZh } from './dates.js';
import { inQuiet } from './events.js';
import { CHECK_WHAT } from './eyes.js';
import { aboutDoc, excerpts } from './docs.js';
import { SCENES, placeOf } from './activity.js';
import { PART_ZH, TYPE_ZH } from './extract.js';

const HISTORY_TURNS = 3;
const HISTORY_TTL_MS = 20 * 60 * 1000;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_day',
      description: '查询某一天是 D 几、上什么课。今天和明天的课已经在资料里，不用查。',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: '日期，格式 YYYY-MM-DD' } },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_task_done',
      description: '小朋友说今天的某件任务做完了时调用。',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'integer', description: '资料里任务前面的 id' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_alarm',
      description: '小朋友让你在某个时间叫 TA、提醒 TA 时调用。',
      parameters: {
        type: 'object',
        properties: {
          time: { type: 'string', description: '24 小时制 HH:MM' },
          label: { type: 'string', description: '很短的标签，比如 起床、出门' },
          date: { type: 'string', description: 'YYYY-MM-DD，不说就留空' },
        },
        required: ['time', 'label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_alarms',
      description: '小朋友说取消闹钟时调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_task',
      description: '小朋友说现在开始做今天的某件任务时调用（比如"我开始写作业了""我去练琴了"）。',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'integer', description: '资料里任务前面的 id' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tell_mom',
      description: '小朋友让你转告妈妈、告诉妈妈一件事时调用。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要转告的话，按孩子的原意，简短' } },
        required: ['text'],
      },
    },
  },
];

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

// What Mom can ask the companion to do.
const MOM_TOOLS = [
  fn('get_day', '查某一天是 D 几、上什么课、有哪些任务。今天和明天已经在资料里。', { date: { type: 'string', description: 'YYYY-MM-DD' } }, ['date']),
  fn('get_events', '查某一天的记录（做完的任务、拍的照片、平板看到的、传的话）。今天的已经在资料里。', { date: { type: 'string', description: 'YYYY-MM-DD' } }, ['date']),
  fn(
    'check_kid',
    '让平板现在拍张照片看看孩子：look 看在做什么，piano 看在不在练琴（还会听几秒声音），posture 看写作业的坐姿。结果稍后单独告诉妈妈。',
    { what: { type: 'string', enum: ['look', 'piano', 'posture'] } },
    ['what'],
  ),
  fn('tell_kid', '把妈妈的话转告给孩子（平板上会说出来）。', { text: { type: 'string', description: '要转告的话，口语、温和' } }, ['text']),
  fn(
    'read_document',
    '读一个文件的原文（Word、Excel、PPT、PDF 等，编号见【最近的文件】），找出和问题有关的部分。回答文件里的内容、总结或分析文件之前先调用。',
    { doc_id: { type: 'integer', description: '【最近的文件】里的 doc 编号' }, question: { type: 'string', description: '妈妈想知道什么，用来在原文里找' } },
    ['doc_id', 'question'],
  ),
  fn(
    'add_task',
    '给孩子加一件任务或作业。',
    {
      title: { type: 'string', description: '任务名，12 字以内' },
      date: { type: 'string', description: 'YYYY-MM-DD，不说就是今天' },
      time: { type: 'string', description: '开始时间 HH:MM，没有就留空' },
      minutes: { type: 'integer', description: '大概要多少分钟' },
      note: { type: 'string', description: '补充说明' },
    },
    ['title'],
  ),
  fn('review_task', '妈妈确认任务做好了（approve=true）或者要重做（approve=false）。', { task_id: { type: 'integer' }, approve: { type: 'boolean' } }, ['task_id', 'approve']),
  fn(
    'set_alarm',
    '给孩子定一个闹钟。',
    { time: { type: 'string', description: 'HH:MM' }, label: { type: 'string', description: '很短的标签' }, date: { type: 'string', description: 'YYYY-MM-DD，不说就留空' } },
    ['time', 'label'],
  ),
];

export class Brain {
  constructor(family, { apiKey, routerModel, personaModel }) {
    this.family = family;
    this.apiKey = apiKey;
    this.routerModel = routerModel;
    this.personaModel = personaModel;
    this.histories = new Map();
    this.helpers = {};
  }

  // The parts of the server the companion can reach: eyes (photos, check-ins), post
  // (messages), hub and momHub (live pushes to the tablet and to Mom's page).
  attach(helpers) {
    this.helpers = helpers;
  }

  history(key) {
    const h = this.histories.get(key);
    if (!h || Date.now() - h.at > HISTORY_TTL_MS) return [];
    return h.msgs;
  }

  remember(key, userText, reply) {
    const msgs = [...this.history(key), { role: 'user', content: userText }, { role: 'assistant', content: reply }];
    this.histories.set(key, { at: Date.now(), msgs: msgs.slice(-HISTORY_TURNS * 2) });
  }

  forget(key) {
    this.histories.delete(key);
  }

  // Something she said on her own (coach.js), so MoMo's answer to it makes sense to her.
  note(key, line) {
    const msgs = [...this.history(key), { role: 'assistant', content: line }];
    this.histories.set(key, { at: Date.now(), msgs: msgs.slice(-HISTORY_TURNS * 2) });
  }

  // A line for her to say on her own to MoMo (coach.js tells what about). null when
  // there's nothing usable; the coach has set lines for that.
  async speakUp(what) {
    const snap = this.family.snapshot();
    const { kidName: kid, girlInfo: g, petInfo: p } = snap.profile;
    const r = await arkChat({
      apiKey: this.apiKey,
      model: this.personaModel,
      timeoutMs: 15000,
      maxTokens: 120,
      messages: [
        {
          role: 'system',
          content: [
            `你是「${g.name}」，${g.look}。性格：${g.style}。你住在一块平板里，陪伴 8 岁的${kid}，你的搭档是${p.name}（一只${p.kind}）。`,
            `现在不是${kid}在跟你说话，是你主动开口：${what}`,
            `要求：只说一两句话，不超过 45 个字，口语、亲切、具体，不说教、不催促、不威胁。可以叫 TA「${kid}」。不用表情符号，不用【】。只输出你要说的话。`,
            '',
            '【资料】',
            this.family.factsText(snap),
          ].join('\n'),
        },
        { role: 'user', content: '（请你开口）' },
      ],
    });
    const line = splitReply(r.content).reply;
    return line && line !== '嗯嗯，我在听呢。' ? line : null;
  }

  // onEarly(reply) hears the character's answer the moment it exists, before the
  // router has decided whether it stands, so its voice can be made in the meantime.
  async reply(key, text, { onEarly } = {}) {
    const userText = String(text || '').trim().slice(0, 300);
    if (!userText) return { reply: '我在呢，你想说什么呀？', petAction: null, actions: [] };
    const t0 = Date.now();
    const took = {};

    const history = this.history(key);
    let snap = this.family.snapshot();
    const results = [];
    const actions = [];
    const speak = (facts, done) =>
      arkChat({
        apiKey: this.apiKey,
        model: this.personaModel,
        messages: [
          { role: 'system', content: personaPrompt(this.family, facts, done, this.extras(userText)) },
          ...history,
          { role: 'user', content: userText },
        ],
        maxTokens: 180,
      });

    // Most turns need no tool, so the character starts answering while the router
    // decides. If a tool does run, that early answer is dropped and the character
    // is asked again with the result.
    const early = speak(snap, []);
    let decided = false;
    early.then(
      (r) => {
        took.persona = Date.now() - t0;
        if (onEarly && !(decided && results.length)) onEarly(splitReply(r.content).reply);
      },
      () => {}, // a dropped answer must not become an unhandled rejection
    );

    try {
      const routed = await arkChat({
        apiKey: this.apiKey,
        model: this.routerModel,
        messages: [{ role: 'system', content: routerPrompt(this.family, snap) }, ...history, { role: 'user', content: userText }],
        tools: TOOLS,
        maxTokens: 200,
      });
      for (const call of routed.toolCalls) {
        const r = this.runTool(call, snap, userText);
        if (r.text) results.push(r.text);
        if (r.action) actions.push(r.action);
      }
      if (actions.length) snap = this.family.snapshot();
    } catch (err) {
      console.error('[brain] router failed:', err.message);
    }
    decided = true;
    took.router = Date.now() - t0;

    let raw;
    try {
      const spoken = await (results.length ? speak(snap, results) : early);
      raw = spoken.content;
    } catch (err) {
      console.error('[brain] persona failed:', err.message);
      raw = results.length ? results.join('。') : '哎呀，我刚才走神了，你可以再说一遍吗？';
    }

    const { reply, petAction } = splitReply(raw);
    this.remember(key, userText, reply);
    const points = this.family.awardChat();
    // Timings only, never the words.
    console.log(`[brain] router ${took.router} ms${results.length ? ` (${results.length} tool results, persona again)` : ''}, persona ${took.persona ?? '-'} ms, reply ${Date.now() - t0} ms, ${reply.length} chars`);
    return { reply, petAction, actions, points };
  }

  runTool(call, snap, userText = '') {
    const f = this.family;
    const a = call.args || {};
    switch (call.name) {
      case 'get_day': {
        if (!isDate(a.date)) return { text: '没查到那一天（日期不对）' };
        const d = f.day(a.date);
        const list = d.courses.map((c) => (c.note ? `${c.name}（${c.note}）` : c.name)).join('、');
        return {
          text: d.day
            ? `查到 ${dateZh(d.date)}：${d.label}，课程依次是 ${list || '（妈妈还没填这天的课）'}`
            : `查到 ${dateZh(d.date)}：休息，不上学`,
        };
      }
      case 'start_task': {
        const r = f.startTask(Number(a.task_id));
        if (!r.ok) return { text: `没开始成：${r.reason}` };
        const place = placeOf(r.task);
        return {
          text: `已记下：${r.task.title}现在开始，计划 ${r.task.minutes} 分钟${place ? `；你们一起到了${SCENES[place].name}` : ''}`,
          action: { type: 'task-started', id: r.task.id },
        };
      }
      case 'mark_task_done': {
        const r = f.markDone(Number(a.task_id));
        if (!r.ok) return { text: `没找到这件任务：${r.reason}` };
        return {
          text: r.already ? `「${r.task.title}」之前已经记过做完了` : `已把「${r.task.title}」记为做完了，等妈妈确认`,
          action: { type: 'task', id: r.task.id, status: r.task.status },
        };
      }
      case 'set_alarm': {
        const r = f.setAlarm(a.time, a.label, a.date);
        if (!r.ok) return { text: `闹钟没设成：${r.reason}` };
        return {
          text: `已设好闹钟：${dateZh(r.alarm.date)} ${r.alarm.time} ${r.alarm.label}`,
          action: { type: 'alarm', alarm: r.alarm },
        };
      }
      case 'cancel_alarms': {
        const r = f.cancelAlarms();
        return { text: `已取消 ${r.cancelled} 个闹钟`, action: { type: 'alarms-cleared' } };
      }
      case 'tell_mom': {
        // MoMo's own words, as she said them ("我" is MoMo): taken from what she said
        // when it has the usual shape, so the model's retelling can't change who "我" is.
        // Only when she asked for it in so many words: a question about homework is not a message.
        if (!/妈妈/.test(userText)) return { text: null };
        const own = /(?:告诉|跟|和|对|转告)妈妈(?:说|讲)?[，,:：\s]*(.+)$/.exec(userText);
        const words = String((own && own[1]) || a.text || '').trim().replace(/[。！!？?]+$/, '');
        if (!this.helpers.post || !words) return { text: '没转告成' };
        this.helpers.post.toMom(`“${words}”`);
        return { text: `已经把这句话转告给妈妈：${words.slice(0, 60)}`, action: { type: 'told-mom' } };
      }
      default:
        return { text: null };
    }
  }

  // Homework MoMo just showed, the parts of a document she just sent that bear on what
  // she said (userText), and what Mom asked to pass on lately.
  extras(userText = '') {
    const { eyes, post } = this.helpers;
    const doc = eyes ? eyes.currentDocument() : null;
    return {
      homework: eyes ? eyes.currentHomework() : null,
      notes: post ? post.recentForKid() : [],
      document: doc ? { title: doc.result.doc.title, gist: doc.result.doc.gist, excerpt: excerpts(doc.text, userText, 1500).text } : null,
    };
  }

  // ---- with Mom --------------------------------------------------------------------

  async momReply(text) {
    const userText = String(text || '').trim().slice(0, 300);
    if (!userText) return { reply: '我在呢，您想问什么？', actions: [] };
    const t0 = Date.now();
    const messages = [{ role: 'system', content: momPrompt(this.family, this.helpers) }, ...this.history('mom'), { role: 'user', content: userText }];
    const actions = [];
    let reply = '';
    for (let round = 0; round < 3 && !reply; round += 1) {
      let r;
      try {
        r = await arkChat({ apiKey: this.apiKey, model: this.routerModel, messages, tools: round < 2 ? MOM_TOOLS : undefined, maxTokens: 600 });
      } catch (err) {
        console.error('[brain] mom reply failed:', err.message);
        break;
      }
      if (!r.toolCalls.length) {
        reply = r.content;
        break;
      }
      messages.push({
        role: 'assistant',
        content: r.content || '',
        tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
      });
      for (const c of r.toolCalls) {
        const out = this.runMomTool(c);
        if (out.action) actions.push(out.action);
        messages.push({ role: 'tool', tool_call_id: c.id, content: out.text || '完成' });
      }
    }
    reply = splitReply(reply || (actions.length ? '好的，已经办好了。' : '抱歉，我刚才没弄明白，您可以再说一遍吗？')).reply;
    this.remember('mom', userText, reply);
    console.log(`[brain] mom reply ${Date.now() - t0} ms, ${actions.length} actions, ${reply.length} chars`);
    return { reply, actions };
  }

  runMomTool(call) {
    const f = this.family;
    const { eyes, post, hub } = this.helpers;
    const a = call.args || {};
    const today = f.now().date;
    switch (call.name) {
      case 'get_day': {
        if (!isDate(a.date)) return { text: '日期不对' };
        return { text: dayText(f, a.date) };
      }
      case 'get_events': {
        if (!isDate(a.date)) return { text: '日期不对' };
        const list = f.store.listEvents(a.date, 40);
        return { text: list.length ? list.reverse().map((e) => `${clock(f, e.at)} ${e.text}`).join('\n') : `${dateZh(a.date)}没有记录` };
      }
      case 'check_kid': {
        if (!eyes) return { text: '现在看不了' };
        const r = eyes.check(a.what);
        return { text: r.text, action: r.ok ? { type: 'check', id: r.id, what: a.what } : null };
      }
      case 'read_document': {
        const d = eyes && eyes.document(a.doc_id);
        if (!d) return { text: '没有这个文件，可能已经过期删除了' };
        const ex = excerpts(d.text, String(a.question || ''), 8000);
        return {
          text: ex.whole
            ? `《${d.name || '文件'}》的全文：\n${ex.text}`
            : `《${d.name || '文件'}》里和问题最有关的部分（不是全文，【】或（）里是页、表或幻灯片）：\n${ex.text}\n\n这个文件的概要：\n${aboutDoc(d.result)}`,
        };
      }
      case 'tell_kid': {
        if (!post) return { text: '现在传不了话' };
        const id = post.toKid(a.text);
        if (!id) return { text: '没有要转告的话' };
        const online = hub && hub.size > 0;
        const quiet = inQuiet(f.now().minutes, f.store.getSetting('quiet'));
        return {
          text: online && !quiet ? '已经在平板上转告了' : quiet ? '现在是安静时间，等早上平板醒来再转告' : '平板现在没开，等开了马上转告',
          action: { type: 'told-kid', id },
        };
      }
      case 'add_task': {
        const date = isDate(a.date) ? a.date : today;
        if (date < today) return { text: '不能加到过去的日子' };
        const title = String(a.title || '').trim().slice(0, 20);
        if (!title) return { text: '任务名是空的' };
        const time = a.time && timeToMinutes(a.time) !== null ? a.time : null;
        const id = f.store.addOneOffTask(date, { title, time, minutes: Math.min(Math.max(Number(a.minutes) || 30, 5), 240), note: String(a.note || '').slice(0, 80), source: 'mom' });
        f.log('mom', 'task', `妈妈加了任务：${title}${date === today ? '' : `（${dateZh(date)}）`}`);
        if (hub) hub.send({ type: 'refresh' });
        return { text: `已加到${date === today ? '今天' : dateZh(date)}的任务：${title}`, action: { type: 'task-added', id } };
      }
      case 'review_task': {
        const r = f.review(Number(a.task_id), Boolean(a.approve));
        if (!r.ok) return { text: '没找到这件任务' };
        if (hub) {
          const asleep = inQuiet(f.now().minutes, f.store.getSetting('quiet'));
          hub.send(asleep ? { type: 'refresh' } : { type: 'reviewed', approve: Boolean(a.approve), title: r.task.title, points: r.points });
        }
        return { text: `${a.approve ? '已确认' : '已让重做'}：${r.task.title}${r.points ? `，好感度加 ${r.points}` : ''}`, action: { type: 'reviewed', id: r.task.id } };
      }
      case 'set_alarm': {
        const r = f.setAlarm(a.time, a.label, a.date);
        if (!r.ok) return { text: `闹钟没设成：${r.reason}` };
        if (hub) hub.send({ type: 'refresh' });
        return { text: `已设好闹钟：${dateZh(r.alarm.date)} ${r.alarm.time} ${r.alarm.label}`, action: { type: 'alarm', alarm: r.alarm } };
      }
      default:
        return { text: '这个我做不了' };
    }
  }
}

const clock = (family, ms) => nowIn(family.timeZone, new Date(ms)).time;

const STATUS_FOR_MOM = { todo: '还没做', waiting: '说做完了，等你确认', confirmed: '你确认过了', redo: '你让重做' };

// One day for Mom: D-day and courses, and the tasks with how far they got.
function dayText(family, date) {
  const d = family.day(date);
  const courses = d.day ? `${d.label}，课程：${d.courses.map((c) => (c.note ? `${c.name}（${c.note}）` : c.name)).join('、') || '（还没填）'}` : '休息，不上学';
  const today = family.now().date;
  const tasks = date <= today ? family.tasks(date) : family.store.listInstances(date);
  const list = tasks.length
    ? tasks
        .map((t) => `[id=${t.id}] ${t.title}${t.note ? `〔${t.note}〕` : ''}${t.time ? `（${t.time}）` : ''}：${STATUS_FOR_MOM[t.status] || t.status}${t.status === 'waiting' && t.done_at ? `（${clock(family, t.done_at)} 说的）` : ''}`)
        .join('；')
    : date > today ? '（按每天的模板，到那天会自动排上）' : '没有任务';
  return `${dateZh(date)}：${courses}。任务：${list}`;
}

// "10月29日 16:05"
const when = (family, ms) => {
  const t = nowIn(family.timeZone, new Date(ms));
  return `${dateZh(t.date).replace(/ .*/, '')} ${t.time}`;
};

function momPrompt(family, { hub, post, eyes } = {}) {
  const snap = family.snapshot();
  const { kidName: kid, girlInfo: g } = snap.profile;
  const today = snap.now.date;
  const events = family.store.listEvents(today, 15).reverse();
  const quiet = family.store.getSetting('quiet');
  const unread = post ? post.store.undelivered('kid') : [];
  const docs = eyes ? eyes.documents({ limit: 8 }) : [];
  return [
    `你是「${g.name}」，${kid}的 AI 伙伴。现在跟你说话的是${kid}的妈妈，不是孩子。`,
    `说话亲切、简洁、有条理，像一个靠谱的小助理，带一点你自己的性格（${g.style}）。平时每次 1 到 4 句，不超过 100 字（总结、分析文件见第 8 条）。不用表情符号、列表和 markdown，你说的话会被念出来。`,
    '',
    '你能做的：查课程和任务；查今天发生的事；读妈妈和孩子发来的文件（Word、Excel、PPT、PDF 等），回答里面的内容、做总结和分析；让平板现在拍张照片看看孩子在做什么、在不在练琴、坐姿对不对；把妈妈的话转告给孩子；给孩子加任务；确认任务；定闹钟。',
    '规则：',
    '1. 事实只依据下面的【资料】和工具结果，不编造。不知道就直说，并建议怎么办（比如让平板看一眼）。',
    '2. 妈妈问孩子现在在干什么、练没练琴、坐姿怎么样：记录里 15 分钟内有对应的查看结果就直接说；没有就调用 check_kid。check_kid 只是让平板去拍，结果稍后会单独告诉妈妈，你只要说一句"我去看看"之类的话。',
    '3. 妈妈让你转告、提醒、叮嘱孩子，调用 tell_kid，话要温和、口语化。',
    '4. 妈妈要加任务或作业，调用 add_task；说某件任务通过了或要重做，调用 review_task。',
    `5. ${kid}和你的聊天不会保存，你不知道聊天原话；问到就说只记录做了什么事。`,
    `6. 说到${kid}时要友善，不夸大问题、不给孩子贴标签。`,
    '7. 只答应你做得到的事：你不会一直盯着孩子，也不会自己发现她什么时候练完琴、写完作业（要看就得让平板拍一张），所以别说“我会盯着她”。孩子说做完了、发了照片、让你传话，妈妈的页面会马上收到。',
    '8. 妈妈问到文件里的内容、让你总结或分析文件：先调用 read_document（doc_id 见【最近的文件】，没说是哪个就用最新的），只依据读到的原文回答，原文里没有就直说；可以说在第几页、哪张表、第几张幻灯片。总结和分析先说结论，可以说得长一些，但不超过 200 字。文件里提到的日子和要做的事，妈妈想要的话可以用 add_task 加成任务。',
    '',
    '【资料】',
    `现在：${dateZh(today)} ${snap.now.time}。平板${hub && hub.size ? '开着' : '现在没打开'}。安静时间 ${quiet.start}–${quiet.end}。`,
    `今天 ${dayText(family, today)}`,
    `明天 ${dayText(family, addDays(today, 1)).replace(/。任务：.*$/, '')}`,
    snap.alarms.length ? `已定的闹钟：${snap.alarms.map((a) => `${dateZh(a.date)} ${a.time} ${a.label}`).join('；')}` : '没有定闹钟',
    `好感度 ${snap.affinity.points}，宠物${snap.profile.petInfo.name}在第 ${snap.affinity.stage} 阶段`,
    unread.length ? `还没转告给孩子的话：${unread.map((m) => m.text).join('；')}` : '',
    '今天的记录（从早到晚）：',
    events.length ? events.map((e) => `${clock(family, e.at)} ${e.text}`).join('\n') : '（还没有）',
    docs.length ? '【最近的文件】（新的在前，内容要用 read_document 读）' : '',
    ...docs.map((d) => {
      const size = d.parts > 1 && PART_ZH[d.type] ? `，${d.parts} ${PART_ZH[d.type]}` : '';
      const gist = (d.result.doc && d.result.doc.gist) || d.result.summary || '';
      return `[doc=${d.id}] ${when(family, d.at)} ${d.who === 'kid' ? kid : '妈妈'}发来的${TYPE_ZH[d.type] || ''}文件《${d.name || (d.result.doc && d.result.doc.title) || '文件'}》${size}：${gist}`;
    }),
    '',
    `可以查看的：${Object.entries(CHECK_WHAT).map(([k, v]) => `${k}=${v}`).join('，')}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function routerPrompt(family, snap) {
  const d = snap.now.date;
  return [
    '你是家庭助手的指令解析器，只决定要不要调用工具，不和小朋友聊天。',
    `今天是 ${d}（${weekdayZh(d)}），现在 ${snap.now.time}。明天是 ${addDays(d, 1)}，后天是 ${addDays(d, 2)}。`,
    '',
    family.factsText(snap),
    '',
    '规则：',
    '- 问今天或明天的课，不调用工具，资料里已经有了。问其他日子（后天、下周一、11月3日等）的课，调用 get_day，把日期换算成 YYYY-MM-DD。',
    '- 说今天某件任务做完了，调用 mark_task_done，task_id 用资料里的 id。说全都做完了，就对每件还没做的任务各调用一次。',
    '- 说现在开始做某件任务（“我开始写作业了”“我去练琴啦”），调用 start_task。',
    '- 让你在某个时间叫 TA、提醒 TA，调用 set_alarm。',
    '- 说取消闹钟，调用 cancel_alarms。',
    '- 小朋友明确说“告诉妈妈”“跟妈妈说”“转告妈妈”时，调用 tell_mom，text 照抄 TA 要说的话（“我”就是小朋友自己）。问作业、问问题都不是转告。',
    '- 其他情况都不调用工具。',
  ].join('\n');
}

function personaPrompt(family, snap, results, { homework = null, notes = [], document = null } = {}) {
  const { kidName: kid, girlInfo: g, petInfo: p, pet } = snap.profile;
  const look = STAGE_LOOKS[pet]?.[snap.affinity.stage - 1] || '';
  const extra = [];
  if (homework) {
    extra.push(
      '',
      `【作业】${kid}刚才拍给你看了一页${homework.subject || ''}作业：`,
      ...homework.problems.map((q) => `${q.n ? `第${q.n}题` : '一题'}：${q.text}${q.done ? `（TA 写的答案：${q.done}）` : ''}`),
      homework.hint ? `思路：${homework.hint}` : '',
      `辅导的规矩：TA 问作业时，一次只讲一小步，先问 TA 是怎么想的；可以换成更小的数或者生活里的例子帮 TA 想；不直接说出答案，TA 坚持要答案就给最关键的一步提示；TA 写的答案对了要具体地夸，错了就引导 TA 自己找出哪一步不对。`,
    );
  }
  if (document) {
    extra.push(
      '',
      `【文件】${kid}刚才发给你看了《${document.title}》：${document.gist}`,
      '文件里和 TA 刚才说的话最有关的原文：',
      document.excerpt,
      `TA 问到文件里的内容时，只依据原文回答，原文里没有的就说不知道；用 TA 听得懂的话讲。如果是题目，一次只讲一小步，不直接说出答案。`,
    );
  }
  if (notes.length) {
    extra.push('', '【妈妈刚才让你转告过的话】', ...notes.map((m) => `- ${m.text}`));
  }
  return [
    `你是「${g.name}」，${g.look}。性格：${g.style}。`,
    `你的搭档是${p.name}（一只${p.kind}，现在${look}），它不会说人话，只会发出"${p.sound}"、做些小动作。描述它时只能按它现在的样子。`,
    `你住在一块平板里，陪伴 8 岁的${kid}，可以亲切地叫 TA「${kid}」。你说的每句话都会被念出来。`,
    '',
    '规则：',
    '1. 用简单的口语，每次回复 1 到 3 句、不超过 60 个字。不用表情符号，不用列表、标题和 markdown。',
    '2. 课程、日期、任务、闹钟只能依据下面的【资料】和【刚完成的操作】。资料里没有的，就说"这个我还不知道，可以问问妈妈"，绝不编造。',
    `3. 你是鼓励${kid}自己管好自己的小伙伴，不是监工：不威胁、不羞辱、不替爸爸妈妈施压。如果 TA 不想做事或很累，先共情，再给一个超小的、容易的第一步，别说教。`,
    `4. 任务要等妈妈确认才算数。${kid}说做完了，就开心地告诉 TA 已经记下，等妈妈看过就会涨好感度，不要说已经加分了。`,
    '5. 不聊暴力、恐怖和不适合小朋友的话题；不打听家庭住址、学校名字、电话等隐私。如果 TA 说受伤了、害怕、被欺负或身体不舒服，先温柔安慰，再让 TA 马上告诉爸爸妈妈或身边的大人。',
    '6. 别让 TA 一直对着屏幕聊天：聊了几句以后，自然地提醒去做下一件事，或者让眼睛休息一下。',
    `7. 想描述${p.name}的反应时，写在回复最后，用【】括起来，例如【${p.name}${p.moves[0]}】，最多一处，括号里不超过 10 个字。`,
    '',
    '【资料】',
    family.factsText(snap),
    '',
    '【刚完成的操作】',
    results.length ? results.join('\n') : '无',
    ...extra,
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

// Pulls the pet's stage direction out of the spoken text and strips anything
// a speech engine would read badly.
export function splitReply(raw) {
  let text = String(raw || '');
  let petAction = null;
  const m = text.match(/【([^】]{1,20})】/);
  if (m) petAction = m[1].trim();
  text = text
    .replace(/【[^】]*】/g, '')
    .replace(/[*#`>_~]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) text = '嗯嗯，我在听呢。';
  return { reply: text, petAction };
}
