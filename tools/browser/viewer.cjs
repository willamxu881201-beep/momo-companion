// The file viewer on MoMo's page (no keys needed; about a minute). A page of homework
// is drawn here (made-up problems, as text); what the vision model would say about it is
// answered by the check: its problems' places, an answer about a touched spot, where
// "第六题" is.
//  1. The rail opens 图书馆 on the right; the page opens in it, wider, with its problems
//     outlined and numbered; the characters make room.
//  2. A touch on problem 3: a ring there, problem 3 lit at once, and her answer, with
//     the place she talks about lit.
//  3. "第六题怎么做？" typed: problem 6 is lit while she answers.
//  4. Closed: the right side is empty again; the bubble stays on the stage.
//  5. On a phone held upright, the page opens over the lower part and can be touched.
// Run through run.sh: tools/browser/run.sh viewer
const { chromium } = require('playwright');
const { momContext, kidLink, voiceStub, said, watchErrors, finish, homeworkPage } = require('./lib.cjs');

const OUT = process.argv[2];
const problems = [];
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const expect = (ok, what) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

// The problems on the page drawn below, where they are (thousandths of the page).
const PLACES = [
  { n: '1', box: [62, 145, 351, 175] },
  { n: '2', box: [62, 219, 605, 287] },
  { n: '3', box: [62, 353, 439, 459] },
  { n: '4', box: [526, 353, 706, 458] },
  { n: '5', box: [62, 537, 503, 641] },
  { n: '6', box: [62, 703, 625, 832] },
];
const hot = (page) => page.evaluate(() => {
  const m = document.querySelector('#marks .mark.hot');
  if (!m) return null;
  return ['left', 'top', 'width', 'height'].map((k) => Math.round(parseFloat(m.style[k]) * 10));
});

async function kidPage(browser, link, viewport, errors, tag) {
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
  await ctx.addInitScript(...voiceStub(500));
  const page = await ctx.newPage();
  watchErrors(page, tag, errors);
  // What the vision model would say: the problems' places, an answer, where "第六题" is.
  await page.route('**/api/files/*/pages', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    route.fulfill({ response: res, json: { ...body, problems: PLACES } });
  });
  page.pointed = [];
  await page.route('**/api/files/*/point', (route) => {
    page.pointed.push(route.request().postDataJSON());
    route.fulfill({ json: { reply: '这是第三题，说的是把蛋糕平均分成4份。你想想，每一份是多少呀？', box: [62, 353, 439, 459], page: 1 } });
  });
  await page.route('**/api/files/*/find', (route) => {
    const { text } = route.request().postDataJSON();
    route.fulfill({ json: { box: /第六题|第6题/.test(text) ? [62, 703, 625, 832] : null } });
  });
  await page.goto(link);
  await page.waitForSelector('#start:not([hidden])');
  await page.tap('#startBtn');
  await page.waitForTimeout(2000);
  return page;
}

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const mom = await momContext(browser);
  const link = await kidLink(mom);

  // The page of homework, as a photo MoMo sent (no keys: kept unread, a photo all the same).
  const png = await homeworkPage(browser);

  // ---- a tablet held sideways ----
  const pad = await kidPage(browser, link, { width: 1280, height: 800 }, errors, 'pad');
  const sent = await pad.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const res = await fetch('/api/upload?name=homework.png', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes });
    return res.json();
  }, png.toString('base64'));
  log(`homework sent: ${sent.kind} (#${sent.fileId})`);
  const before = await pad.evaluate(() => Math.round(document.getElementById('stage').getBoundingClientRect().width));
  expect(await pad.isHidden('#side'), 'the right side is empty at first');

  // 1. The library, and the page in it.
  await pad.tap('.rail [data-panel="files"]');
  await pad.waitForSelector('#fileItems li button');
  await pad.tap('#fileItems li button');
  await pad.waitForSelector('#paperBox:not([hidden]) #paperImg');
  await pad.waitForFunction(() => document.getElementById('paperImg').complete && document.querySelectorAll('#marks .mark.problem').length > 0, null, { timeout: 15000 }).catch(() => {});
  const shown = await pad.evaluate(() => ({
    reading: document.body.classList.contains('reading'),
    outlined: [...document.querySelectorAll('#marks .mark.problem b')].map((b) => b.textContent),
    side: Math.round(document.getElementById('side').getBoundingClientRect().width),
    stage: Math.round(document.getElementById('stage').getBoundingClientRect().width),
    img: document.getElementById('paperImg').naturalWidth,
  }));
  log(`viewer: ${JSON.stringify(shown)}`);
  expect(shown.reading && shown.img > 0, 'the page opens in the panel');
  expect(shown.outlined.join(',') === '1,2,3,4,5,6', 'its problems are outlined and numbered');
  expect(shown.stage < before && shown.side > 500, `the panel widens to read in, the characters make room (stage ${before} -> ${shown.stage} px)`);
  await pad.waitForTimeout(800);
  await pad.screenshot({ path: `${OUT}/1_page_open.png` });

  // 2. A touch on problem 3.
  let n = (await said(pad)).length;
  const box = await pad.evaluate(() => {
    const r = document.getElementById('paper').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await pad.touchscreen.tap(box.x + box.w * 0.25, box.y + box.h * 0.4);
  await pad.waitForSelector('#marks .tap');
  const lit = await hot(pad);
  expect(JSON.stringify(lit) === JSON.stringify([62, 353, 377, 106]), `problem 3 lights up at once: ${JSON.stringify(lit)}`);
  await pad.waitForFunction((k) => (window.__said || []).length > k, n, { timeout: 10000 }).catch(() => {});
  const asked = pad.pointed[0] || {};
  expect(Math.abs(asked.x - 0.25) < 0.02 && Math.abs(asked.y - 0.4) < 0.02 && asked.page === 1, `the touched spot is sent: ${JSON.stringify(asked)}`);
  expect(/第三题/.test((await said(pad)).slice(-1)[0] || ''), `she answers: ${(await said(pad)).slice(-1)[0]}`);
  await pad.waitForTimeout(400);
  await pad.screenshot({ path: `${OUT}/2_touched.png` });

  // 3. A question about problem 6, typed: it lights up while she answers.
  await pad.waitForFunction(() => document.getElementById('mic').textContent === '按一下说话', null, { timeout: 15000 }).catch(() => {});
  n = (await said(pad)).length;
  for (let i = 0; i < 3 && (await pad.isHidden('#typeForm')); i += 1) {
    await pad.tap('#kbd');
    await pad.waitForSelector('#typeForm:not([hidden])', { timeout: 2000 }).catch(() => {});
  }
  await pad.fill('#typeText', '第六题怎么做？');
  await pad.press('#typeText', 'Enter');
  await pad.waitForFunction(() => {
    const m = document.querySelector('#marks .mark.hot');
    return m && Math.round(parseFloat(m.style.top) * 10) === 703;
  }, null, { timeout: 10000 }).catch(() => {});
  expect(JSON.stringify(await hot(pad)) === JSON.stringify([62, 703, 563, 129]), `"第六题" lights problem 6: ${JSON.stringify(await hot(pad))}`);
  await pad.waitForFunction((k) => (window.__said || []).length > k, n, { timeout: 15000 }).catch(() => {});
  await pad.waitForTimeout(600);
  await pad.screenshot({ path: `${OUT}/3_asked.png` });

  // 4. Closed: empty again, and her words stay on the stage.
  await pad.tap('#fileView [data-close]');
  await pad.waitForTimeout(500);
  const after = await pad.evaluate(() => {
    const b = document.getElementById('bubble').getBoundingClientRect();
    const st = document.getElementById('stage').getBoundingClientRect();
    return { hidden: getComputedStyle(document.getElementById('side')).display === 'none', reading: document.body.classList.contains('reading'), stage: Math.round(st.width), bubbleIn: document.getElementById('bubble').hidden || (b.left >= st.left - 2 && b.right <= innerWidth) };
  });
  expect(after.hidden && !after.reading && after.stage === before, `closed: the right side is empty again (stage ${after.stage} px)`);
  expect(after.bubbleIn, 'her bubble stays on the stage');

  // ---- a phone held upright ----
  const phone = await kidPage(browser, link, { width: 400, height: 810 }, errors, 'phone');
  await phone.tap('.rail [data-panel="files"]');
  await phone.waitForSelector('#fileItems li button');
  await phone.tap('#fileItems li button');
  await phone.waitForFunction(() => document.getElementById('paperImg').complete && document.querySelectorAll('#marks .mark.problem').length > 0, null, { timeout: 15000 }).catch(() => {});
  const fit = await phone.evaluate(() => {
    const s = document.getElementById('side').getBoundingClientRect();
    const d = document.querySelector('.dock').getBoundingClientRect();
    return { left: Math.round(s.left), right: Math.round(s.right), bottom: Math.round(s.bottom), dockTop: Math.round(d.top), vw: innerWidth, scroll: document.documentElement.scrollWidth };
  });
  expect(fit.left >= 0 && fit.right <= fit.vw && fit.bottom <= fit.dockTop && fit.scroll <= fit.vw, `on a phone the page opens over the lower part, above the mic: ${JSON.stringify(fit)}`);
  const pbox = await phone.evaluate(() => {
    const r = document.getElementById('paper').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await phone.touchscreen.tap(pbox.x + pbox.w * 0.25, pbox.y + pbox.h * 0.4);
  await phone.waitForFunction(() => (window.__said || []).some((l) => /第三题/.test(l)), null, { timeout: 10000 }).catch(() => {});
  expect(phone.pointed.length === 1, 'and a touch there asks her');
  await phone.waitForTimeout(500);
  await phone.screenshot({ path: `${OUT}/4_phone.png` });

  await browser.close();
  finish([...problems, ...errors]);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
