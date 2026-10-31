// The kid screen on eleven screen sizes, from a small phone to a desktop: screenshots of
// each (waking up, thinking, talking, typing, a panel open, the picker), plus geometry
// checks: nothing sticks out sideways, the rail fits, her face stays clear of the bubble
// and the panels, the pet's head stays clear of the bubble, the dock is on the first
// screen of a phone, and a panel opened from the rail sits beside her (held sideways)
// or above the mic (upright), inside the screen.
// Run through run.sh: tools/browser/run.sh devices  (ONLY=phone360,pura80 for a few)
const { chromium } = require('playwright');
const { BASE, momContext, parentState, voiceStub, bridge, watchErrors, finish } = require('./lib.cjs');

const OUT = process.argv[2];
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const DSF = Number(process.env.DSF || 1);
const hhmm = (m) => `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m + 1440) % 1440) % 60).padStart(2, '0')}`;

// CSS viewports with the browser's own bars already taken off.
const DEVICES = [
  { tag: 'purax_land', name: 'Pura X Max 横屏（实测）', w: 939, h: 511 },
  { tag: 'purax_port', name: 'Pura X Max 竖屏', w: 680, h: 865 },
  { tag: 'pura80', name: '手机微信（实测）', w: 400, h: 810 },
  { tag: 'matepad_wx', name: 'MatePad 微信横屏（实测）', w: 1065, h: 624 },
  { tag: 'phone360', name: '小屏手机', w: 360, h: 680 },
  { tag: 'pura80_land', name: 'Pura 80 横屏', w: 860, h: 360 },
  { tag: 'matepad_land', name: 'MatePad 横屏', w: 1280, h: 730 },
  { tag: 'matepad_port', name: 'MatePad 竖屏', w: 800, h: 1210 },
  { tag: 'matepad_full', name: 'MatePad 全屏', w: 1280, h: 800 },
  { tag: 'tab1024', name: '10 寸平板', w: 1024, h: 640 },
  { tag: 'desk', name: '电脑', w: 1440, h: 900, desktop: true },
];

const LINE = '明天是 D4，有英语和美术。美术课记得带彩笔哦！写完作业，我们一起看看小九有没有长出新尾巴吧～';

function measure() {
  const vw = innerWidth;
  const vh = innerHeight;
  const R = (sel) => {
    const e = document.querySelector(sel);
    if (!e || e.closest('[hidden]')) return null;
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) return null; // not shown
    return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const out = {
    vw, vh, rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
    sx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sy: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    sideScroll: (() => { const s = document.querySelector('.side'); return s.scrollHeight - s.clientHeight; })(),
  };
  const SEL = { bar: '.bar', girl: '#girlFig', pet: '#petFig .sprite', petSay: '#petSay', bubble: '#bubble', side: '.side', tasks: '#panel-tasks', love: '#panel-love', dock: '.dock', mic: '#mic', kbd: '#kbd', type: '#typeForm', send: '#typeForm button', swap: '#swap', stage: '#stage', rail: '.rail', railEnd: '.rail button:last-child' };
  for (const [k, s] of Object.entries(SEL)) out[k] = R(s);
  // Her real face and outline, from the sprite manifest.
  const m = SPRITES && SPRITES[girlView.key];
  if (m && out.girl) {
    const g = out.girl;
    const box = ([l, t, r, b]) => ({ x: Math.round(g.x + l * g.w), y: Math.round(g.y + t * g.h), r: Math.round(g.x + r * g.w), b: Math.round(g.y + b * g.h) });
    out.face = box(m.face);
    out.body = box(m.bbox);
  }
  return out;
}

function problemsOf(tag, m, portrait) {
  const p = [];
  const area = (a) => Math.max(0, a.r - a.x) * Math.max(0, a.b - a.y);
  const inter = (a, b) => (a && b ? area({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) }) : 0);
  if (m.sx > 0) p.push(`page scrolls sideways by ${m.sx}px`);
  for (const k of ['bar', 'bubble', 'side', 'dock', 'mic', 'kbd', 'type', 'send', 'swap', 'petSay', 'rail', 'railEnd']) {
    const a = m[k];
    if (!a) continue;
    if (a.x < 0 || a.r > m.vw) p.push(`${k} sticks out sideways (${a.x}..${a.r} of ${m.vw})`);
    // Inside a side column that scrolls, being below its fold is fine.
    const inSide = ['swap'].includes(k) && m.sideScroll > 0;
    if (!portrait && !inSide && (a.y < 0 || a.b > m.vh)) p.push(`${k} sticks out vertically (${a.y}..${a.b} of ${m.vh})`);
  }
  // The girl's face stays clear of the bubble, the side column and the dock; all of her is on screen.
  if (m.face) {
    const face = m.face;
    if (m.body.x < 0 || m.body.r > m.vw || (!portrait && m.body.b > m.vh)) p.push(`girl cut off (${m.body.x}..${m.body.r} x ${m.body.y}..${m.body.b})`);
    if (m.side && (m.body.r > m.side.x && m.body.b > m.side.y && m.body.y < m.side.b) && !portrait) p.push('girl under the side column');
    if (m.rail && m.rail.r > m.body.x + 2 && m.body.b > m.rail.y && m.body.y < m.rail.b && inter(m.rail, m.body) > area(m.body) * 0.02) p.push('the rail covers the girl');
    // (Upright, a panel is opened over the lower part on purpose: her face may go behind it.)
    for (const k of ['bubble', ...(portrait ? [] : ['side']), 'dock', 'bar']) {
      const o = inter(face, m[k]);
      if (o > area(face) * 0.04) p.push(`${k} covers ${Math.round((o / area(face)) * 100)}% of the girl's face`);
    }
    if (face.y < 0) p.push('girl face cut off at the top');
  }
  if (m.pet) {
    // The pet's head sits in the middle band of its frame; its feet may hide behind the bubble.
    const head = { x: m.pet.x + m.pet.w * 0.2, r: m.pet.r - m.pet.w * 0.2, y: m.pet.y + m.pet.h * 0.22, b: m.pet.y + m.pet.h * 0.62 };
    for (const k of ['bubble', ...(portrait ? [] : ['side']), 'dock', 'petSay']) {
      if (!m[k]) continue;
      const o = inter(head, m[k]);
      if (o > area(head) * 0.08) p.push(`${k} covers ${Math.round((o / area(head)) * 100)}% of the pet's head`);
    }
    if (m.pet.b > m.vh + 2 && !portrait) p.push('pet below the screen');
  }
  if (portrait && m.dock) {
    if (m.dock.b > m.vh) p.push(`dock below the first screen (${m.dock.b} > ${m.vh})`);
    if (m.bubble && m.bubble.b > m.dock.y + 8) p.push(`bubble hidden behind the dock at first sight (${m.bubble.b} > ${m.dock.y})`);
    if (m.side && (m.side.b > m.dock.y + 2 || m.side.y < 0)) p.push(`the panel is not between the top and the mic (${m.side.y}..${m.side.b}, mic at ${m.dock.y})`);
  }
  if (m.railEnd && m.railEnd.b > (portrait && m.dock ? m.dock.y : m.vh)) p.push(`the rail's last button is cut off (${m.railEnd.b})`);
  if (m.mic && m.mic.h < 44) p.push(`mic too small (${m.mic.h}px)`);
  if (m.rem < 13) p.push(`text too small (rem ${m.rem})`);
  return p.map((x) => `${tag}: ${x}`);
}

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const errors = [];

  const mom = await momContext(browser);
  let ps = await parentState(mom);
  const now = ps.now.minutes;
  // Four tasks today, so the list has some length to it.
  const have = new Set(ps.templates.map((t) => t.title));
  for (const t of [
    { title: '阅读 20 分钟', icon: '📖', time: hhmm(now + 30), minutes: 20, days: 'every' },
    { title: '整理书包', icon: '🎒', time: hhmm(now + 90), minutes: 10, days: 'every' },
  ]) if (!have.has(t.title)) await mom.request.post(BASE + '/api/parent/templates', { data: t });
  ps = await parentState(mom);
  const link = `${BASE}/?k=${ps.kidKey}`;

  const report = {};
  for (const d of DEVICES) {
    if (ONLY && !ONLY.includes(d.tag)) continue;
    const portrait = d.h > d.w;
    const ctx = await browser.newContext({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: DSF, isMobile: !d.desktop, hasTouch: !d.desktop });
    await ctx.addInitScript(...voiceStub(2500));
    const page = await ctx.newPage();
    watchErrors(page, d.tag, errors);
    await page.goto(link);
    await page.waitForURL(BASE + '/');
    await page.waitForSelector('#start:not([hidden])');
    await bridge(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${d.tag}_0start.png` });
    await page.click('#startBtn');
    await page.waitForFunction(() => !look.speaking && !look.mood, null, { timeout: 20000 });
    await page.evaluate(() => setBusy(true, '想一想…'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${d.tag}_0think.png` });
    await page.evaluate(() => setBusy(false));
    await page.evaluate((line) => {
      say(line, { pet: '小九晃晃尾巴', mood: 'happy' });
      document.getElementById('heard').hidden = false;
      document.getElementById('heard').textContent = '你说：明天上什么课';
    }, LINE);
    await page.waitForTimeout(900);
    const m1 = await page.evaluate(measure);
    await page.screenshot({ path: `${OUT}/${d.tag}_1talk.png` });
    await page.waitForFunction(() => !look.speaking, null, { timeout: 20000 });
    await page.click('#kbd');
    await page.waitForTimeout(400);
    const m2 = await page.evaluate(measure);
    await page.screenshot({ path: `${OUT}/${d.tag}_2type.png` });
    await page.click('#kbd');
    // A panel from the rail: today's tasks.
    await page.click('.rail [data-panel="tasks"]');
    await page.waitForTimeout(500);
    const m3 = await page.evaluate(measure);
    if (!m3.tasks) problems.push(`${d.tag}: the tasks panel did not open`);
    await page.screenshot({ path: `${OUT}/${d.tag}_3panel.png` });
    // The pet's panel, and the picker from it.
    await page.click('.rail [data-panel="love"]');
    await page.waitForTimeout(400);
    await page.click('#swap');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${d.tag}_4picker.png` });
    const pick = await page.evaluate(() => { const c = document.querySelector('#picker .sheet-card').getBoundingClientRect(); return { y: Math.round(c.top), b: Math.round(c.bottom), h: innerHeight }; });
    report[d.tag] = { talk: m1, type: m2, panel: m3, pick };
    problems.push(...problemsOf(d.tag, m1, portrait), ...problemsOf(`${d.tag}+type`, m2, portrait), ...problemsOf(`${d.tag}+panel`, m3, portrait));
    if (pick.y < 0 || pick.b > pick.h) problems.push(`${d.tag}: picker card off screen`);
    await ctx.close();
  }
  require('fs').writeFileSync(`${OUT}/devices.json`, JSON.stringify(report, null, 1));
  for (const [tag, v] of Object.entries(report)) {
    const t = v.talk;
    const f = (a) => (a ? `${a.x},${a.y} ${a.w}x${a.h}` : '-');
    console.log(`${tag.padEnd(13)} rem ${t.rem.toFixed(1)} rail ${f(t.rail)} girl ${f(t.girl)} pet ${f(t.pet)} bubble ${f(t.bubble)} panel ${f(v.panel.side)} dock ${f(t.dock)}`);
  }
  await browser.close();
  finish([...problems, ...errors]);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
