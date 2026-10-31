// The streamed voice in a real page, under the phone rule that sound may only start
// from a tap (Huawei's browser among others):
//  1. the resampler alone: pieces of any size join without gaps or clicks, 24 kHz to
//     the sound card's 48 or 44.1 kHz;
//  2. a line arriving 6.5 s after the last tap, streamed as the server sends it: it
//     plays (the sound context stayed unlocked), seamlessly, her mouth moves with it
//     and stops at the end.
// Run through run.sh: tools/browser/run.sh voice
const { chromium } = require('playwright');
const { momContext, kidLink, bridge, finish } = require('./lib.cjs');

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
  const link = await kidLink(await momContext(browser));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 730 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    speechSynthesis.speak = (u) => setTimeout(() => u.onend && u.onend(), 300);
    speechSynthesis.cancel = () => {};
    window.__starts = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when) {
      window.__starts.push({ when, dur: this.buffer.duration, now: this.context.currentTime, wall: performance.now(), state: this.context.state });
      return start.apply(this, arguments);
    };
    // 2 s of a 440 Hz tone as the server would send it: 16-bit PCM at 24 kHz, about
    // 0.4 s per piece, a piece every 120 ms, the first after 500 ms.
    const pcm = new Uint8Array(24000 * 2 * 2);
    const dv = new DataView(pcm.buffer);
    for (let i = 0; i < 48000; i += 1) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 16000), true);
    window.__pieces = [];
    const realFetch = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/tts')) {
        const body = new ReadableStream({
          async start(c) {
            await new Promise((r) => setTimeout(r, 500));
            for (let o = 0; o < pcm.length; o += 19201) { // odd sizes: samples split across pieces
              c.enqueue(pcm.slice(o, Math.min(o + 19201, pcm.length)));
              window.__pieces.push(performance.now());
              await new Promise((r) => setTimeout(r, 120));
            }
            c.close();
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Format': 'pcm_s16le;rate=24000' } }));
      }
      return realFetch(url, opts);
    };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(link);
  await page.waitForSelector('#start:not([hidden])');
  await bridge(page);

  // 1. The resampler on its own, with a recording stand-in for the sound card.
  const seams = await page.evaluate(() => {
    const out = {};
    for (const sr of [48000, 44100]) {
      const got = [];
      const fake = { sampleRate: sr, currentTime: 0, destination: {},
        createBuffer: (ch, n, rate) => { const d = new Float32Array(n); return { duration: n / rate, getChannelData: () => d, d }; },
        createBufferSource: () => ({ connect() {}, start(when) { got.push({ when, d: this.buffer.d }); }, stop() {} }) };
      const p = new VoicePlayer(fake, 24000, () => {});
      const n = 24000; // 1 s
      const pcm = new Uint8Array(n * 2);
      const dv = new DataView(pcm.buffer);
      for (let i = 0; i < n; i += 1) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 16000), true);
      let o = 0;
      const sizes = [1, 2, 3, 5001, 7, 9998, 1, 4000, 13];
      for (let k = 0; o < pcm.length; k += 1) { const s = sizes[k % sizes.length]; p.push(pcm.slice(o, o + s)); o += s; }
      p.finish();
      let gap = 0, maxErr = 0, frames = 0;
      for (let k = 0; k < got.length; k += 1) {
        if (k) gap = Math.max(gap, Math.abs(got[k].when - (got[k - 1].when + got[k - 1].d.length / sr)));
        for (let i = 0; i < got[k].d.length; i += 1, frames += 1) {
          const t = frames / sr;
          if (t * 24000 > n - 1) break;
          maxErr = Math.max(maxErr, Math.abs(got[k].d[i] - (Math.sin(2 * Math.PI * 440 * t) * 16000) / 32768));
        }
      }
      const total = got.reduce((a, g) => a + g.d.length, 0);
      out[sr] = { buffers: got.length, frames: total, expected: Math.round((n * sr) / 24000), maxGapSeconds: gap, maxError: +maxErr.toFixed(5) };
    }
    return out;
  });
  console.log('resampler:', JSON.stringify(seams));

  // 2. A streamed line arriving 6.5 s after the last tap.
  await page.tap('#startBtn');
  await page.waitForFunction(() => !look.speaking && !look.mood, null, { timeout: 20000 });
  await page.evaluate(() => {
    state.tts = true;
    window.__starts = [];
    window.__mouth = [];
    setTimeout(() => {
      window.__asked = performance.now();
      const poll = setInterval(() => window.__mouth.push([Math.round(performance.now() - window.__asked), look.speaking]), 100);
      speak('测试一下').then(() => { window.__doneAt = performance.now(); setTimeout(() => clearInterval(poll), 300); });
    }, 6500);
  });
  await page.waitForTimeout(11000);
  const r = await page.evaluate(() => {
    const s = window.__starts.filter((x) => x.dur > 0.001);
    const firstPiece = window.__pieces[0] - window.__asked, lastPiece = window.__pieces[window.__pieces.length - 1] - window.__asked;
    let gap = 0;
    for (let k = 1; k < s.length; k += 1) gap = Math.max(gap, Math.abs(s[k].when - (s[k - 1].when + s[k - 1].dur)));
    const talking = window.__mouth.filter((m) => m[1]);
    return {
      ctx: audioCtx.state, buffers: s.length, seconds: +s.reduce((a, x) => a + x.dur, 0).toFixed(3), maxGapSeconds: gap,
      firstPieceMs: Math.round(firstPiece), firstSoundScheduledMs: Math.round(s[0].wall - window.__asked), lastPieceMs: Math.round(lastPiece),
      doneMs: Math.round(window.__doneAt - window.__asked), mouthOnMs: talking.length ? talking[0][0] : null, mouthOffAtEnd: !window.__mouth[window.__mouth.length - 1][1],
    };
  });
  console.log('streamed line:', JSON.stringify(r));
  console.log('talking over time:', JSON.stringify(await page.evaluate(() => window.__mouth.map((m) => `${m[0]}:${m[1] ? 'talk' : '-'}`).join(' '))));
  await browser.close();

  const problems = [];
  for (const [rate, x] of Object.entries(seams)) {
    if (Math.abs(x.frames - x.expected) > 2) problems.push(`resampler at ${rate}: ${x.frames} frames, ${x.expected} expected`);
    if (x.maxGapSeconds > 1e-6) problems.push(`resampler at ${rate}: a gap of ${x.maxGapSeconds} s between pieces`);
    if (x.maxError > 0.02) problems.push(`resampler at ${rate}: the wave is off by ${x.maxError}`);
  }
  if (r.ctx !== 'running') problems.push(`the sound context is ${r.ctx}, not running, 6.5 s after the tap`);
  if (Math.abs(r.seconds - 2) > 0.05) problems.push(`${r.seconds} s of sound played, 2 s sent`);
  if (r.maxGapSeconds > 0.001) problems.push(`a gap of ${r.maxGapSeconds} s in the streamed line`);
  if (r.firstSoundScheduledMs - r.firstPieceMs > 400) problems.push(`the first sound came ${r.firstSoundScheduledMs - r.firstPieceMs} ms after the first piece`);
  if (r.mouthOnMs === null || !r.mouthOffAtEnd) problems.push('her mouth did not follow the voice');
  finish(problems);
})().catch((e) => {
  console.error('CHECK FAILED', e);
  process.exit(1);
});
