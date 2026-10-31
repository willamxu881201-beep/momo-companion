// 连续对话 (no keys needed; about a minute and a half). The microphone is a tone the
// check switches on and off (someone talking, or not); what the recogniser "heard" is
// whatever the check answers for it.
//  1. On the tablet: a tap on the mic, words, her answer; then she listens on by herself
//     (the mic says 还在听…), hears more, answers again;
//  2. with nothing more said, she stops listening after a few seconds;
//  3. someone who keeps talking (a television) gets five turns of listening on, no more;
//  4. with 连续对话 turned off in 管理, she doesn't listen on;
//  5. Mom's page listens on the same way.
// Run through run.sh: tools/browser/run.sh listen
const { chromium } = require('playwright');
const { BASE, momContext, kidLink, voiceStub, said, watchErrors, finish } = require('./lib.cjs');

const problems = [];
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const expect = (ok, what) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

// A microphone the check controls: window.__talk(true) and the page hears a voice.
function fakeMic() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 300;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain);
  osc.start();
  window.__talk = (on) => {
    gain.gain.value = on ? 0.4 : 0;
  };
  navigator.mediaDevices.getUserMedia = async () => {
    await ctx.resume();
    const d = ctx.createMediaStreamDestination(); // a new one each time: the page stops the last one's track
    gain.connect(d);
    return d.stream;
  };
}

async function open(ctx, url, errors, tag) {
  const page = await ctx.newPage();
  watchErrors(page, tag, errors);
  page.asked = 0;
  await page.route('**/api/asr', (route) => {
    page.asked += 1;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: '我还想问一个问题' }) });
  });
  await page.goto(url);
  await page.waitForSelector('#start:not([hidden])');
  await page.tap('#startBtn');
  await page.waitForTimeout(1500);
  return page;
}

const mic = (page) => page.evaluate(() => ({ text: document.getElementById('mic').textContent, on: document.getElementById('mic').classList.contains('listening') }));
const listeningOn = (page, ms = 8000) => page.waitForFunction(() => document.getElementById('mic').textContent === '还在听…', null, { timeout: ms }).then(() => true, () => false);

// At rest for good: the mic stays as it is between turns for two seconds (longer than
// the breath she takes before listening on).
async function idle(page, ms = 12000) {
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

// Says something (a second of voice, then quiet) and waits for her answer. True when
// it was heard and sent once.
async function turn(page) {
  const asked = page.asked;
  const n = (await said(page)).length;
  await page.evaluate(() => window.__talk(true));
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__talk(false));
  await page.waitForFunction((k) => (window.__said || []).length > k, n, { timeout: 15000 }).catch(() => {});
  return page.asked === asked + 1;
}

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const mom = await momContext(browser, { viewport: { width: 400, height: 810 }, isMobile: true, hasTouch: true });
  const link = await kidLink(mom);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(...voiceStub(800));
  await ctx.addInitScript(fakeMic);
  const pad = await open(ctx, link, errors, 'pad');

  // 1. A tap, words, her answer, then she listens on; more words, another answer.
  await pad.tap('#mic');
  expect(await turn(pad), `heard and answered: ${(await said(pad)).slice(-1)[0]}`);
  expect(await listeningOn(pad), 'after her answer she listens on by herself (还在听…)');
  await pad.screenshot({ path: `${process.argv[2]}/pad_listening_on.png` });
  expect(await turn(pad), 'more words: heard and answered');
  expect(await listeningOn(pad), 'and on she listens');

  // 2. Nothing more said: she stops by herself.
  const quietFrom = Date.now();
  const stopped = await idle(pad, 14000);
  const after = (Date.now() - quietFrom) / 1000 - 2; // less the two calm seconds idle() waits out
  expect(stopped && after > 4.5 && after < 8, `nothing said: she stops listening after about ${after.toFixed(1)} s`);
  expect(pad.asked === 2, 'and sends nothing');

  // 3. A television that never stops: five turns of listening on, then she stops.
  pad.asked = 0;
  await pad.tap('#mic');
  await turn(pad);
  let on = 0;
  while (on < 8 && (await listeningOn(pad, 9000))) {
    on += 1;
    await turn(pad);
  }
  expect(on === 5 && pad.asked === 6 && (await idle(pad, 6000)), `a tap and five turns on her own, then she stops: ${on} turns, ${pad.asked} heard`);

  // 4. Turned off in 管理: she answers, and doesn't listen on.
  const off = await mom.request.post(`${BASE}/api/parent/settings`, { data: { voice: { followUp: false } } });
  expect(off.ok(), '连续对话 turned off in 管理');
  await pad.evaluate(async () => (await import('/companion.js')).app.reload());
  await pad.waitForTimeout(800);
  pad.asked = 0;
  await pad.tap('#mic');
  await turn(pad);
  expect(!(await listeningOn(pad, 4000)) && pad.asked === 1 && (await idle(pad, 4000)), 'turned off: she answers and stops');
  await mom.request.post(`${BASE}/api/parent/settings`, { data: { voice: { followUp: true } } });

  // 5. Mom's page listens on the same way.
  await mom.addInitScript(...voiceStub(800));
  await mom.addInitScript(fakeMic);
  const momPage = await open(mom, `${BASE}/parent`, errors, 'mom');
  await momPage.tap('#mic');
  expect(await turn(momPage), `Mom's page: heard and answered: ${(await said(momPage)).slice(-1)[0]}`);
  expect(await listeningOn(momPage, 8000), "and Mom's page listens on too");
  await momPage.screenshot({ path: `${process.argv[2]}/mom_listening_on.png` });
  expect(await idle(momPage, 14000), "and stops when nothing more is said");

  await browser.close();
  finish([...problems, ...errors]);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
