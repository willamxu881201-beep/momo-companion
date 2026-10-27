// Two-step conversation:
//  1. a small router model (supports function calling) decides whether to
//     look up another day's timetable, mark a task done, or set an alarm;
//  2. the character model (doubao-seed-character, no tool calling) speaks,
//     reading only the facts and the results of step 1.
// Dates and timetable facts always come from our data, never from the model.
// Conversation history is kept in memory for a few minutes and never saved.

import { arkChat } from './ark.js';
import { STAGE_LOOKS } from './characters.js';
import { addDays, dateZh, isDate, weekdayZh } from './dates.js';

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
];

export class Brain {
  constructor(family, { apiKey, routerModel, personaModel }) {
    this.family = family;
    this.apiKey = apiKey;
    this.routerModel = routerModel;
    this.personaModel = personaModel;
    this.histories = new Map();
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

  async reply(key, text) {
    const userText = String(text || '').trim().slice(0, 300);
    if (!userText) return { reply: '我在呢，你想说什么呀？', petAction: null, actions: [] };

    const history = this.history(key);
    let snap = this.family.snapshot();
    const results = [];
    const actions = [];

    try {
      const routed = await arkChat({
        apiKey: this.apiKey,
        model: this.routerModel,
        messages: [{ role: 'system', content: routerPrompt(this.family, snap) }, ...history, { role: 'user', content: userText }],
        tools: TOOLS,
        maxTokens: 200,
      });
      for (const call of routed.toolCalls) {
        const r = this.runTool(call, snap);
        if (r.text) results.push(r.text);
        if (r.action) actions.push(r.action);
      }
      if (actions.length) snap = this.family.snapshot();
    } catch (err) {
      console.error('[brain] router failed:', err.message);
    }

    let raw;
    try {
      const spoken = await arkChat({
        apiKey: this.apiKey,
        model: this.personaModel,
        messages: [
          { role: 'system', content: personaPrompt(this.family, snap, results) },
          ...history,
          { role: 'user', content: userText },
        ],
        maxTokens: 180,
      });
      raw = spoken.content;
    } catch (err) {
      console.error('[brain] persona failed:', err.message);
      raw = results.length ? results.join('。') : '哎呀，我刚才走神了，你可以再说一遍吗？';
    }

    const { reply, petAction } = splitReply(raw);
    this.remember(key, userText, reply);
    const points = this.family.awardChat();
    return { reply, petAction, actions, points };
  }

  runTool(call, snap) {
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
      default:
        return { text: null };
    }
  }
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
    '- 让你在某个时间叫 TA、提醒 TA，调用 set_alarm。',
    '- 说取消闹钟，调用 cancel_alarms。',
    '- 其他情况都不调用工具。',
  ].join('\n');
}

function personaPrompt(family, snap, results) {
  const { kidName: kid, girlInfo: g, petInfo: p, pet } = snap.profile;
  const look = STAGE_LOOKS[pet]?.[snap.affinity.stage - 1] || '';
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
  ].join('\n');
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
