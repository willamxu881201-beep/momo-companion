// MoMo's files on her page (no keys needed; about a minute):
//  - Mom sends a recording: on MoMo's tablet the 📁 button gets a red mark and the
//    companion says so; the list shows it as new, from Mom; it opens and plays (the
//    file comes in byte ranges, as players ask for it); the mark is gone once she looked;
//  - MoMo sends a picture of her own: it is in her list too, as hers;
//  - the same on a phone held upright. Screenshots of each.
// Run through run.sh: tools/browser/run.sh files
const { chromium } = require('playwright');
const { BASE, momContext, kidLink, voiceStub, said, waitSaid, watchErrors, finish } = require('./lib.cjs');

const OUT = process.argv[2];
const problems = [];
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

// A second of a soft tone, as a WAV file the browser can play.
function tone() {
  const rate = 8000;
  const pcm = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i += 1) pcm.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

async function open(browser, link, viewport, errors, tag) {
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
  await ctx.addInitScript(...voiceStub(800));
  const page = await ctx.newPage();
  watchErrors(page, tag, errors);
  await page.goto(link);
  await page.waitForSelector('#start:not([hidden])');
  await page.tap('#startBtn');
  await waitSaid(page, /我在这儿呢/);
  return page;
}

const items = (page) => page.$$eval('#fileItems li button', (bs) => bs.map((b) => ({ name: b.querySelector('.name').textContent, meta: b.querySelector('.meta').textContent, fresh: !b.querySelector('.new').hidden })));

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const mom = await momContext(browser);
  const link = await kidLink(mom);

  // ---- a tablet held sideways ----
  const pad = await open(browser, link, { width: 1280, height: 800 }, errors, 'pad');
  expect(await pad.isHidden('#filesNew'), 'nothing new at first');
  const sent = await mom.request.post(`${BASE}/api/upload?name=${encodeURIComponent('钢琴曲.wav')}`, { data: tone(), headers: { 'Content-Type': 'audio/wav' } });
  const song = await sent.json();
  expect(song.kind === 'stored', `Mom's recording is kept: ${song.line}`);
  const told = await waitSaid(pad, /妈妈给你发来了/, 20000).catch(() => null);
  expect(/妈妈给你发来了《钢琴曲》，点文件夹就能看/.test(told || ''), `the companion tells MoMo: ${told}`);
  await pad.waitForSelector('#filesNew:not([hidden])', { timeout: 10000 }).catch(() => {});
  expect((await pad.textContent('#filesNew')) === '1', 'a red mark on the folder');
  await pad.screenshot({ path: `${OUT}/pad_new.png` });

  // MoMo shows the companion a picture of her own (no keys: it can't be read, but it is kept).
  await pad.setInputFiles('#photoInput', { name: 'drawing.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await pad.waitForFunction(() => (window.__said || []).some((l) => /存好了/.test(l)), null, { timeout: 30000 }).catch(() => {});

  await pad.tap('#filesBtn');
  await pad.waitForSelector('#files:not([hidden]) #fileItems li');
  const list = await items(pad);
  console.log(`list: ${JSON.stringify(list)}`);
  expect(list.length === 2, 'two files: one from Mom, one of hers');
  expect(list.some((f) => f.name === '钢琴曲' && f.fresh && f.meta.startsWith('妈妈发的')), "Mom's recording, marked new");
  expect(list.some((f) => f.name === 'drawing' && !f.fresh && f.meta.startsWith('我发的')), 'her own picture');
  await pad.screenshot({ path: `${OUT}/pad_list.png` });
  await pad.waitForSelector('#filesNew[hidden]', { state: 'attached', timeout: 10000 }).catch(() => {});
  expect(await pad.isHidden('#filesNew'), 'the mark is gone once she has looked');

  // It opens, and plays.
  await pad.locator('#fileItems button', { hasText: '钢琴曲' }).tap();
  await pad.waitForSelector('#fileView:not([hidden]) #fileShow audio');
  const meta = await pad.textContent('#fileMeta');
  expect(/^妈妈发给你的音频/.test(meta), `what it is: ${meta}`);
  const played = await pad.evaluate(async () => {
    const a = document.querySelector('#fileShow audio');
    a.muted = true;
    await a.play();
    await new Promise((r) => setTimeout(r, 600));
    return { duration: a.duration, at: a.currentTime, paused: a.paused };
  });
  expect(played.duration > 0.9 && played.at > 0.2 && !played.paused, `it plays: ${JSON.stringify(played)}`);
  expect(await pad.isVisible('#fileOpen') && (await pad.getAttribute('#fileOpen', 'href')) === `/api/files/${song.fileId}`, 'the original can be opened');
  await pad.screenshot({ path: `${OUT}/pad_song.png` });
  await pad.tap('#fileBack');
  expect(await pad.isVisible('#fileList'), 'back to the list');
  await pad.tap('#filesClose');
  expect(await pad.isHidden('#files'), 'and closed');
  const ranged = await mom.request.get(`${BASE}/api/files/${song.fileId}`, { headers: { Range: 'bytes=0-3' } });
  expect(ranged.status() === 206 && (await ranged.body()).toString() === 'RIFF', 'the file comes in byte ranges');

  // ---- a phone held upright ----
  const phone = await open(browser, link, { width: 400, height: 810 }, errors, 'phone');
  const dock = await phone.evaluate(() => [...document.querySelectorAll('.talk > button')].map((b) => {
    const r = b.getBoundingClientRect();
    return { id: b.id, right: Math.round(r.right), w: Math.round(r.width) };
  }));
  expect(dock.every((b) => b.right <= 400 && b.w > 30), `the dock fits the phone: ${JSON.stringify(dock)}`);
  await phone.screenshot({ path: `${OUT}/phone.png` });
  await phone.tap('#filesBtn');
  await phone.waitForSelector('#files:not([hidden]) #fileItems li');
  await phone.screenshot({ path: `${OUT}/phone_list.png` });
  await phone.locator('#fileItems button', { hasText: 'drawing' }).tap();
  await phone.waitForSelector('#fileView:not([hidden])');
  const mine = await phone.evaluate(() => ({ meta: document.getElementById('fileMeta').textContent, gist: document.getElementById('fileGist').textContent, img: Boolean(document.querySelector('#fileShow img')) }));
  expect(mine.img && /^你发给伙伴的/.test(mine.meta), `her picture is shown: ${JSON.stringify(mine)}`);
  await phone.screenshot({ path: `${OUT}/phone_picture.png` });
  console.log(`--- the tablet said:\n${(await said(pad)).join('\n')}`);

  await browser.close();
  finish([...problems, ...errors]);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
