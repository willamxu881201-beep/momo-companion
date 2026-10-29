// Tells Mom's phone what happened while her page was closed: MoMo's messages, what a
// look-in saw, tasks MoMo says she has finished, photos MoMo sent. Off unless
// NOTIFY_URL is set; the address says which service it is:
//   Server酱      https://sctapi.ftqq.com/<SendKey>.send  (Server酱³: https://<uid>.push.ft07.com/send/<SendKey>.send)
//   PushPlus     https://www.pushplus.plus/send?token=<token>
//   WxPusher     https://wxpusher.zjiecode.com/api/send/message/<SPT>  (or ...?appToken=<AT>&uid=<UID>)
//   企业微信、钉钉、飞书的群机器人  the robot's webhook address as given
//   Bark         https://api.day.app/<key>
//   ntfy         https://ntfy.sh/<topic>  (or your own ntfy.… server)
//   Telegram     https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>
//   anything else gets a JSON POST: { title, text, url }.
// Things that happen close together go out as one message. Nothing is pushed while
// Mom's page is open (she sees it there), and the log never holds what was said.

const KIND_OF = { message: 'message', check: 'check', done: 'done', photo: 'photo', timetable: 'photo', homework_list: 'photo', homework_page: 'photo' };
const TITLE = {
  message: (kid) => `💬 ${kid}有话跟你说`,
  check: (kid) => `📷 看看${kid}`,
  done: (kid) => `✅ ${kid}做完了，等你确认`,
  photo: (kid) => `🖼️ ${kid}发来照片`,
};
export const NOTIFY_KINDS = Object.keys(TITLE);

// The service an address points at, and what to send it.
export function target(address) {
  const u = new URL(address);
  const host = u.hostname;
  const q = u.searchParams;
  const at = (re) => re.test(host);
  if (at(/(^|\.)ftqq\.com$|\.push\.ft07\.com$/)) return { name: 'Server酱', url: u.href };
  if (at(/(^|\.)pushplus\.plus$/)) return { name: 'PushPlus', url: `${u.origin}/send`, token: q.get('token'), topic: q.get('topic') };
  if (at(/^wxpusher\.zjiecode\.com$/)) {
    const spt = u.pathname.split('/').find((p) => p.startsWith('SPT_')) || q.get('spt');
    if (spt) return { name: 'WxPusher', url: `${u.origin}/api/send/message/simple-push`, spt };
    return { name: 'WxPusher', url: `${u.origin}/api/send/message`, appToken: q.get('appToken'), uids: q.getAll('uid'), topicIds: q.getAll('topicId').map(Number) };
  }
  if (at(/^qyapi\.weixin\.qq\.com$/)) return { name: '企业微信', url: u.href, robot: 'wecom' };
  if (at(/^oapi\.dingtalk\.com$/)) return { name: '钉钉', url: u.href, robot: 'dingtalk' };
  if (at(/^open\.(feishu\.cn|larksuite\.com)$/)) return { name: '飞书', url: u.href, robot: 'feishu' };
  if (at(/^api\.day\.app$/)) return { name: 'Bark', url: u.href };
  if (at(/^api\.telegram\.org$/)) return { name: 'Telegram', url: `${u.origin}${u.pathname}`, chatId: q.get('chat_id') };
  if (at(/(^|\.)ntfy\./)) return { name: 'ntfy', url: `${u.origin}/`, topic: u.pathname.split('/').filter(Boolean).pop() };
  return { name: '网址', url: u.href, generic: true };
}

// One message ({ title, text, link }) as a fetch() request for that service.
export function request(t, { title, text, link }) {
  const withLink = link ? `${text}\n\n打开看看：${link}` : text;
  const json = (body) => ({ url: t.url, init: { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) } });
  switch (t.name) {
    case 'Server酱': // the text is Markdown there: a line break needs a blank line
      return { url: t.url, init: { method: 'POST', body: new URLSearchParams({ title: title.slice(0, 32), desp: withLink.replace(/\n+/g, '\n\n'), short: text.slice(0, 64) }) } };
    case 'PushPlus':
      return json({ token: t.token, title, content: withLink, template: 'txt', ...(t.topic ? { topic: t.topic } : {}) });
    case 'WxPusher': {
      const base = { content: `${title}\n${text}`, summary: title.slice(0, 20), contentType: 1, ...(link ? { url: link } : {}) };
      return json(t.spt ? { ...base, spt: t.spt } : { ...base, appToken: t.appToken, uids: t.uids, topicIds: t.topicIds });
    }
    case 'Bark':
      return json({ title, body: text, group: 'MoMo', ...(link ? { url: link } : {}) });
    case 'ntfy':
      return json({ topic: t.topic, title, message: text, ...(link ? { click: link } : {}) });
    case 'Telegram':
      return json({ chat_id: t.chatId, text: `${title}\n\n${withLink}`, disable_web_page_preview: true });
  }
  if (t.robot === 'wecom' || t.robot === 'dingtalk') return json({ msgtype: 'text', text: { content: `${title}\n${withLink}` } });
  if (t.robot === 'feishu') return json({ msg_type: 'text', content: { text: `${title}\n${withLink}` } });
  return json({ title, text, url: link || undefined });
}

// Whether the service took it. They all answer 2xx; most say more in the body.
export function accepted(status, body) {
  if (status < 200 || status >= 300) return false;
  if (!body || typeof body !== 'object') return true;
  if (body.ok === false || body.success === false) return false; // Telegram, WxPusher
  if (typeof body.errcode === 'number' && body.errcode !== 0) return false; // 企业微信, 钉钉
  if (typeof body.StatusCode === 'number' && body.StatusCode !== 0) return false; // 飞书 (old)
  if (typeof body.code === 'number' && ![0, 200, 1000].includes(body.code)) return false; // Server酱 0, PushPlus/Bark 200, WxPusher 1000, 飞书 0
  return true;
}

export class Notify {
  // looking(): whether Mom has her page open. kinds: which of NOTIFY_KINDS to push.
  constructor({ url = '', kinds = NOTIFY_KINDS, perDay = 30, link = '', family, store, looking = () => false, delayMs = 20000, fetch: send = fetch }) {
    try {
      this.target = url ? target(url) : null;
    } catch {
      this.target = null;
      this.bad = true; // not a web address: pushes stay off, the start-up log says so
    }
    this.kinds = new Set(kinds.length ? kinds : NOTIFY_KINDS);
    Object.assign(this, { perDay, link, family, store, looking, delayMs, send });
    this.pending = [];
    this.timer = null;
  }

  get on() {
    return Boolean(this.target);
  }

  // A new line in the day's record (store.getEvent). Mom's own doings aren't news to her.
  event(e) {
    const kind = e && e.who !== 'mom' && KIND_OF[e.kind];
    if (!this.target || !kind || !this.kinds.has(kind) || this.looking()) return;
    this.pending.push({ kind, at: e.at, text: e.text });
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  // Sends what has gathered, unless Mom opened her page meanwhile.
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const list = this.pending.splice(0);
    if (!list.length || this.looking()) return false;
    return this.push(this.compose(list), list.length);
  }

  compose(list) {
    const kid = this.family.profile().kidName;
    if (list.length === 1) return { title: TITLE[list[0].kind](kid), text: list[0].text, link: this.link };
    const hhmm = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: this.family.timeZone });
    return { title: `${kid}的伙伴：${list.length} 条新消息`, text: list.map((x) => `${hhmm(x.at)} ${x.text}`).join('\n'), link: this.link };
  }

  // A test from the 管理 page: straight away, Mom's page open or not.
  test() {
    if (!this.target) return Promise.resolve({ ok: false, error: '服务器还没设置 NOTIFY_URL' });
    const kid = this.family.profile().kidName;
    return this.push({ title: `${kid}的伙伴`, text: `这是一条测试推送。妈妈的页面没打开时，${kid}的留言、看看${kid}的结果、做完的任务会这样推送给你。`, link: this.link }, 1, true);
  }

  async push(msg, n, test = false) {
    const today = this.family.now().date;
    if (this.store.usage(today, 'notify') >= this.perDay) {
      console.warn(`[notify] daily limit reached, ${n} not sent`);
      return test ? { ok: false, error: `今天已经推送了 ${this.perDay} 条，明天再试` } : false;
    }
    this.store.addUsage(today, 'notify');
    const { url, init } = request(this.target, msg);
    let ok = false;
    let why = '';
    try {
      const res = await this.send(url, { ...init, signal: AbortSignal.timeout(10000) });
      const body = await res.json().catch(() => null);
      ok = accepted(res.status, body);
      if (!ok) why = `HTTP ${res.status}${body ? ` ${String(body.msg || body.message || body.errmsg || body.description || body.error || '').slice(0, 80)}` : ''}`;
    } catch (err) {
      why = err.name === 'TimeoutError' ? 'timeout' : String(err.cause?.code || err.message).slice(0, 80);
    }
    // Only what happened and how big, never the words.
    console.log(`[notify] ${this.target.name} ${ok ? 'sent' : `failed (${why})`}: ${n} item(s), ${msg.text.length} chars`);
    return test ? { ok, error: ok ? '' : why, service: this.target.name } : ok;
  }
}
