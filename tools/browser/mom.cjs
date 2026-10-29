// Mom's page, with MoMo's page beside it (a fake camera):
//  - on a phone: log in, wake the companion, the 管理 sheet says pushes are on, and a
//    test push arrives;
//  - on a tablet: a slow answer gets "我看看～" first (and only the answer is kept in
//    刚才说的); a look-in takes a picture on MoMo's page, Mom hears back, the record
//    shows it and MoMo's page counts it; with Mom's page in the background, a task MoMo
//    finishes reaches her phone; with it in front, nothing is pushed.
// Run through run.sh: tools/browser/run.sh mom  (about two minutes: pushes wait 20 s)
const http = require('node:http');
const { chromium } = require('playwright');
const { BASE, momContext, kidLink, voiceStub, said, waitSaid, nextSaid, watchErrors, setVisible, finish } = require('./lib.cjs');

const OUT = process.argv[2];
const problems = [];
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

// Stands in for the push service: run.sh points NOTIFY_URL here.
const pushes = [];
const catcher = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      pushes.push(JSON.parse(body));
    } catch {
      pushes.push({ raw: body });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
});

async function waitPush(test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = pushes.find(test);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

(async () => {
  await new Promise((r) => catcher.listen(Number(process.env.CHECK_PUSH_PORT || 8092), '127.0.0.1', r));
  const browser = await chromium.launch();
  const errors = [];

  // ---- a phone: login, the 管理 sheet, a test push ----
  {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 810 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(...voiceStub(1200));
    const page = await ctx.newPage();
    watchErrors(page, 'mom phone', errors);
    await page.goto(`${BASE}/parent`);
    await page.waitForSelector('#login:not([hidden])');
    await page.screenshot({ path: `${OUT}/phone_0login.png` });
    await page.fill('#password', process.env.CHECK_PW);
    await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('#start:not([hidden])');
    await page.tap('#startBtn');
    expect(/妈妈好/.test(await waitSaid(page, /妈妈好/)), 'she greets Mom');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/phone_1main.png` });
    await page.tap('#adminBtn');
    await page.tap('button[data-tab="tablet"]');
    const note = await page.textContent('#pushNote');
    expect(/^已开（网址）/.test(note), `管理 says pushes are on: ${note}`);
    await page.tap('#testPush');
    await page.waitForFunction(() => /已发出|没发出去/.test(document.getElementById('pushMsg').textContent), null, { timeout: 15000 });
    expect((await page.textContent('#pushMsg')).startsWith('已发出'), 'the test push goes out');
    const test = await waitPush((p) => /测试推送/.test(p.text || ''), 5000);
    expect(test && test.title === '沫沫的伙伴' && test.url === `${BASE}/parent`, `it arrives with a link back: ${JSON.stringify(test)}`);
    await page.screenshot({ path: `${OUT}/phone_2push.png` });
    await ctx.close();
  }

  // ---- a tablet each: Mom's and MoMo's ----
  const momCtx = await momContext(browser, { viewport: { width: 1065, height: 624 }, isMobile: true, hasTouch: true });
  const link = await kidLink(momCtx);
  await momCtx.addInitScript(...voiceStub(1200));
  const mom = await momCtx.newPage();
  watchErrors(mom, 'mom', errors);
  await mom.goto(`${BASE}/parent`);
  await mom.waitForSelector('#start:not([hidden])');
  await mom.tap('#startBtn');
  await waitSaid(mom, /妈妈好/);

  const kidB = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const kidCtx = await kidB.newContext({ viewport: { width: 1065, height: 624 }, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] });
  await kidCtx.addInitScript(...voiceStub(1200));
  const kid = await kidCtx.newPage();
  watchErrors(kid, 'kid', errors);
  await kid.goto(link);
  await kid.waitForSelector('#start:not([hidden])');
  await kid.tap('#startBtn');
  await kid.waitForTimeout(2500);

  // A slow answer: she says she is looking first, then answers; only the answer is kept.
  await mom.route('**/api/parent/chat', async (route) => {
    await new Promise((r) => setTimeout(r, 3500));
    await route.fulfill({ json: { reply: '沫沫今天的作业还没开始做。', actions: [] } });
  });
  const before = (await said(mom)).length;
  await mom.tap('#kbd');
  await mom.fill('#typeText', '沫沫作业写完了吗？');
  await mom.press('#typeText', 'Enter');
  const first = await nextSaid(mom, before, 6000);
  expect(/看看|查一下|翻翻|看一下/.test(first), `a slow answer starts with a word that she is looking: ${first}`);
  expect((await nextSaid(mom, before + 1, 10000)) === '沫沫今天的作业还没开始做。', 'then the answer');
  const chat = await mom.$$eval('#chat li', (li) => li.map((x) => x.textContent));
  expect(chat.slice(-2).join('|') === '沫沫作业写完了吗？|沫沫今天的作业还没开始做。' && !chat.includes(first), `刚才说的 keeps the question and the answer, not "${first}": ${chat.join(' | ')}`);
  await mom.unroute('**/api/parent/chat');
  await mom.tap('#kbd');

  // A look-in: MoMo's tablet says so, shows the camera, takes a picture. (No vision
  // model here, so Mom hears that it couldn't be read, and can open the picture.)
  await mom.tap('button[data-check="posture"]');
  expect(/看看你的坐姿/.test(await waitSaid(kid, /坐姿/)), 'the tablet tells MoMo first');
  await kid.waitForSelector('#camBox:not([hidden])', { timeout: 5000 }).then(() => kid.screenshot({ path: `${OUT}/kid_1camera.png` }), () => expect(false, 'the camera view shows'));
  const heard = await waitSaid(mom, /照片拍到了|没拍到|摄像头/, 30000);
  expect(/照片拍到了/.test(heard), `Mom hears back: ${heard}`);
  await mom.waitForTimeout(800);
  await mom.screenshot({ path: `${OUT}/mom_1look.png` });
  await mom.tap('#photoClose').catch(() => {});
  const feed = await mom.$$eval('#feed li', (li) => li.map((x) => x.textContent));
  expect(feed.some((t) => /看看坐姿/.test(t)), 'the look is in the record');
  expect((await mom.$$('#feed .thumb')).length > 0, '...with its picture');
  await kid.waitForSelector('#looked:not([hidden])', { timeout: 5000 }).catch(() => {});
  const chip = await kid.textContent('#looked').catch(() => '');
  expect(/^📷 妈妈今天看过 1 次 · \d\d:\d\d$/.test(chip), `MoMo's page shows the look: ${chip}`);
  await kid.screenshot({ path: `${OUT}/kid_2looked.png` });

  // Mom's page in the background: MoMo finishes a task, and Mom's phone hears of it.
  const finishTask = () => kid.evaluate(async () => {
    const s = await (await fetch('/api/state')).json();
    const t = s.tasks.find((x) => x.status === 'todo');
    await fetch(`/api/tasks/${t.id}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return t.title;
  });
  await setVisible(mom, false);
  await mom.waitForTimeout(1500);
  pushes.length = 0;
  const task1 = await finishTask();
  const got = await waitPush((p) => (p.text || '').includes(task1), 35000);
  expect(got && /做完了，等你确认/.test(got.title), `with Mom's page closed, her phone hears: ${JSON.stringify(got)}`);

  // Back in front: the task waits for her, and nothing more is pushed.
  await setVisible(mom, true);
  await mom.waitForTimeout(2000);
  const waiting = await mom.$$eval('#tasks li.waiting .title', (li) => li.map((x) => x.textContent));
  expect(waiting.includes(task1), `the task waits for Mom to confirm: ${waiting.join(', ')}`);
  pushes.length = 0;
  const task2 = await finishTask();
  await mom.waitForTimeout(24000);
  expect(!pushes.length, `with Mom's page open, nothing is pushed (${task2})`);
  await mom.screenshot({ path: `${OUT}/mom_2back.png` });

  await kidB.close();
  await browser.close();
  catcher.close();
  finish([...problems, ...errors]);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
