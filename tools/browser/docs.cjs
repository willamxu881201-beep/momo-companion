// Documents with the real models (run.sh docs --real; a few fen). The documents are
// the made-up ones in test/fixtures.
//  1. Mom sends a Word notice and asks what to bring; an Excel score sheet and asks
//     which subject is weakest; a scanned PDF (read as pictures).
//  2. The record shows them; a document's card opens.
//  3. MoMo sends slides from class and asks about them; Mom asks for a summary of them.
const path = require('node:path');
const { chromium } = require('playwright');
const { BASE, momContext, kidLink, voiceStub, said, waitSaid, nextSaid, watchErrors, finish } = require('./lib.cjs');

const OUT = process.argv[2];
const FIXTURES = path.join(__dirname, '../../test/fixtures');
const problems = [];
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const expect = (ok, what) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};
const HOLD_ON = /^(好的～|好，马上办。|好的，我看看～|嗯，我查一下哦。|好，我翻翻今天的记录。|稍等，我看一下。)$/; // see mom.js

// What she says next, past a "let me look" while the answer is on its way.
async function answer(page, before, ms = 90000) {
  let line = await nextSaid(page, before, ms);
  if (HOLD_ON.test(line)) line = await nextSaid(page, before + 1, ms);
  return line;
}

async function send(page, file) {
  const n = (await said(page)).length;
  await page.setInputFiles('#photoInput', path.join(FIXTURES, file));
  return answer(page, n, 120000);
}

async function ask(page, text) {
  const n = (await said(page)).length;
  if (await page.isHidden('#typeForm')) await page.tap('#kbd');
  await page.fill('#typeText', text);
  await page.press('#typeText', 'Enter');
  return answer(page, n);
}

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const momCtx = await momContext(browser, { viewport: { width: 1065, height: 624 }, isMobile: true, hasTouch: true });
  const link = await kidLink(momCtx);
  await momCtx.addInitScript(...voiceStub(800));
  const mom = await momCtx.newPage();
  watchErrors(mom, 'mom', errors);
  await mom.goto(`${BASE}/parent`);
  await mom.waitForSelector('#start:not([hidden])');
  await mom.tap('#startBtn');
  await waitSaid(mom, /妈妈好/);
  log('mom page up');

  // 1. Mom's documents.
  const notice = await send(mom, 'notice.docx');
  log(`notice: ${notice}`);
  expect(/^我看完了《/.test(notice) && /11月6日/.test(notice), 'the notice is summed up, with its date');
  await mom.screenshot({ path: `${OUT}/1_mom_notice.png` });
  const bring = await ask(mom, '运动会那天要带什么？几点到校？');
  log(`what to bring: ${bring}`);
  expect(/水壶/.test(bring) && /(7:30|7点半|七点半)/.test(bring), 'answered from the notice');

  const scores = await send(mom, 'scores.xlsx');
  log(`scores: ${scores}`);
  const weakest = await ask(mom, '沫沫哪科最弱？四科平均多少分？');
  log(`weakest: ${weakest}`);
  expect(/科学/.test(weakest) && /88\.5/.test(weakest), 'answered from the score sheet');

  const scan = await send(mom, 'scan.pdf');
  log(`scan: ${scan}`);
  expect(/家长会/.test(scan), 'the scan is read');

  // 2. The record and a document's card.
  await mom.waitForTimeout(1500);
  const feed = await mom.$$eval('#feed li .what', (w) => w.map((x) => x.textContent));
  log(`feed: ${feed.join(' | ')}`);
  expect(feed.filter((t) => t.startsWith('📄')).length === 3, 'three documents in the record');
  await mom.tap('#feed .thumb.doc');
  await mom.waitForSelector('#docSheet:not([hidden])');
  const card = await mom.evaluate(() => ({ title: document.getElementById('docTitle').textContent, items: document.querySelectorAll('#docMore li').length, save: document.getElementById('docSave').getAttribute('href') }));
  log(`card: ${JSON.stringify(card)}`);
  expect(card.title && card.items > 0 && /download=1$/.test(card.save), 'a card with its points and the file to save');
  await mom.screenshot({ path: `${OUT}/2_mom_card.png` });
  await mom.tap('#docClose');

  // 3. MoMo's slides.
  const kidCtx = await browser.newContext({ viewport: { width: 1065, height: 624 }, isMobile: true, hasTouch: true });
  await kidCtx.addInitScript(...voiceStub(800));
  const kid = await kidCtx.newPage();
  watchErrors(kid, 'kid', errors);
  await kid.goto(link);
  await kid.waitForSelector('#start:not([hidden])');
  await kid.tap('#startBtn');
  await nextSaid(kid, 0);
  const slides = await send(kid, 'lesson.pptx');
  log(`kid slides: ${slides}`);
  expect(/^我看完啦/.test(slides), 'MoMo hears what the slides are');
  const numerator = await ask(kid, '分子在哪里呀？');
  log(`kid asked: ${numerator}`);
  expect(/上面|上边|上方/.test(numerator), 'answered from the slides');
  await kid.screenshot({ path: `${OUT}/3_kid_slides.png` });
  const summary = await ask(mom, '总结一下沫沫刚发的课件');
  log(`summary: ${summary}`);
  expect(/分数/.test(summary), "Mom gets a summary of MoMo's slides");
  await mom.screenshot({ path: `${OUT}/4_mom_summary.png` });

  console.log(`--- Mom's page said:\n${(await said(mom)).join('\n')}`);
  console.log(`--- MoMo's tablet said:\n${(await said(kid)).join('\n')}`);
  await browser.close();
  finish([...problems, ...errors]);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
