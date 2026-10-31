// What the browser checks share: where the throwaway server is (run.sh starts it), Mom's
// login, the kid link, a stand-in for the browser's own voice that records each line,
// and a bridge that puts the companion's module on `window` for a check to drive.

const BASE = process.env.CHECK_BASE || 'http://127.0.0.1:8091';

// A browser context logged in as Mom.
async function momContext(browser, options = {}) {
  const ctx = await browser.newContext(options);
  const r = await ctx.request.post(`${BASE}/api/parent/login`, { data: { password: process.env.CHECK_PW } });
  if (!r.ok()) throw new Error(`Mom's login: HTTP ${r.status()}`);
  return ctx;
}

async function parentState(ctx) {
  return (await ctx.request.get(`${BASE}/api/parent/state`)).json();
}

// The tablet's link, with its key.
async function kidLink(ctx) {
  return `${BASE}/?k=${(await parentState(ctx)).kidKey}`;
}

// For context.addInitScript(...voiceStub(ms)): no real voice; each line "lasts" ms and
// is kept in window.__said, so a check can wait for what she says.
const voiceStub = (ms = 1200) => [
  (ms) => {
    window.__said = [];
    speechSynthesis.speak = (u) => {
      window.__said.push(u.text);
      setTimeout(() => u.onend && u.onend(), ms);
    };
    speechSynthesis.cancel = () => {};
  },
  ms,
];

const said = (page) => page.evaluate(() => window.__said || []);

// Waits until she has said a line matching re; returns it.
async function waitSaid(page, re, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = (await said(page)).find((x) => re.test(x));
    if (hit) return hit;
    await page.waitForTimeout(300);
  }
  throw new Error(`never said ${re}; said: ${JSON.stringify(await said(page))}`);
}

// The next line she says after the ones said so far.
async function nextSaid(page, before, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await said(page);
    if (s.length > before) return s[before];
    await page.waitForTimeout(300);
  }
  throw new Error(`said nothing new; said: ${JSON.stringify(await said(page))}`);
}

// The pages are ES modules: put the companion's exports (say, look, petLife, …) and a
// few internals on window, where the checks call them.
function bridge(page) {
  return page.evaluate(async () => {
    const m = await import('/companion.js');
    Object.assign(window, m);
    for (const k of ['SPRITES', 'audioCtx']) Object.defineProperty(window, k, { get: () => m.internals[k], configurable: true });
    Object.assign(window, { bubble: m.internals.bubble, VoicePlayer: m.internals.VoicePlayer, playVoice: m.internals.playVoice });
    Object.defineProperty(window, 'state', { get: () => m.app.state, configurable: true });
  });
}

// Page errors and console errors, gathered under a tag.
function watchErrors(page, tag, into) {
  page.on('pageerror', (e) => into.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_FAILED|status of 4\d\d/.test(m.text())) into.push(`${tag} console: ${m.text()}`);
  });
}

// Pretends the page went to the background (or came back): the browser tells the
// page through visibilitychange, which is all the pages listen to.
function setVisible(page, visible) {
  return page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { value: v ? 'visible' : 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: !v, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
}

// Ends a check: prints what went wrong and sets the exit code.
function finish(problems) {
  console.log(problems.length ? `PROBLEMS\n${problems.join('\n')}` : 'PROBLEMS none');
  if (problems.length) process.exitCode = 1;
}

// A page of homework, drawn here as a picture (made-up problems, as text): 900 x 1200.
// Its problems are where viewer.cjs says they are.
const HOMEWORK = `<!doctype html><meta charset="utf-8"><style>
body { margin: 0; width: 900px; height: 1200px; background: #fbfaf5; font-family: "Noto Sans SC", sans-serif; color: #222; }
h1 { font-size: 34px; text-align: center; margin: 40px 0 10px; } .p { position: absolute; font-size: 26px; line-height: 1.7; }
</style><h1>三年级数学 第七单元 练习</h1>
<div class="p" style="left:60px; top:170px">1. 计算：48 × 6 = 288</div>
<div class="p" style="left:60px; top:260px">2. 一箱苹果有 24 个，5 箱一共有多少个？<br>答：____ 个</div>
<div class="p" style="left:60px; top:420px; width:360px">3. 把一个蛋糕平均分成 4 份，<br>每份是它的几分之几？<br>答：1/4</div>
<div class="p" style="left:480px; top:420px; width:360px">4. 比较大小：<br>1/3 ○ 1/5<br>2/7 ○ 5/7</div>
<div class="p" style="left:60px; top:640px">5. 小明有 36 本书，送给同学 1/4，<br>还剩多少本？<br>答：____ 本</div>
<div class="p" style="left:60px; top:840px">6. 画一画：在下面的长方形里涂出它的 3/8。<br><svg width="400" height="120"><rect x="10" y="10" width="380" height="100" fill="none" stroke="#333" stroke-width="2"/></svg></div>`;

async function homeworkPage(browser) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  await page.setContent(HOMEWORK);
  const png = await page.screenshot();
  await page.close();
  return png;
}

module.exports = { BASE, momContext, parentState, kidLink, voiceStub, said, waitSaid, nextSaid, bridge, watchErrors, setVisible, finish, homeworkPage };
