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

module.exports = { BASE, momContext, parentState, kidLink, voiceStub, said, waitSaid, nextSaid, bridge, watchErrors, setVisible, finish };
