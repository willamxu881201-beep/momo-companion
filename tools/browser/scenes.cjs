// The places she goes (no keys needed; about two minutes):
//  - every scene, by day and by night, on a tablet held sideways and on a phone held
//    upright: screenshots to look at, and on the phone the scene must reach below
//    her feet;
//  - a task due a minute from now: the companion speaks up on her own when its time
//    comes (a set line here, without the model) and the scene changes to its place;
//  - MoMo taps another task and starts it: the scene follows.
// Run through run.sh: tools/browser/run.sh scenes
const { chromium } = require('playwright');
const { BASE, momContext, parentState, voiceStub, said, waitSaid, bridge, watchErrors, finish } = require('./lib.cjs');

const OUT = process.argv[2];
const problems = [];
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};
const hhmm = (m) => `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m + 1440) % 1440) % 60).padStart(2, '0')}`;
const SCENES = ['courtyard', 'sky', 'study', 'piano', 'gym', 'outdoor', 'bedroom'];
const sceneNow = (page) => page.evaluate(() => (document.querySelector('#scene img.on') || {}).src || '');

async function tour(page, tag) {
  for (const key of SCENES) {
    for (const night of [false, true]) {
      await page.evaluate(([k, n]) => showScene({ key: k, night: n }), [key, night]);
      await page.waitForFunction((k) => (document.querySelector('#scene img.on') || {}).src?.includes(`/${k}_`), key, { timeout: 10000 });
      await page.waitForTimeout(1400); // the cross-fade
      await page.screenshot({ path: `${OUT}/${tag}_${key}_${night ? 'night' : 'day'}.png` });
    }
  }
}

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const mom = await momContext(browser);
  let ps = await parentState(mom);
  // A piano practice that is due in a minute or two.
  const due = hhmm(ps.now.minutes + 1);
  await mom.request.post(`${BASE}/api/parent/templates`, { data: { title: '练琴', icon: '🎹', time: due, minutes: 20, days: 'every' } });
  ps = await parentState(mom);
  const link = `${BASE}/?k=${ps.kidKey}`;

  // ---- a tablet held sideways ----
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(...voiceStub(1500));
  const pad = await ctx.newPage();
  watchErrors(pad, 'pad', errors);
  await pad.goto(link);
  await pad.waitForSelector('#start:not([hidden])');
  await bridge(pad);
  await pad.tap('#startBtn');
  await pad.waitForFunction(() => document.querySelector('#scene img.on'), null, { timeout: 10000 });
  expect(/\/courtyard_(day|night)\.webp$/.test(await sceneNow(pad)), `free time is in the courtyard: ${await sceneNow(pad)}`);
  await tour(pad, 'pad');
  await pad.evaluate(() => app.reload());
  await pad.waitForTimeout(1500);

  // The practice comes due: she says so on her own, and they go to the piano room.
  const line = await waitSaid(pad, /练琴/, 150000).catch(() => null);
  expect(Boolean(line), `she speaks up when it is time: ${line}`);
  await pad.waitForFunction(() => (document.querySelector('#scene img.on') || {}).src?.includes('/piano_'), null, { timeout: 40000 }).catch(() => {});
  expect((await sceneNow(pad)).includes('/piano_'), 'the scene is the piano room');
  expect((await pad.textContent('#next')).startsWith('现在：🎹练琴'), `the bar says what's on: ${await pad.textContent('#next')}`);
  await pad.waitForTimeout(1500);
  await pad.screenshot({ path: `${OUT}/pad_due.png` });

  // MoMo taps homework and starts it: off to the study.
  const n = (await said(pad)).length;
  await pad.tap('.rail [data-panel="tasks"]');
  await pad.locator('#tasks button', { hasText: '写作业' }).tap();
  await pad.waitForSelector('#confirm:not([hidden])');
  expect(await pad.isVisible('#confirmStart'), 'a task not begun can be started');
  await pad.tap('#confirmStart');
  await pad.waitForFunction((k) => (window.__said || []).length > k, n, { timeout: 10000 });
  expect(/书房/.test((await said(pad))[n]), `she says where they go: ${(await said(pad))[n]}`);
  await pad.waitForFunction(() => (document.querySelector('#scene img.on') || {}).src?.includes('/study_'), null, { timeout: 10000 }).catch(() => {});
  expect((await sceneNow(pad)).includes('/study_'), 'the scene is the study');
  await pad.waitForTimeout(1500);
  await pad.screenshot({ path: `${OUT}/pad_started.png` });

  // ---- a phone held upright ----
  const phoneCtx = await browser.newContext({ viewport: { width: 400, height: 810 }, isMobile: true, hasTouch: true });
  await phoneCtx.addInitScript(...voiceStub(1500));
  const phone = await phoneCtx.newPage();
  watchErrors(phone, 'phone', errors);
  await phone.goto(link);
  await phone.waitForSelector('#start:not([hidden])');
  await bridge(phone);
  await phone.tap('#startBtn');
  await phone.waitForTimeout(2500);
  const fit = await phone.evaluate(() => {
    const s = document.getElementById('scene').getBoundingClientRect();
    const g = document.getElementById('girlFig').getBoundingClientRect();
    return { sceneBottom: Math.round(s.bottom), girlBottom: Math.round(g.bottom), sceneTop: Math.round(s.top), width: Math.round(s.width), vw: innerWidth };
  });
  expect(fit.sceneTop <= 0 && fit.width >= fit.vw && fit.sceneBottom >= fit.girlBottom, `on a phone the scene fills the top, past her feet: ${JSON.stringify(fit)}`);
  await tour(phone, 'phone');

  await browser.close();
  finish([...problems, ...errors]);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
