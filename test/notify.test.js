import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { Family } from '../server/family.js';
import { Auth, PARENT_COOKIE } from '../server/auth.js';
import { Brain } from '../server/brain.js';
import { Notify, accepted, request, target } from '../server/notify.js';
import { createHandler } from '../server/http.js';

const msg = { title: '💬 沫沫有话跟你说', text: '沫沫让转告妈妈：我想吃饺子', link: 'https://momo.example/parent' };
const sent = (t) => {
  const { url, init } = request(target(t), msg);
  return { url, body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init.body) };
};

test('each push service gets the request it understands', () => {
  let r = sent('https://sctapi.ftqq.com/SCT123abc.send');
  assert.equal(r.url, 'https://sctapi.ftqq.com/SCT123abc.send');
  assert.equal(r.body.title, msg.title);
  assert.equal(r.body.short, msg.text, 'the WeChat card shows the words');
  assert.match(r.body.desp, /我想吃饺子\n\n打开看看：https:\/\/momo\.example\/parent/, 'Markdown: blank line between lines');
  assert.equal(target('https://12345.push.ft07.com/send/sctp12345tabc.send').name, 'Server酱');

  r = sent('https://www.pushplus.plus/send?token=tok1');
  assert.deepEqual(r, { url: 'https://www.pushplus.plus/send', body: { token: 'tok1', title: msg.title, content: `${msg.text}\n\n打开看看：${msg.link}`, template: 'txt' } });

  r = sent('https://wxpusher.zjiecode.com/api/send/message/SPT_abc');
  assert.equal(r.url, 'https://wxpusher.zjiecode.com/api/send/message/simple-push');
  assert.equal(r.body.spt, 'SPT_abc');
  assert.equal(r.body.contentType, 1);
  assert.equal(r.body.url, msg.link);
  assert.ok(r.body.summary.length <= 20);
  r = sent('https://wxpusher.zjiecode.com/api/send/message/?appToken=AT_x&uid=UID_a&uid=UID_b');
  assert.equal(r.url, 'https://wxpusher.zjiecode.com/api/send/message');
  assert.equal(r.body.appToken, 'AT_x');
  assert.deepEqual(r.body.uids, ['UID_a', 'UID_b']);

  r = sent('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1');
  assert.equal(r.url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1');
  assert.deepEqual(r.body, { msgtype: 'text', text: { content: `${msg.title}\n${msg.text}\n\n打开看看：${msg.link}` } });
  assert.equal(sent('https://oapi.dingtalk.com/robot/send?access_token=t').body.msgtype, 'text');
  assert.deepEqual(sent('https://open.feishu.cn/open-apis/bot/v2/hook/h1').body, { msg_type: 'text', content: { text: `${msg.title}\n${msg.text}\n\n打开看看：${msg.link}` } });

  assert.deepEqual(sent('https://api.day.app/barkkey'), { url: 'https://api.day.app/barkkey', body: { title: msg.title, body: msg.text, group: 'MoMo', url: msg.link } });
  assert.deepEqual(sent('https://ntfy.sh/momo-mum'), { url: 'https://ntfy.sh/', body: { topic: 'momo-mum', title: msg.title, message: msg.text, click: msg.link } });
  r = sent('https://api.telegram.org/bot123:abc/sendMessage?chat_id=42');
  assert.equal(r.url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(r.body.chat_id, '42');
  assert.deepEqual(sent('https://home.example/hook?x=1'), { url: 'https://home.example/hook?x=1', body: { title: msg.title, text: msg.text, url: msg.link } });
});

test("a service's answer says whether it took the message", () => {
  assert.equal(accepted(200, { code: 0, data: { errno: 0 } }), true); // Server酱
  assert.equal(accepted(200, { code: 40001, message: 'bad pushkey' }), false);
  assert.equal(accepted(200, { code: 200, msg: '请求成功' }), true); // PushPlus, Bark
  assert.equal(accepted(200, { code: 903, msg: '无效的用户令牌' }), false);
  assert.equal(accepted(200, { code: 1000, success: true }), true); // WxPusher
  assert.equal(accepted(200, { errcode: 0, errmsg: 'ok' }), true); // 企业微信, 钉钉
  assert.equal(accepted(200, { errcode: 93000, errmsg: 'invalid webhook url' }), false);
  assert.equal(accepted(200, { code: 19024, msg: 'Key Words Not Found' }), false); // 飞书
  assert.equal(accepted(400, { ok: false, description: 'chat not found' }), false); // Telegram
  assert.equal(accepted(200, { id: 'x', event: 'message' }), true); // ntfy
  assert.equal(accepted(204, null), true);
  assert.equal(accepted(500, null), false);
});

// ---- the notifier itself ----------------------------------------------------------

const at = new Date('2026-10-28T08:05:00Z'); // 16:05 in Kuala Lumpur
const store = openDb(':memory:');
store.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 1 });
store.setSetting('profile', { kidName: '沫沫', girl: 'b', pet: '3' });
const family = new Family(store, { clock: () => at });
let looking = false;
let answer = { status: 200, body: { code: 0 } };
const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url, init });
  if (answer instanceof Error) throw answer;
  return { status: answer.status, json: async () => answer.body };
};
const notify = new Notify({ url: 'https://sctapi.ftqq.com/SCTkey.send', perDay: 5, link: 'https://momo.example/parent', family, store, looking: () => looking, fetch: fakeFetch });
family.onEvent = (id) => notify.event(store.getEvent(id));
const pushed = () => calls.map((c) => Object.fromEntries(c.init.body));

test("while Mom's page is closed, MoMo's news reaches her phone, a few at a time", async () => {
  calls.length = 0;
  family.log('kid', 'message', '沫沫让转告妈妈：我想吃饺子');
  family.log('kid', 'done', '沫沫说「练琴」做完了');
  family.log('mom', 'review', '妈妈确认了「练琴」'); // Mom did that herself
  family.log('tablet', 'reminder', '提醒了沫沫：写作业'); // not news
  family.log('mom', 'homework_list', '妈妈发来作业清单'); // her own photo
  assert.equal(await notify.flush(), true);
  assert.equal(calls.length, 1, 'one push for the lot');
  const [p] = pushed();
  assert.equal(p.title, '沫沫的伙伴：2 条新消息');
  assert.match(p.desp, /^\d\d:\d\d 沫沫让转告妈妈：我想吃饺子\n\n\d\d:\d\d 沫沫说「练琴」做完了\n\n打开看看：https:\/\/momo\.example\/parent$/);

  calls.length = 0;
  family.log('tablet', 'check', '看看坐姿：沫沫坐得很端正');
  await notify.flush();
  assert.equal(pushed()[0].title, '📷 看看沫沫', 'one thing: its own title');
  assert.equal(pushed()[0].short, '看看坐姿：沫沫坐得很端正');
});

test("nothing is pushed while Mom's page is open, or if she opens it before it goes", async () => {
  calls.length = 0;
  looking = true;
  family.log('kid', 'message', '沫沫让转告妈妈：我写完了');
  assert.equal(await notify.flush(), false);
  looking = false;
  family.log('kid', 'photo', '沫沫发来照片：一幅画');
  looking = true; // Mom opened her page within the wait
  assert.equal(await notify.flush(), false);
  looking = false;
  assert.equal(calls.length, 0);
});

test('a failed push is logged without the words, and the daily limit holds', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  t.mock.method(console, 'warn', (...a) => logs.push(a.join(' ')));
  calls.length = 0;
  answer = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  family.log('kid', 'message', '沫沫让转告妈妈：秘密的话');
  assert.equal(await notify.flush(), false);
  assert.match(logs.join('\n'), /Server酱 failed \(ENOTFOUND\): 1 item/);
  assert.doesNotMatch(logs.join('\n'), /秘密|SCTkey/, 'neither the words nor the key');

  answer = { status: 200, body: { code: 40001, message: 'bad pushkey' } };
  const r = await notify.test();
  assert.deepEqual(r, { ok: false, error: 'HTTP 200 bad pushkey', service: 'Server酱' });

  answer = { status: 200, body: { code: 0 } };
  while (store.usage(family.now().date, 'notify') < 5) await notify.test();
  calls.length = 0;
  family.log('kid', 'message', '沫沫让转告妈妈：再来一条');
  assert.equal(await notify.flush(), false, 'five a day here');
  assert.equal(calls.length, 0);
  assert.match((await notify.test()).error, /今天已经推送了 5 条/);
});

test('only the kinds Mom chose; a bad address turns pushes off', async () => {
  const s = openDb(':memory:');
  const f = new Family(s, { clock: () => at });
  const got = [];
  const n = new Notify({ url: 'https://api.day.app/k', kinds: ['message'], family: f, store: s, fetch: async (url, init) => (got.push(JSON.parse(init.body)), { status: 200, json: async () => ({ code: 200 }) }) });
  f.onEvent = (id) => n.event(s.getEvent(id));
  f.log('kid', 'done', 'MoMo说「练琴」做完了');
  assert.equal(await n.flush(), false);
  f.log('kid', 'message', 'MoMo让转告妈妈：好的');
  assert.equal(await n.flush(), true);
  assert.equal(got[0].title, '💬 MoMo有话跟你说');
  assert.equal(got[0].body, 'MoMo让转告妈妈：好的');
  assert.equal(got[0].url, undefined, 'no link without PUBLIC_URL');

  const bad = new Notify({ url: 'not a url', family: f, store: s });
  assert.equal(bad.on, false);
  assert.equal(bad.bad, true);
  assert.deepEqual(await new Notify({ family: f, store: s }).test(), { ok: false, error: '服务器还没设置 NOTIFY_URL' });
});

// ---- Mom's 管理 page: whether pushes are on, and a test ------------------------------

const auth = new Auth(store, { parentPassword: 'test-password' });
const config = { publicUrl: '', parentPassword: 'test-password', limits: { chatPerDay: 80, asrPerDay: 150, ttsCharsPerDay: 20000, visionPerDay: 60, momChatPerDay: 80, notifyPerDay: 5 } };
const fakeHub = () => ({ size: 0, send() {} });
const server = createServer(createHandler({ config, store, family, brain: new Brain(family, { apiKey: 'k' }), auth, hub: fakeHub(), momHub: fakeHub(), notify, webDir: '.' }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());

test("Mom's 管理 page shows the push service and can send a test", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: `${PARENT_COOKIE}=${auth.login('127.0.0.1', 'test-password').token}`, 'Content-Type': 'application/json' };
  const state = await (await fetch(`${base}/api/parent/state`, { headers })).json();
  assert.equal(state.push, 'Server酱');
  assert.equal(state.usage.limits.notifyPerDay, 5);
  const r = await (await fetch(`${base}/api/parent/test-push`, { method: 'POST', headers, body: '{}' })).json();
  assert.equal(r.ok, false, 'today’s five are used up');
  assert.match(r.error, /明天再试/);
});
