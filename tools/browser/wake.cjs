// 语音唤醒 (no keys needed; about a minute and a half). The microphone plays recordings
// of the companion's own voice (test/fixtures/wake, made with her Doubao voice); the
// name is heard by the real listener (web/kws) in the page; what the recogniser "heard"
// is whatever the check answers for it.
//  1. MoMo's page loads the listener and says so: 👂 喊「云笈」;
//  2. a story with no name in it: nothing happens;
//  3. "云笈，明天上什么课？": she listens at once, the recording has the name and
//     the question in it, and she answers;
//  4. just "云笈": she says she is here, and listens for the question;
//  5. her name heard but the server finds it wasn't said (a television): she lets it go,
//     and still hears her name the next time;
//  6. turned off in 管理: no tag, and her name does nothing;
//  7. on a small phone, the tag fits in the top bar.
// Run through run.sh: tools/browser/run.sh wake
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { BASE, momContext, kidLink, voiceStub, said, watchErrors, finish } = require('./lib.cjs');

const OUT = process.argv[2];
const problems = [];
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const expect = (ok, what) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};
const clip = (name) => fs.readFileSync(path.join(__dirname, '../../test/fixtures/wake', `${name}.wav`)).toString('base64');

// A microphone that plays what the check gives it: window.__play(base64 WAV).
function fakeMic() {
  const ctx = new AudioContext();
  const out = ctx.createGain();
  window.__play = async (b64) => {
    await ctx.resume();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(out);
    src.start();
    await new Promise((r) => (src.onended = r));
  };
  navigator.mediaDevices.getUserMedia = async () => {
    await ctx.resume();
    const d = ctx.createMediaStreamDestination();
    out.connect(d);
    return d.stream;
  };
}

const mic = (page) => page.evaluate(() => ({ text: document.getElementById('mic').textContent, on: document.getElementById('mic').classList.contains('listening') }));
const listening = (page, ms) => page.waitForFunction(() => document.getElementById('mic').classList.contains('listening'), null, { timeout: ms }).then(() => true, () => false);
async function idle(page, ms = 15000) {
  const end = Date.now() + ms;
  let calm = 0;
  while (Date.now() < end) {
    const m = await mic(page);
    calm = m.text === '按一下说话' && !m.on ? calm + 1 : 0;
    if (calm >= 10) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const mom = await momContext(browser);
  const link = await kidLink(mom);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(...voiceStub(700));
  await ctx.addInitScript(fakeMic);
  const pad = await ctx.newPage();
  watchErrors(pad, 'pad', errors);
  pad.on('console', (m) => /\[wake\]/.test(m.text()) && log(`page: ${m.text()}`));

  // What the recogniser "heard", and what the tablet sent it.
  let heard = { text: '云笈，明天上什么课？', called: true, rest: '明天上什么课？' };
  const asked = [];
  await pad.route('**/api/asr', (route) => {
    const body = route.request().postDataJSON();
    const wav = Buffer.from(body.wav, 'base64');
    asked.push({ wake: Boolean(body.wake), seconds: (wav.length - 44) / 32000 });
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body.wake ? heard : { text: heard.text }) });
  });

  await pad.goto(link);
  await pad.waitForSelector('#start:not([hidden])');
  await pad.tap('#startBtn');

  // 1. The listener loads; the tag says what to call.
  const ready = await pad.waitForFunction(() => !document.getElementById('wakeTag').hidden, null, { timeout: 60000 }).then(() => true, () => false);
  expect(ready && (await pad.textContent('#wakeTag')) === '👂 喊「云笈」', `the tablet listens for her name: ${await pad.textContent('#wakeTag')}`);
  await pad.waitForTimeout(1500); // her hello, then a moment
  await pad.screenshot({ path: `${OUT}/1_listening_for_name.png` });

  // 2. A story with no name in it.
  await pad.evaluate((b) => window.__play(b), clip('story'));
  expect(!(await listening(pad, 2500)) && asked.length === 0, 'a story without her name: nothing happens, nothing is sent');

  // 3. Her name and a question, in one breath.
  let n = (await said(pad)).length;
  const playing = pad.evaluate((b) => window.__play(b), clip('yunji_ask'));
  const woke = await listening(pad, 6000);
  await playing;
  expect(woke, 'her name: she listens at once');
  await pad.waitForFunction((k) => (window.__said || []).length > k, n, { timeout: 20000 }).catch(() => {});
  const first = asked[0] || {};
  expect(first.wake && first.seconds >= 2.2, `the recording has her name and the question in it (${(first.seconds || 0).toFixed(1)} s, sent as a call by name)`);
  expect((await said(pad)).length > n, `and she answers: ${(await said(pad)).slice(-1)[0]}`);
  expect(await idle(pad), 'then she is done (nothing more said)');

  // 4. Just her name: she says she is here, and listens for the question.
  heard = { text: '云笈。', called: true, rest: '' };
  n = (await said(pad)).length;
  asked.length = 0;
  await pad.evaluate((b) => window.__play(b), clip('yunji'));
  await pad.waitForFunction((k) => (window.__said || []).length > k, n, { timeout: 15000 }).catch(() => {});
  const here = (await said(pad)).slice(-1)[0];
  expect(/^(我在！|嗯，我在呢～|来啦！你说～)$/.test(here || ''), `just her name: "${here}"`);
  const waits = await pad.waitForFunction(() => document.getElementById('mic').textContent === '还在听…', null, { timeout: 5000 }).then(() => true, () => false);
  expect(waits, 'and she listens for the question');
  await pad.screenshot({ path: `${OUT}/2_here.png` });
  expect(await idle(pad), 'no question: she stops');

  // 5. Her name heard, but the server finds it wasn't said: she lets it go.
  heard = { text: '街上挂满了星星灯笼', called: false, rest: '' };
  n = (await said(pad)).length;
  asked.length = 0;
  await pad.evaluate((b) => window.__play(b), clip('yunji'));
  await pad.waitForTimeout(4000);
  expect(asked.length === 1 && (await said(pad)).length === n && (await idle(pad)), 'not her name after all: checked once, nothing said');
  heard = { text: '云笈，明天上什么课？', called: true, rest: '明天上什么课？' };
  asked.length = 0;
  await pad.evaluate((b) => window.__play(b), clip('yunji_ask'));
  await pad.waitForTimeout(3000);
  expect(asked.length === 1, 'and she still hears her name the next time');
  await idle(pad);

  // 6. Turned off in 管理.
  const off = await mom.request.post(`${BASE}/api/parent/settings`, { data: { voice: { wake: false } } });
  expect(off.ok(), '语音唤醒 turned off in 管理');
  await pad.evaluate(async () => (await import('/companion.js')).app.reload());
  await pad.waitForTimeout(1000);
  asked.length = 0;
  await pad.evaluate((b) => window.__play(b), clip('yunji_ask'));
  expect(!(await listening(pad, 3000)) && asked.length === 0 && (await pad.isHidden('#wakeTag')), 'turned off: no tag, and her name does nothing');
  await mom.request.post(`${BASE}/api/parent/settings`, { data: { voice: { wake: true } } });

  // 7. On a small phone held upright, the tag fits in the top bar.
  const phoneCtx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  await phoneCtx.addInitScript(...voiceStub(700));
  await phoneCtx.addInitScript(fakeMic);
  const phone = await phoneCtx.newPage();
  watchErrors(phone, 'phone', errors);
  await phone.goto(link);
  await phone.waitForSelector('#start:not([hidden])');
  await phone.tap('#startBtn');
  await phone.waitForFunction(() => !document.getElementById('wakeTag').hidden, null, { timeout: 60000 }).catch(() => {});
  await phone.waitForTimeout(1500);
  const fit = await phone.evaluate(() => {
    const t = document.getElementById('wakeTag').getBoundingClientRect();
    return { shown: !document.getElementById('wakeTag').hidden, left: Math.round(t.left), right: Math.round(t.right), scroll: document.documentElement.scrollWidth, vw: innerWidth };
  });
  expect(fit.shown && fit.left >= 0 && fit.right <= fit.vw && fit.scroll <= fit.vw, `on a 360 px phone the tag fits: ${JSON.stringify(fit)}`);
  await phone.screenshot({ path: `${OUT}/3_phone.png` });

  await browser.close();
  finish([...problems, ...errors]);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
