// Kid page: talk to the companion, see today's tasks, watch the pet grow.
'use strict';

const $ = (id) => document.getElementById(id);
let state = null;
let started = false;
let busy = false;
let audioCtx = null;
let rec = null;
let currentAudio = null;
let speakSeq = 0;
let evolved = null; // set when the pet reaches a new stage; the next say() announces it

// ---- server ------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    showLocked();
    throw new Error('locked');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '出错了');
  return data;
}

async function load() {
  try {
    render(await api('/api/state'));
    if (evolved && !look.speaking) say('');
  } catch (err) {
    if (err.message !== 'locked') console.warn(err);
  }
}

function showLocked() {
  $('locked').hidden = false;
  $('start').hidden = true;
  $('app').hidden = true;
}

// ---- the girl ------------------------------------------------------------------
// She is a full-length cut-out (web/img/full, made by design/tools/full_body.py).
// Her mouth and eyes are small patches laid over her face: the mouth opens with the
// loudness of her voice, the eyes close for a blink every few seconds. A pose (a
// mood, thinking, asleep) is a whole picture shown over her.

// The page colour behind each girl and pet, so the background suits whoever is out.
const GIRL_BG = { a: '#ead2ce', b: '#94b8c7', c: '#c8a782', d: '#9fa3db' };
const PET_BG = {
  '1_1': '#f3e1c9', '1_2': '#ecdbc9', '1_3': '#ead7c5', '1_4': '#e3d4c5',
  '2_1': '#dfbd84', '2_2': '#dcb987', '2_3': '#d3c0a1', '2_4': '#d7c3a1',
  '3_1': '#e3c0cb', '3_2': '#e2b9cc', '3_3': '#dbb9ca', '3_4': '#debed0',
  '4_1': '#a2c3d1', '4_2': '#9ebfcf', '4_3': '#a3c4d5', '4_4': '#99bcc7',
};
const POSES = ['happy', 'cheer', 'think', 'sleepy', 'worried'];
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pct = (v) => `${(v * 100).toFixed(2)}%`;
// Where each girl's mouth, face, feet and outline are, and where her patches go.
let SPRITES = null;
const spritesReady = fetch('/img/full/sprites.json')
  .then((r) => r.json())
  .then((j) => (SPRITES = j))
  .catch(() => {});

const girlView = {
  fig: $('girlFig'),
  key: null,
  posed: null,

  set(g) {
    if (this.key === g || !SPRITES || !SPRITES[g]) return;
    this.key = g;
    const m = SPRITES[g];
    const fig = this.fig;
    fig.querySelector('.base').src = `/img/full/${g}.webp`;
    for (const k of ['m1', 'm2', 'blink']) {
      const el = fig.querySelector(`.patch.${k}`);
      const [x, y, w, h] = m.patches[k];
      el.src = `/img/full/${g}_${k}.webp`;
      Object.assign(el.style, { left: pct(x), top: pct(y), width: pct(w), height: pct(h) });
    }
    const [l, t, r, b] = m.bbox;
    Object.assign(fig.querySelector('.hit').style, { left: pct(l), top: pct(t), width: pct(r - l), height: pct(b - t) });
    this.warm = POSES.map((p) => Object.assign(new Image(), { src: `/img/full/${g}_${p}.webp` }));
    this.posed = null;
    fig.classList.remove('posed');
  },

  // A whole pose over her, or null for herself. A new picture is decoded first so it
  // never shows half-drawn.
  async show(name) {
    if (name === this.posed || !this.key) return;
    this.posed = name;
    if (!name) {
      this.fig.classList.remove('posed');
      return;
    }
    const img = this.fig.querySelector('.pose');
    const url = `/img/full/${this.key}_${name}.webp`;
    if (img.getAttribute('src') !== url) {
      img.src = url;
      try {
        await img.decode();
      } catch {
        return;
      }
      if (this.posed !== name) return;
    }
    this.fig.classList.add('posed');
  },
};

// A blink every few seconds, now and then a double one.
function blinkLater() {
  clearTimeout(blinkLater.timer);
  blinkLater.timer = setTimeout(() => {
    const fig = girlView.fig;
    const blink = (ms) => {
      fig.classList.add('blinking');
      setTimeout(() => fig.classList.remove('blinking'), ms);
    };
    if (!fig.classList.contains('posed') && !document.hidden) {
      blink(130);
      if (Math.random() < 0.2) setTimeout(() => blink(110), 300);
    }
    blinkLater();
  }, 2200 + Math.random() * 3800);
}

// Her mouth follows her voice: everything she says goes through one analyser, and
// each frame its loudness picks closed, a little open, or open. A voice the page
// can't hear (the browser's own) gets a plain talking rhythm instead.
let voiceOut = null;
function voiceBus() {
  if (!voiceOut && audioCtx) {
    voiceOut = audioCtx.createAnalyser();
    voiceOut.fftSize = 512;
    voiceOut.connect(audioCtx.destination);
  }
  return voiceOut || (audioCtx && audioCtx.destination);
}
const lips = { level: 0, since: 0, frame: 0, heard: false, buf: new Float32Array(512) };
function lipsStart(heard) {
  lips.heard = heard && Boolean(voiceOut);
  cancelAnimationFrame(lips.frame);
  lips.frame = requestAnimationFrame(lipsTick);
}
function lipsStop() {
  cancelAnimationFrame(lips.frame);
  lips.frame = 0;
  lipsSet(0);
}
function lipsTick(t) {
  let want;
  if (lips.heard) {
    voiceOut.getFloatTimeDomainData(lips.buf);
    let sum = 0;
    for (let i = 0; i < lips.buf.length; i += 1) sum += lips.buf[i] * lips.buf[i];
    const rms = Math.sqrt(sum / lips.buf.length);
    want = rms < 0.02 ? 0 : rms < 0.08 ? 1 : 2; // tuned on real lines: about 40% closed, 15% half, 45% open
  } else want = [1, 2, 1, 0, 2, 1, 0, 1][Math.floor(t / 90) % 8];
  if (want !== lips.level && t - lips.since > 60) {
    lipsSet(want);
    lips.since = t;
  }
  lips.frame = requestAnimationFrame(lipsTick);
}
function lipsSet(level) {
  lips.level = level;
  girlView.fig.dataset.mouth = level;
}

// ---- the pet -------------------------------------------------------------------
// It lives on an oval of floor round the girl's feet: in front of her (lower on the
// screen and a little bigger), beside her, or behind her (higher, smaller, hidden by
// her). On its own it hops about, sits and looks around, looks up at her, plays, runs
// a circle round her, plays hide-and-seek behind her, and naps. When she talks it
// comes close and listens; it cheers with her, wonders with her while she thinks,
// turns to MoMo while MoMo talks, and curls up at her feet at night.

const PET_HEAD = [0.2, 0.22, 0.8, 0.62]; // where its head is in its picture
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Pet {
  constructor(fig) {
    this.fig = fig;
    this.body = fig.querySelector('.body');
    this.sprite = fig.querySelector('.sprite');
    this.img = fig.querySelector('img');
    this.a = Math.PI * 0.3; // where it stands: angle round her (π/2 = in front)
    this.r = 1.15; // and how far out, in units of the oval
    this.face = -1; // 1 looks right, -1 left
    this.hop = 0;
    this.trip = null;
    this.seq = 0; // bumped whenever something new takes over
    this.mode = 'off'; // off | life | busy | asleep
    this.mood = null; // its own picture: null, 'happy' or 'sleepy'
    this.base = '';
    this.frame = this.frame.bind(this);
  }

  // The pet to show: which one and how grown up.
  setPet(p, stage) {
    const base = `/img/pet/sprite/${p}_${stage}`;
    if (base === this.base) return;
    this.base = base;
    this.warm = ['happy', 'sleepy'].map((k) => Object.assign(new Image(), { src: `${base}_${k}.webp` }));
    this.paint();
  }

  paint() {
    const m = look.petMood || this.mood || (state && state.quiet ? 'sleepy' : null);
    const url = m ? `${this.base}_${m}.webp` : `${this.base}.webp`;
    if (this.base && this.img.getAttribute('src') !== url) this.img.src = url;
  }

  setMood(m) {
    this.mood = m;
    this.paint();
  }

  // Sizes from the girl as she stands now.
  layout() {
    const st = $('stage').getBoundingClientRect();
    const g = girlView.fig.getBoundingClientRect();
    const m = SPRITES && girlView.key && SPRITES[girlView.key];
    if (!m || !st.width || !g.height) return false;
    const petH = g.height * 0.3;
    const petW = petH * 0.75;
    const cx = g.left - st.left + m.feet[0] * g.width;
    const cy = g.top - st.top + m.feet[1] * g.height;
    const bodyW = (m.bbox[2] - m.bbox[0]) * g.width;
    const rx = bodyW / 2 + petW * 0.5 + 4;
    this.G = { cx, cy, rx, ry: rx * 0.22, petW, petH, minX: petW / 2 + 2, maxX: st.width - petW / 2 - 2,
      gx: g.left - st.left, gy: g.top - st.top, gw: g.width, gh: g.height };
    this.fig.style.width = `${petW}px`;
    this.fig.style.height = `${petH}px`;
    this.place();
    return true;
  }

  where(a = this.a, r = this.r) {
    const G = this.G;
    return [Math.min(G.maxX, Math.max(G.minX, G.cx + G.rx * r * Math.cos(a))), G.cy + G.ry * r * Math.sin(a)];
  }

  place() {
    if (!this.G) return;
    const G = this.G;
    const [x, y] = this.where();
    const depth = Math.sin(this.a) * Math.min(1, this.r);
    const s = 1 + 0.1 * depth;
    this.fig.style.transform = `translate3d(${(x - G.petW / 2).toFixed(1)}px, ${(y - G.petH).toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
    this.fig.style.zIndex = depth < -0.2 ? 1 : 3; // behind her, or in front
    this.body.style.transform = `translateY(${(-this.hop).toFixed(1)}px) scaleX(${this.face})`;
  }

  // Hop over to (a, r). dir: 0 the short way round, 1 or -1 to go round that way
  // (a full circle passes behind her). Resolves on arrival, or early if interrupted.
  go(a, r, { speed = 1.8, dir = 0, hops = true } = {}) {
    if (!this.G) return Promise.resolve();
    this.stop();
    let da = a - this.a;
    if (dir === 0) da = Math.atan2(Math.sin(da), Math.cos(da));
    else if (dir > 0 && da <= 0) da += Math.PI * 2;
    else if (dir < 0 && da >= 0) da -= Math.PI * 2;
    const G = this.G;
    const len = Math.abs(da) * ((G.rx + G.ry) / 2) * Math.max(this.r, r) + Math.abs(r - this.r) * G.rx;
    const dur = STILL ? 0 : Math.min(7000, Math.max(300, (len / (speed * G.petW)) * 1000));
    return new Promise((resolve) => {
      this.trip = { a0: this.a, r0: this.r, da, dr: r - this.r, t0: performance.now(), dur, hops, resolve, x: this.where()[0] };
      requestAnimationFrame(this.frame);
    });
  }

  stop() {
    if (!this.trip) return;
    const t = this.trip;
    this.trip = null;
    this.hop = 0;
    this.place();
    t.resolve();
  }

  frame(now) {
    const t = this.trip;
    if (!t) return;
    const k = t.dur ? Math.min(1, (now - t.t0) / t.dur) : 1;
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    this.a = t.a0 + t.da * e;
    this.r = t.r0 + t.dr * e;
    const [x] = this.where();
    if (Math.abs(x - t.x) > 0.4) this.face = x > t.x ? 1 : -1;
    t.x = x;
    this.hop = t.hops && k < 1 ? Math.abs(Math.sin(((now - t.t0) / 1000) * Math.PI * 2.6)) * this.G.petH * 0.12 : 0;
    this.place();
    if (k >= 1) {
      this.trip = null;
      this.a = Math.atan2(Math.sin(this.a), Math.cos(this.a));
      t.resolve();
    } else requestAnimationFrame(this.frame);
  }

  // Turn to look at her.
  faceHer() {
    const [x] = this.where();
    this.face = x < this.G.cx ? 1 : -1;
    this.place();
  }

  // A one-off move on its picture: 'jump', or a lasting one: 'listen', 'tilt', 'peek'.
  act(cls, on = true) {
    if (cls === 'jump') {
      this.sprite.classList.remove('jump');
      void this.sprite.offsetWidth;
    }
    this.sprite.classList.toggle(cls, on);
    if (cls === 'jump' && on) setTimeout(() => this.sprite.classList.remove('jump'), 1300);
  }

  // Something new is happening: whatever it was doing stops.
  takeOver(mode) {
    this.seq += 1;
    this.mode = mode;
    this.stop();
    this.act('listen', false);
    this.act('tilt', false);
    this.act('peek', false);
    return this.seq;
  }

  // ---- on its own ----
  start() {
    if (!this.G && !this.layout()) return;
    if (this.mode === 'off') this.live(1500);
  }

  live(after = 2500) {
    const seq = this.takeOver('life');
    this.setMood(null);
    this.lifeLoop(seq, after);
  }

  async lifeLoop(seq, after) {
    await sleep(after);
    let quiet = 0;
    while (seq === this.seq) {
      if (STILL) return;
      const roll = Math.random() * 100;
      quiet += 1;
      if (roll < 34) await this.wander(seq);
      else if (roll < 48) await this.lookAround(seq);
      else if (roll < 60) await this.play(seq);
      else if (roll < 72) await this.circle(seq);
      else if (roll < 84) await this.peek(seq);
      else if (quiet > 8) {
        await this.nap(seq);
        quiet = 0;
      } else await this.wander(seq);
      if (seq !== this.seq) return;
      await sleep(1500 + Math.random() * 3500);
    }
  }

  async wander(seq) {
    const side = Math.random() < 0.8;
    const a = side ? Math.PI * (0.1 + Math.random() * 0.8) : Math.random() < 0.5 ? -0.15 : Math.PI + 0.15;
    await this.go(a, 0.85 + Math.random() * 0.6);
    if (seq !== this.seq) return;
    if (Math.random() < 0.6) this.faceHer();
    await sleep(1200 + Math.random() * 2500);
  }

  async lookAround(seq) {
    for (let i = 0; i < 3 && seq === this.seq; i += 1) {
      this.face = -this.face;
      this.place();
      await sleep(600 + Math.random() * 700);
    }
  }

  async play(seq) {
    this.setMood('happy');
    this.act('jump');
    if (girlFree()) mood('happy', 1300); // she smiles at it
    await sleep(1500);
    if (seq === this.seq) this.setMood(null);
  }

  // Once round her: it disappears behind her and comes out the other side.
  async circle(seq) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    await this.go(this.a + dir * Math.PI * 2, 1.05, { speed: 2.6, dir });
    if (seq !== this.seq) return;
    this.act('jump');
    if (girlFree()) mood('happy', 1300);
  }

  // How far her outline reaches to the left and right of her centre line, between two
  // heights on the stage (the middle value over those rows), read off her picture
  // itself, so it suits every girl. See-through parts such as a gauze hem don't count.
  reach(y0, y1) {
    const G = this.G;
    const img = girlView.fig.querySelector('.base');
    try {
      if (!this.outline || this.outline.src !== img.currentSrc) {
        if (!img.complete || !img.naturalWidth) throw new Error('not loaded yet');
        const c = document.createElement('canvas');
        c.width = 72;
        c.height = 96;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, c.width, c.height);
        this.outline = { src: img.currentSrc, w: c.width, h: c.height, a: ctx.getImageData(0, 0, c.width, c.height).data };
      }
    } catch {
      return [G.rx * 0.3, G.rx * 0.3]; // a fair guess until her picture is in
    }
    const O = this.outline;
    const mid = ((G.cx - G.gx) / G.gw) * O.w;
    const [r0, r1] = [y0, y1].map((y) => Math.max(0, Math.min(O.h - 1, Math.round(((y - G.gy) / G.gh) * O.h))));
    const ls = [];
    const rs = [];
    for (let row = r0; row <= r1; row += 1) {
      let l = 0;
      let r = 0;
      for (let col = 0; col < O.w; col += 1) {
        if (O.a[(row * O.w + col) * 4 + 3] < 200) continue;
        const d = col + 0.5 - mid;
        if (d < 0) l = Math.max(l, -d);
        else r = Math.max(r, d);
      }
      ls.push(l);
      rs.push(r);
    }
    const middle = (v) => v.sort((p, q) => p - q)[v.length >> 1];
    return [(middle(ls) / O.w) * G.gw, (middle(rs) / O.w) * G.gw];
  }

  // Behind her on side s (1 right, -1 left), most of it hidden by her: only its outer
  // edge shows past her, and leaning out (.peek) brings its head into view.
  peekSpot(s) {
    const G = this.G;
    const r0 = 0.75;
    const y = G.cy - G.ry * r0 * 0.8; // behind her is a little further up the floor
    const [l, r] = this.reach(y - G.petH * 0.9, y - G.petH * 0.15);
    const dx = Math.max(G.petW * 0.12, (s > 0 ? r : l) - G.petW * 0.1);
    const rr = Math.max(r0, dx / (G.rx * 0.9));
    return [-Math.acos((s * dx) / (G.rx * rr)), rr];
  }

  // Hide and seek: behind her, a peek out past her legs, back in, maybe a peek on the
  // other side, then out with a jump. She smiles when it pops out.
  async peek(seq) {
    const [x] = this.where();
    const s = x < this.G.cx ? -1 : 1; // the side it went in on
    await this.go(-Math.PI / 2 + s * 0.15, 0.75, { speed: 1.4 });
    for (const side of Math.random() < 0.5 ? [s] : [s, -s]) {
      if (seq !== this.seq) return;
      await sleep(600 + Math.random() * 600);
      if (seq !== this.seq) return;
      const [a, r] = this.peekSpot(side);
      await this.go(a, r, { speed: 0.9, hops: false });
      if (seq !== this.seq) return;
      this.face = side; // looking out, away from her
      this.place();
      this.act('peek');
      await sleep(1800);
      if (seq !== this.seq) return; // whatever took over has already reset its moves
      this.act('peek', false);
      await this.go(-Math.PI / 2 + side * 0.1, 0.75, { speed: 1.2, hops: false });
    }
    if (seq !== this.seq) return;
    await sleep(400 + Math.random() * 500);
    if (seq !== this.seq) return;
    const out = Math.random() < 0.5 ? 1 : -1;
    await this.go(out > 0 ? 0.12 : Math.PI - 0.12, 1.1, { speed: 2.4, dir: out });
    if (seq !== this.seq) return;
    this.faceHer();
    this.setMood('happy');
    this.act('jump');
    if (girlFree()) mood('happy', 1300);
    await sleep(1300);
    if (seq === this.seq) this.setMood(null);
  }

  async nap(seq) {
    this.faceHer();
    this.setMood('sleepy');
    await sleep(8000 + Math.random() * 6000);
    if (seq === this.seq) this.setMood(null);
  }

  // ---- with her ----
  // She has started a line: come close on the side away from her words, look up at
  // her and listen.
  async attend() {
    if (!this.G || this.mode === 'asleep') return;
    const seq = this.takeOver('busy');
    const b = $('bubble').getBoundingClientRect();
    const st = $('stage').getBoundingClientRect();
    const wordsLeft = !$('bubble').hidden && (b.left + b.right) / 2 - st.left < this.G.cx;
    await this.go(wordsLeft ? Math.PI * 0.28 : Math.PI * 0.72, 0.85, { speed: 2.2 });
    if (seq !== this.seq) return;
    this.faceHer();
    this.act('listen');
  }

  // Her line is over: back to its own life in a moment.
  release() {
    if (this.mode === 'busy') this.live(1800);
  }

  cheer() {
    if (!this.G || this.mode === 'asleep') return;
    this.setMood('happy');
    this.act('jump');
    setTimeout(() => this.mood === 'happy' && this.setMood(null), 2600);
  }

  // She is thinking: sit by her and wonder too.
  async ponder() {
    if (!this.G || this.mode === 'asleep') return;
    const seq = this.takeOver('busy');
    const [x] = this.where();
    await this.go(x < this.G.cx ? Math.PI * 0.7 : Math.PI * 0.3, 0.9);
    if (seq !== this.seq) return;
    this.faceHer();
    this.act('tilt');
  }

  // MoMo is talking: come to the front and listen to MoMo.
  async hearMoMo() {
    if (!this.G || this.mode === 'asleep') return;
    const seq = this.takeOver('busy');
    await this.go(Math.PI / 2 + (Math.random() - 0.5) * 0.6, 1.0, { speed: 2.2 });
    if (seq !== this.seq) return;
    this.act('listen');
  }

  // Tapped: a happy jump, then a quick lap of joy.
  async poked() {
    if (!this.G) return;
    const seq = this.takeOver('busy');
    this.setMood('happy');
    this.act('jump');
    await sleep(1300);
    if (seq !== this.seq) return;
    if (Math.random() < 0.5) await this.circle(seq);
    if (seq !== this.seq) return;
    this.setMood(null);
    this.live(1500);
  }

  // She was tapped: run to her side and look up at her.
  async call() {
    if (!this.G || this.mode === 'asleep' || this.mode === 'busy') return;
    const seq = this.takeOver('busy');
    const [x] = this.where();
    await this.go(x < this.G.cx ? Math.PI * 0.75 : Math.PI * 0.25, 0.8, { speed: 2.6 });
    if (seq !== this.seq) return;
    this.faceHer();
    this.act('jump');
    this.live(2500);
  }

  // Night: curl up at her feet.
  async bedtime() {
    if (this.mode === 'asleep' || !this.G) return;
    const seq = this.takeOver('asleep');
    await this.go(Math.PI * 0.62, 0.8, { speed: 1.2 });
    if (seq !== this.seq) return;
    this.faceHer();
    this.setMood('sleepy');
  }

  wake() {
    if (this.mode === 'asleep') this.live(1000);
  }

  evolve() {
    this.sprite.classList.remove('evolve');
    void this.sprite.offsetWidth;
    this.sprite.classList.add('evolve');
    setTimeout(() => this.sprite.classList.remove('evolve'), 4500);
  }
}

const petLife = new Pet($('petFig'));
const look = { speaking: false, thinking: false, mood: null, petMood: null, feel: null };
// Free to react to the pet: not talking, thinking, listening or posing for something else.
const girlFree = () => !look.speaking && !look.thinking && !look.mood && !busy && !rec && !(state && state.quiet);

// Most important first: a passing mood, talking, thinking, asleep at night, herself.
function pose() {
  if (!state) return;
  girlView.show(look.mood || (look.speaking ? null : look.thinking ? 'think' : state.quiet ? 'sleepy' : null));
  girlView.fig.classList.toggle('talking', look.speaking);
  girlView.fig.dataset.feel = look.speaking && look.feel ? look.feel : '';
  petLife.paint();
}

// A passing expression: shown for a moment, then back to whatever comes next.
function flash(key, name, ms) {
  look[key] = name;
  clearTimeout(flash[key]);
  flash[key] = setTimeout(() => {
    look[key] = null;
    pose();
  }, ms);
  pose();
}
const mood = (name, ms = 2400) => flash('mood', name, ms);
const petMood = (name, ms = 3000) => flash('petMood', name, ms);

addEventListener('resize', () =>
  requestAnimationFrame(() => {
    petLife.layout();
    placeBubble();
  }),
);

// ---- rendering ---------------------------------------------------------------

const STATUS = { todo: '', redo: '再做一下', waiting: '⏳ 等妈妈看', confirmed: '✓ 完成' };

function render(s) {
  state = s;
  const g = s.profile.girl;
  const p = s.profile.pet;
  const stage = s.affinity.stage;
  document.body.dataset.girl = g;
  document.body.style.setProperty('--gc', GIRL_BG[g] || GIRL_BG.b);
  document.body.style.setProperty('--pc', PET_BG[`${p}_${stage}`] || GIRL_BG[g] || GIRL_BG.b);
  document.body.classList.toggle('quiet-time', Boolean(s.quiet));
  document.querySelector('meta[name="theme-color"]').content = GIRL_BG[g] || GIRL_BG.b;
  spritesReady.then(() => {
    girlView.set(g);
    pose();
    if (started) petLife.layout();
    placeBubble();
  });
  petLife.setPet(p, stage);
  if (started) {
    if (s.quiet) petLife.bedtime();
    else petLife.wake();
  }
  $('girlImg').alt = s.girls[g] ? s.girls[g].name : '';
  $('petImg').alt = s.pets[p] ? s.pets[p].name : '';
  $('startImg').src = `/img/girl_${g}.jpg`;
  $('date').textContent = s.dateZh;
  $('dlabel').textContent = s.today.label;

  const nowMin = s.now.minutes;
  const open = s.tasks.filter((t) => t.status === 'todo' || t.status === 'redo');
  const upcoming = open.find((t) => t.time && toMin(t.time) >= nowMin - 30) || open[0];
  $('next').textContent = upcoming
    ? `下一件：${upcoming.icon || ''}${upcoming.title}${upcoming.time ? ' ' + upcoming.time : ''}`
    : s.tasks.length ? '今天的事都交给妈妈看啦' : '';

  const a = s.alarms[0];
  $('alarm').hidden = !a;
  if (a) $('alarm').textContent = `⏰ ${a.date === s.now.date ? '' : '明天 '}${a.time} ${a.label}`;

  const list = $('tasks');
  list.textContent = '';
  if (!s.tasks.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '今天还没有安排任务';
    list.appendChild(li);
  }
  for (const t of s.tasks) {
    const li = document.createElement('li');
    li.className = t.status;
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="icon"></span><span><span class="title"></span><br><span class="time"></span></span><span class="st"></span>';
    b.querySelector('.icon').textContent = t.icon || '⭐';
    b.querySelector('.title').textContent = t.title;
    b.querySelector('.time').textContent = t.time ? `${t.time} · 约 ${t.minutes} 分钟` : `约 ${t.minutes} 分钟`;
    b.querySelector('.st').textContent = STATUS[t.status] || '';
    b.addEventListener('click', () => askDone(t));
    li.appendChild(b);
    list.appendChild(li);
  }

  const petInfo = s.pets[p] || { name: '' };
  const af = s.affinity;
  $('petName').textContent = petInfo.name;
  $('stageName').textContent = af.stageName || `第 ${af.stage} 阶段`;
  const pct = af.next ? Math.round(((af.points - af.prev) / (af.next - af.prev)) * 100) : 100;
  $('meterFill').style.width = `${Math.max(3, Math.min(100, pct))}%`;
  $('loveText').textContent = af.next ? `好感度 ${af.points}，再攒 ${af.next - af.points} 点就进化` : `好感度 ${af.points}，已经是最厉害的样子啦`;

  noteStage(s);
  pose();
  placeBubble();

  if (!started) {
    $('locked').hidden = true;
    $('start').hidden = false;
  }
}

// The last stage seen on this tablet, so each new one is announced once. Never
// at night: growth that happens after bedtime is a surprise for the morning.
function noteStage(s) {
  if (!started || s.quiet) return;
  const now = s.affinity.stage;
  let seen = null;
  try {
    seen = Number(localStorage.getItem('momo.stage')) || null;
  } catch {
    return; // storage blocked: skip the announcement rather than repeat it
  }
  if (seen && now > seen) {
    const p = s.pets[s.profile.pet];
    evolved = `${p ? p.name : '宠物'}进化啦，${s.affinity.stageUp || `现在是第 ${now} 阶段`}！`;
  }
  if (seen !== now) {
    try {
      localStorage.setItem('momo.stage', String(now));
    } catch {
      /* private mode */
    }
  }
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// ---- speaking ----------------------------------------------------------------

// A line is performed in one piece. Until her voice is ready she thinks, with dots
// by her mouth. The moment it starts, the words appear there, she talks, the line's
// mood moves her and the pet reacts, all for exactly as long as the voice lasts;
// then the mood stays on her face for a moment.
async function say(text, { pet: petAction = null, mood: feel = null } = {}) {
  let evolving = false;
  if (evolved) {
    text = `${text}哇！${evolved}`;
    evolved = null;
    petAction = petAction || '✨ 进化啦 ✨';
    feel = 'cheer';
    evolving = true;
  }
  const finished = await speak(text, () => {
    showWords(text);
    look.feel = feel;
    petLife.attend(); // it comes over to listen
    if (petAction) {
      petCaption(petAction);
      petMood('happy', 20000); // ends with the line, see below
    }
    if (feel === 'cheer' || petAction) petLife.cheer();
    if (evolving) petLife.evolve();
    pose();
  });
  if (!finished) return; // a newer line took over
  look.feel = null;
  petLife.release();
  if (petAction) petCaption(petAction, 1500);
  if (look.petMood === 'happy') petMood('happy', 600);
  if (feel) mood(feel, 1500);
  else pose();
}

// Plays the line's voice. onStart runs when the sound starts (or, if there is no
// voice at all, at the end, so the words still appear). Resolves true when the
// line ran to its end, false when a newer one took over.
async function speak(text, onStart = () => {}) {
  stopSpeaking();
  const my = ++speakSeq;
  const mine = () => my === speakSeq;
  let begun = false;
  const begin = (heard = false) => {
    if (!mine() || begun) return;
    begun = true;
    look.thinking = false;
    look.speaking = true;
    onStart();
    pose();
    lipsStart(heard);
  };
  look.thinking = true;
  pose();
  showThinking();
  try {
    let res = null;
    if (state && state.tts) {
      res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!mine()) {
        if (res.body) res.body.cancel().catch(() => {});
        return false;
      }
    }
    if (res && res.status === 200) await playVoice(res, mine, begin);
    else await browserSpeak(text, () => begin(false));
  } catch (err) {
    console.warn('speak failed', err);
  }
  if (!mine()) return false;
  if (!begun) {
    begun = true;
    onStart();
  }
  lipsStop();
  look.speaking = false;
  look.thinking = false;
  pose();
  return true;
}

// Restart a one-off CSS animation.
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// What the pet is doing, floating above it for `ms`; null hides it.
function petCaption(text, ms = 8000) {
  const c = $('petSay');
  clearTimeout(petCaption.timer);
  if (!text) {
    c.hidden = true;
    return;
  }
  c.textContent = text;
  c.hidden = false;
  petCaption.timer = setTimeout(() => (c.hidden = true), ms);
}

// ---- the speech bubble ------------------------------------------------------------
// An oval of frosted glass beside the speaking girl's mouth, its tail pointing at
// her mouth (where her mouth and face are comes from sprites.json).
const bubble = { mode: null, text: '' };

// Where a point of a picture (as fractions of it) is on screen; each picture fills
// its box exactly.
function picturePoint(el, fx, fy) {
  const r = el.getBoundingClientRect();
  return [r.left + fx * r.width, r.top + fy * r.height];
}
function pictureBox(el, [x0, y0, x1, y1]) {
  const [l, t] = picturePoint(el, x0, y0);
  const [r, b] = picturePoint(el, x1, y1);
  return { l, t, r, b };
}
const area = (a) => Math.max(0, a.r - a.l) * Math.max(0, a.b - a.t);
const overlap = (a, b) => area({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });

function showThinking() {
  bubble.mode = 'think';
  placeBubble();
}
function showWords(text) {
  bubble.mode = 'say';
  bubble.text = text;
  $('say').textContent = text;
  placeBubble();
  replay($('bubble'), 'pop');
}

// Tries the bubble to the right of her face, to the left, and under her chin, at a
// few heights, and keeps the one that is close to her mouth without covering her
// face, the pet's face, or anything outside the stage.
function placeBubble() {
  const el = $('bubble');
  const m = SPRITES && girlView.key && SPRITES[girlView.key];
  if (!bubble.mode || !state || !m || $('app').hidden) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.classList.toggle('think', bubble.mode === 'think');
  const app = $('app').getBoundingClientRect();
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const pad = getComputedStyle($('app'));
  const bar = $('app').querySelector('.bar').getBoundingClientRect();
  const girlFig = $('girlFig');
  const wide = matchMedia('(orientation: landscape) and (min-width: 600px)').matches;
  const st = $('stage').getBoundingClientRect();
  const region = {
    l: Math.max(st.left, app.left + parseFloat(pad.paddingLeft)),
    t: Math.max(st.top, bar.bottom + rem * 0.5),
    r: wide ? $('app').querySelector('.side').getBoundingClientRect().left - rem * 0.6 : app.right - parseFloat(pad.paddingRight),
    b: st.bottom,
  };
  const [mx, my] = picturePoint(girlFig, ...m.mouth);
  const face = pictureBox(girlFig, m.face);
  const petHead = pictureBox($('petFig').querySelector('.sprite'), PET_HEAD);
  const body = pictureBox(girlFig, m.bbox);
  const gap = rem * 0.9;

  // The words' natural block at a given width, and the oval around it.
  const p = $('say');
  const measure = (maxW) => {
    if (bubble.mode === 'think') return { tw: rem * 3.2, th: rem * 1.1 };
    p.style.width = '';
    p.style.maxWidth = `${Math.max(rem * 4, maxW)}px`;
    return { tw: p.offsetWidth, th: p.offsetHeight };
  };
  // About as many characters per line as there are lines, a little wider: a round shape.
  const n = bubble.mode === 'think' ? 0 : [...bubble.text].length;
  const em = parseFloat(getComputedStyle(p).fontSize) * 1.02;
  const ideal = Math.min(16, Math.max(6, Math.round(Math.sqrt(3.3 * n)))) * em;
  const least = bubble.mode === 'think' ? rem * 3.2 : Math.min(n, 7) * em; // narrower reads badly
  const oval = (maxBoxW) => {
    const room = (maxBoxW - rem * 1.2) / Math.SQRT2;
    if (room < least) return null;
    const { tw, th } = measure(Math.min(ideal, room));
    return { tw, th, w: tw * Math.SQRT2 + rem * 1.2, h: th * Math.SQRT2 + rem * 1.0 };
  };

  const tries = [];
  const add = (side, maxW, place) => {
    const sz = oval(maxW);
    if (sz) for (const box of place(sz)) tries.push({ side, box, sizes: sz });
  };
  const ys = (sz) => [my - sz.h * 0.62, my - sz.h * 0.35, region.t];
  add('right', region.r - face.r - gap, (sz) => ys(sz).map((t) => ({ l: face.r + gap, t, r: face.r + gap + sz.w, b: t + sz.h })));
  add('left', face.l - gap - region.l, (sz) => ys(sz).map((t) => ({ l: face.l - gap - sz.w, t, r: face.l - gap, b: t + sz.h })));
  const chin = Math.max(face.b, my + rem) + gap * 0.6;
  const below = (sz) => [mx - sz.w / 2, region.l, region.r - sz.w].map((l) => ({ l, t: chin, r: l + sz.w, b: chin + sz.h }));
  add('below', region.r - region.l, below);
  // Under her chin but narrower, so it stops short of the pet's head.
  if (petHead.l > region.l) add('below', petHead.l - gap - region.l, (sz) => [{ l: region.l, t: chin, r: region.l + sz.w, b: chin + sz.h }]);

  let best = null;
  for (const c of tries) {
    // Slide into the stage where it can, then score what is still wrong. Under her
    // chin it may hang down past the stage rather than slide up over her face.
    const b = { ...c.box };
    const dx = b.l < region.l ? region.l - b.l : b.r > region.r ? region.r - b.r : 0;
    const dy = b.t < region.t ? region.t - b.t : b.b > region.b && c.side !== 'below' ? region.b - b.b : 0;
    b.l += dx; b.r += dx; b.t += dy; b.b += dy;
    const out = area(b) - overlap(b, region);
    const faceHit = overlap(b, face) / area(face);
    const petHit = overlap(b, petHead) / Math.max(1, area(petHead));
    const nx = Math.max(b.l, Math.min(mx, b.r));
    const ny = Math.max(b.t, Math.min(my, b.b));
    const reach = (Math.hypot(nx - mx, ny - my) / (face.r - face.l)) * 6; // in face widths, so any screen size weighs the same
    const bodyHit = overlap(b, body) / area(b); // rather empty space than over her clothes
    let score = (out / area(b)) * 40 + faceHit * 60 + petHit * 25 + bodyHit * 12 + reach;
    if (bubble.mode === 'think' && c.side === 'below') score += 4; // thoughts float up by her head
    c.score = score;
    if (!best || score < best.score) best = { ...c, box: b, score };
  }
  bubble.tries = tries; // for checking placements
  if (!best) return;

  const { box, sizes } = best;
  el.style.left = `${box.l - app.left}px`;
  el.style.top = `${box.t - app.top}px`;
  el.style.width = `${box.r - box.l}px`;
  el.style.height = `${box.b - box.t}px`;
  if (bubble.mode === 'say') {
    p.style.maxWidth = 'none';
    p.style.width = `${sizes.tw + 1}px`;
  }

  // The oval and its tail as one shape, so the glass never doubles up where they meet.
  const w = box.r - box.l;
  const h = box.b - box.t;
  const rx = w / 2;
  const ry = h / 2;
  const lx = mx - box.l;
  const ly = my - box.t;
  const t0 = Math.atan2((ly - ry) / ry, (lx - rx) / rx);
  const at = (t) => [rx + rx * Math.cos(t), ry + ry * Math.sin(t)];
  const [ex, ey] = at(t0);
  const dist = Math.hypot(lx - ex, ly - ey);
  const len = Math.max(0, Math.min(dist - rem * 0.5, rem * 2.2));
  const ux = (lx - ex) / (dist || 1);
  const uy = (ly - ey) / (dist || 1);
  const svg = el.querySelector('svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  const f2 = (v) => v.toFixed(1);
  let d;
  if (bubble.mode === 'think' || len < rem * 0.3) {
    // Thinking: little round puffs drift from her mouth to the bubble.
    d = `M${f2(0)} ${f2(ry)}A${f2(rx)} ${f2(ry)} 0 1 1 ${f2(2 * rx)} ${f2(ry)}A${f2(rx)} ${f2(ry)} 0 1 1 0 ${f2(ry)}Z`;
    if (bubble.mode === 'think' && len > rem * 0.6) {
      for (const [k, r] of [[0.35, 0.34], [0.8, 0.22]]) {
        const cx = ex + ux * len * k;
        const cy = ey + uy * len * k;
        d += `M${f2(cx - r * rem)} ${f2(cy)}a${f2(r * rem)} ${f2(r * rem)} 0 1 0 ${f2(2 * r * rem)} 0a${f2(r * rem)} ${f2(r * rem)} 0 1 0 ${f2(-2 * r * rem)} 0Z`;
      }
    }
  } else {
    const half = Math.min(0.3, Math.max(0.08, (rem * 0.6) / Math.sqrt(rx * ry)));
    const [ax, ay] = at(t0 - half);
    const [bx, by] = at(t0 + half);
    const tx = ex + ux * len;
    const ty = ey + uy * len;
    d = `M${f2(ax)} ${f2(ay)}L${f2(tx)} ${f2(ty)}L${f2(bx)} ${f2(by)}A${f2(rx)} ${f2(ry)} 0 1 1 ${f2(ax)} ${f2(ay)}Z`;
  }
  svg.querySelector('path').setAttribute('d', d);
  el.style.transformOrigin = `${f2(lx)}px ${f2(ly)}px`;
}
addEventListener('resize', () => requestAnimationFrame(placeBubble));

// Replies arrive seconds after the last tap, and phone browsers (Huawei's among them)
// often refuse to start an <audio> element by then. So sound goes through one Web Audio
// context that every tap keeps unlocked; an <audio> element is the fallback.
function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const fresh = !audioCtx;
  if (fresh) audioCtx = new Ctx();
  if (!fresh && audioCtx.state === 'running') return;
  audioCtx.resume().catch(() => {});
  // A silent blip started inside the tap is what some browsers need before they allow sound later.
  const blip = audioCtx.createBufferSource();
  blip.buffer = audioCtx.createBuffer(1, 1, 22050);
  blip.connect(audioCtx.destination);
  blip.start(0);
}
// On a touch screen the finger lifting (pointerup, touchend) is what counts as a tap for
// sound, not the finger landing, so listen for both.
for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
  document.addEventListener(type, unlockAudio, { passive: true, capture: true });
}

// The voice arrives as 16-bit PCM pieces while it is still being made, and she
// starts talking with the first piece instead of waiting for the whole line.
async function playVoice(res, mine, onStart) {
  const rate = Number((/rate=(\d+)/.exec(res.headers.get('X-Audio-Format') || '') || [])[1]) || 24000;
  if (audioCtx && audioCtx.state !== 'running') await audioCtx.resume().catch(() => {});
  if (!audioCtx || audioCtx.state !== 'running' || !res.body || !res.body.getReader) {
    const pcm = new Uint8Array(await res.arrayBuffer());
    if (mine()) await playWav(pcm, rate, () => onStart(false));
    return;
  }
  const player = new VoicePlayer(audioCtx, rate, () => onStart(true));
  const reader = res.body.getReader();
  currentAudio = {
    stop() {
      player.stop();
      reader.cancel().catch(() => {});
    },
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !mine()) break;
      player.push(value);
    }
  } catch (err) {
    console.warn('the voice broke off', err); // play what did arrive
  }
  await player.finish();
}

// Queues PCM pieces back to back on a Web Audio context. Each piece is resampled to
// the context's own rate, carrying the position across pieces, so every buffer is a
// whole number of frames and starts exactly where the last one ended: no seams.
class VoicePlayer {
  constructor(ctx, rate, onStart) {
    this.ctx = ctx;
    this.step = rate / ctx.sampleRate; // input samples per output frame
    this.input = new Float32Array(0); // decoded samples not yet resampled
    this.pos = 0; // where the next output frame falls in `input`
    this.odd = null; // a byte left over when a piece split a sample in two
    this.held = []; // the first audio, held until there is enough to start smoothly
    this.heldFrames = 0;
    this.at = 0; // when the next buffer starts, in context time
    this.started = false;
    this.done = false;
    this.stopped = false;
    this.sources = new Set();
    this.onStart = onStart;
    this.ended = null;
  }

  push(bytes) {
    if (this.stopped || !bytes.length) return;
    let b = bytes;
    if (this.odd !== null) {
      b = new Uint8Array(bytes.length + 1);
      b[0] = this.odd;
      b.set(bytes, 1);
      this.odd = null;
    }
    if (b.length % 2) {
      this.odd = b[b.length - 1];
      b = b.subarray(0, b.length - 1);
    }
    const keep = Math.min(Math.floor(this.pos), this.input.length);
    const input = new Float32Array(this.input.length - keep + b.length / 2);
    input.set(this.input.subarray(keep));
    const view = new DataView(b.buffer, b.byteOffset, b.length);
    for (let i = 0, j = this.input.length - keep; i < b.length; i += 2, j += 1) input[j] = view.getInt16(i, true) / 32768;
    this.input = input;
    this.pos -= keep;
    this.render(false);
  }

  // Resample what can be resampled now; at the end, the last sample too.
  render(last) {
    const { input, step } = this;
    const out = new Float32Array(Math.max(0, Math.ceil((input.length - this.pos) / step)) + 1);
    let n = 0;
    while (this.pos + 1 < input.length || (last && this.pos < input.length)) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      out[n++] = i + 1 < input.length ? input[i] + (input[i + 1] - input[i]) * f : input[i];
      this.pos += step;
    }
    if (n || last) this.queue(out.subarray(0, n), last);
  }

  queue(frames, last) {
    if (frames.length) {
      this.held.push(frames);
      this.heldFrames += frames.length;
    }
    const ctx = this.ctx;
    if (!this.started) {
      // Wait for an eighth of a second of sound (or the whole line, if shorter) before starting.
      if (this.heldFrames < ctx.sampleRate * 0.12 && !last) return;
      if (!this.heldFrames) return;
      this.started = true;
      this.at = ctx.currentTime + 0.05;
      this.startTimer = setTimeout(this.onStart, 50);
    }
    if (!this.heldFrames) return;
    const all = new Float32Array(this.heldFrames);
    let o = 0;
    for (const h of this.held) {
      all.set(h, o);
      o += h.length;
    }
    this.held = [];
    this.heldFrames = 0;
    if (this.at < ctx.currentTime + 0.01) this.at = ctx.currentTime + 0.03; // ran dry: go on after a short gap
    const buffer = ctx.createBuffer(1, all.length, ctx.sampleRate);
    buffer.getChannelData(0).set(all);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx === audioCtx ? voiceBus() : ctx.destination);
    src.onended = () => {
      this.sources.delete(src);
      if (this.done && !this.sources.size && this.ended) this.ended();
    };
    src.start(this.at);
    this.sources.add(src);
    this.at += all.length / ctx.sampleRate;
  }

  // Resolves when the last of the line has been heard (or right away if stopped).
  finish() {
    if (!this.stopped) {
      if (this.odd !== null) this.push(new Uint8Array([0]));
      this.render(true);
    }
    this.done = true;
    return new Promise((resolve) => {
      this.ended = resolve;
      if (this.stopped || !this.sources.size) resolve();
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.startTimer);
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* not started yet or already over */
      }
    }
    this.sources.clear();
    if (this.ended) this.ended();
  }
}

// Without Web Audio: the whole line as a WAV file through an <audio> element.
async function playWav(pcm, rate, onStart) {
  const header = new DataView(new ArrayBuffer(44));
  const text = (at, s) => [...s].forEach((c, i) => header.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  header.setUint32(4, 36 + pcm.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, pcm.length, true);
  const url = URL.createObjectURL(new Blob([header.buffer, pcm], { type: 'audio/wav' }));
  try {
    await new Promise((resolve) => {
      const a = new Audio(url);
      currentAudio = {
        stop() {
          a.pause();
          resolve();
        },
      };
      a.onplaying = onStart;
      a.onended = a.onerror = a.onpause = () => resolve();
      a.play().catch(() => resolve());
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function browserSpeak(text, onStart) {
  return new Promise((resolve) => {
    if (!text || !('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.0;
    u.pitch = 1.15;
    const voice = speechSynthesis.getVoices().find((v) => /zh[-_]CN/i.test(v.lang));
    if (voice) u.voice = voice;
    u.onend = u.onerror = () => resolve();
    // Some tablets never report the end; don't let her mouth run forever.
    setTimeout(resolve, 2000 + text.length * 350);
    speechSynthesis.speak(u);
    onStart();
  });
}

function stopSpeaking() {
  speakSeq += 1; // whatever line was in progress is no longer ours
  look.speaking = false;
  look.feel = null;
  lipsStop();
  if (currentAudio) {
    currentAudio.stop();
    currentAudio = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  pose();
}

function chime() {
  if (!audioCtx) return Promise.resolve();
  const t0 = audioCtx.currentTime;
  [0, 0.25, 0.5, 1.0, 1.25, 1.5].forEach((dt, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = i % 3 === 2 ? 1046 : 880;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.2);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 0.22);
  });
  return new Promise((r) => setTimeout(r, 1900));
}

// ---- conversation ------------------------------------------------------------

async function send(text) {
  if (!text) return;
  stopSpeaking();
  setBusy(true, '想一想…');
  $('heard').hidden = false;
  $('heard').textContent = `你说：${text}`;
  try {
    const r = await api('/api/chat', { text });
    if (r.state) render(r.state);
    setBusy(false);
    await say(r.reply, { pet: r.petAction });
  } catch (err) {
    setBusy(false);
    if (err.message !== 'locked') await say('哎呀，网络有点慢，我们再试一次好吗？', { mood: 'worried' });
  }
}

// While busy she wears her thinking face; it clears when she next speaks.
function setBusy(on, label) {
  busy = on;
  const mic = $('mic');
  mic.classList.toggle('busy', on);
  mic.textContent = on ? label : '按一下说话';
  if (on) {
    look.thinking = true;
    pose();
    showThinking();
    petLife.ponder();
  }
}

// ---- listening (16 kHz mono WAV) ---------------------------------------------

async function startListening() {
  stopSpeaking();
  fetch('/api/warm', { method: 'POST' }).catch(() => {}); // server opens its connections while the child talks
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch {
    $('typeForm').hidden = false;
    await say('我听不到声音，麦克风好像没打开。先打字跟我说吧。', { mood: 'worried' });
    return;
  }
  const src = audioCtx.createMediaStreamSource(stream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  const r = { stream, src, proc, bufs: [], total: 0, heard: false, silentMs: 0, first: -1, last: -1, t0: Date.now(), rate: audioCtx.sampleRate };
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    r.bufs.push(new Float32Array(d));
    r.total += d.length;
    let sum = 0;
    for (let i = 0; i < d.length; i += 1) sum += d[i] * d[i];
    const rms = Math.sqrt(sum / d.length);
    if (rms > 0.02) {
      r.heard = true;
      r.silentMs = 0;
      if (r.first < 0) r.first = r.bufs.length - 1;
      r.last = r.bufs.length - 1;
    } else if (r.heard) {
      r.silentMs += (d.length / r.rate) * 1000;
    }
    if ((r.heard && r.silentMs > 800) || Date.now() - r.t0 > 15000) stopListening();
  };
  src.connect(proc);
  proc.connect(audioCtx.destination);
  rec = r;
  $('bubble').classList.add('dim');
  petLife.hearMoMo();
  const mic = $('mic');
  mic.classList.add('listening');
  mic.textContent = '说完点我';
}

async function stopListening() {
  const r = rec;
  if (!r) return;
  rec = null;
  $('bubble').classList.remove('dim');
  r.proc.disconnect();
  r.src.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  $('mic').classList.remove('listening');
  if (!r.heard) {
    setBusy(false);
    petLife.release();
    return;
  }
  setBusy(true, '在听…');
  try {
    // Only the stretch with speech in it, plus a little air: from here every second of
    // audio costs real upload time on the way to the recogniser.
    const speech = r.bufs.slice(Math.max(0, r.first - 3), r.last + 4);
    const wav = encodeWav16k(speech, speech.reduce((n, b) => n + b.length, 0), r.rate);
    const { text } = await api('/api/asr', { wav });
    setBusy(false);
    if (text) await send(text);
    else await say('我没听清楚，可以再说一遍吗？', { mood: 'worried' });
  } catch (err) {
    setBusy(false);
    if (err.message !== 'locked') await say('我没听清楚，可以再说一遍吗？', { mood: 'worried' });
  }
}

function encodeWav16k(bufs, total, srcRate) {
  const ratio = srcRate / 16000;
  const outLen = Math.floor(total / ratio);
  const pcm = new Int16Array(outLen);
  const all = new Float32Array(total);
  let off = 0;
  for (const b of bufs) {
    all.set(b, off);
    off += b.length;
  }
  for (let i = 0; i < outLen; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = start; j < end; j += 1) s += all[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, end - start)));
    pcm[i] = v < 0 ? v * 32768 : v * 32767;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true);
  dv.setUint32(28, 32000, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---- taps on the characters --------------------------------------------------------
// A tap on her gets a little bounce and a smile; now and then, when she isn't busy,
// a few words too. A tap on the pet makes it hop and chirp.

const POKE_LINES = ['嘻嘻，好痒呀！', '我在呢～想跟我说什么？', '嘿嘿，被你发现啦！', '再戳我，我就要笑出来啦！', '你戳我一下，我也戳你一下！'];
let lastPokeLine = 0;
const pick = (list) => list[Math.floor(Math.random() * list.length)];

$('girlFig').addEventListener('click', () => {
  if (!started || !state) return;
  replay($('girlFig'), 'poked');
  petLife.call(); // the pet runs over to see
  if (look.speaking || look.thinking || busy || rec) return; // busy: the bounce is enough
  if (Date.now() - lastPokeLine > 8000) {
    lastPokeLine = Date.now();
    say(pick(POKE_LINES), { mood: pick(['happy', 'cheer']) });
  } else mood(pick(['happy', 'cheer']), 1400);
});

// Three taps on the pet in a row and she has something to say about it.
const PET_LINES = ['{p}好喜欢你呀！', '{p}，别闹啦，嘻嘻～', '你看{p}多开心！', '{p}在跟你玩呢！'];
let petTaps = [];
let lastPetLine = 0;
$('petFig').addEventListener('click', () => {
  if (!started || !state) return;
  const p = state.pets[state.profile.pet];
  petLife.poked();
  if (p) petCaption(`${p.sound} ${p.name}${pick(p.moves)}`, 2600);
  if (!look.speaking && !rec) chirp();
  const now = Date.now();
  petTaps = [...petTaps.filter((t) => now - t < 6000), now];
  if (p && petTaps.length >= 3 && girlFree() && now - lastPetLine > 40000) {
    lastPetLine = now;
    petTaps = [];
    say(pick(PET_LINES).replace('{p}', p.name), { mood: 'happy' });
  }
});

// Two quick rising notes, quiet.
function chirp() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime + 0.01;
  [0, 0.13].forEach((dt, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(i ? 760 : 620, t0 + dt);
    o.frequency.exponentialRampToValueAtTime(i ? 1500 : 1180, t0 + dt + 0.1);
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.12);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 0.13);
  });
}

// ---- tasks, picker -----------------------------------------------------------

let pending = null;
function askDone(t) {
  if (t.status === 'waiting' || t.status === 'confirmed') {
    say(t.status === 'waiting' ? `「${t.title}」已经记下啦，等妈妈看过就有好感度。` : `「${t.title}」妈妈已经确认过啦，真棒！`);
    return;
  }
  pending = t;
  $('confirmText').textContent = `「${t.title}」做完了吗？`;
  $('confirm').hidden = false;
}

$('confirmYes').addEventListener('click', async () => {
  $('confirm').hidden = true;
  if (!pending) return;
  const t = pending;
  pending = null;
  try {
    const r = await api(`/api/tasks/${t.id}/done`, {});
    render(r.state);
    const p = state.pets[state.profile.pet];
    await say(`记下啦！等妈妈看过，好感度就会涨。`, { mood: 'happy', pet: p ? `${p.name}${p.moves[0]}` : null });
  } catch (err) {
    await say('哎呀，没记上，再点一次试试？', { mood: 'worried' });
  }
});
$('confirmNo').addEventListener('click', () => {
  $('confirm').hidden = true;
  pending = null;
});

function openPicker() {
  const fill = (box, items, kind, current) => {
    box.textContent = '';
    for (const [k, v] of Object.entries(items)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(k === current));
      b.innerHTML = '<img alt=""><span></span>';
      // Every pet is shown at the stage MoMo has reached, which is how it would look if picked.
      b.querySelector('img').src = kind === 'girl' ? `/img/girl_${k}.jpg` : `/img/pet/${k}_${state.affinity.stage}.jpg`;
      b.querySelector('span').textContent = v.name;
      b.addEventListener('click', () => choose(kind, k));
      box.appendChild(b);
    }
  };
  fill($('pickGirls'), state.girls, 'girl', state.profile.girl);
  fill($('pickPets'), state.pets, 'pet', state.profile.pet);
  $('picker').hidden = false;
}

async function choose(kind, key) {
  try {
    const r = await api('/api/profile', kind === 'girl' ? { girl: key } : { pet: key });
    render(r.state);
    openPicker();
    if (kind === 'girl') say(`我是${state.girls[key].name}，以后我陪着你！`, { mood: 'happy' });
    else {
      const p = state.pets[key];
      say(`${p.name}来啦！`, { pet: `${p.name}${p.moves[0]}` });
    }
  } catch (err) {
    say('换不了这个伙伴，问问妈妈吧。', { mood: 'worried' });
  }
}

$('swap').addEventListener('click', openPicker);
$('pickClose').addEventListener('click', () => ($('picker').hidden = true));

// ---- live events -------------------------------------------------------------

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = async (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.type === 'refresh') return load();
    if (ev.type === 'reviewed') return reviewed(ev);
    if (ev.type === 'alarm') await chime();
    if (ev.line) {
      const p = state && state.pets[state.profile.pet];
      await say(ev.line, { pet: p ? `${p.name}${p.moves[1] || p.moves[0]}` : null });
    }
    load();
  };
}

// Mom just looked at a task on her phone.
async function reviewed(ev) {
  try {
    render(await api('/api/state'));
  } catch {
    /* the line still makes sense without fresh numbers */
  }
  const p = state && state.pets[state.profile.pet];
  if (ev.approve) {
    await say(`妈妈看过「${ev.title}」啦，说你做得真棒！${ev.points ? `好感度加 ${ev.points}。` : ''}`, { mood: 'cheer', pet: p ? `${p.name}${p.moves[0]}` : null });
  } else {
    await say(`妈妈说「${ev.title}」还要再做一下。没关系，我陪着你，加油！`, { mood: 'happy' });
  }
}

// ---- start -------------------------------------------------------------------

async function wakeLock() {
  try {
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
  } catch {
    /* not available */
  }
}

$('startBtn').addEventListener('click', async () => {
  started = true;
  $('start').hidden = true;
  $('app').hidden = false;
  unlockAudio();
  if (audioCtx) await audioCtx.resume().catch(() => {});
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
  wakeLock();
  connectEvents();
  // The server logs the screen size and browser, so layouts can be tuned for the real devices.
  fetch('/api/hello', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }),
  }).catch(() => {});
  if (state) render(state); // someone is watching now, so a new pet stage can be announced
  blinkLater();
  spritesReady.then(() =>
    requestAnimationFrame(() => {
      petLife.layout();
      if (state && state.quiet) petLife.bedtime();
      else petLife.start();
    }),
  );
  const kid = state ? state.profile.kidName : '';
  say(`${kid}，我在这儿呢！想问什么就按一下说话。`, { mood: 'happy' });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && started) {
    wakeLock();
    load();
  }
});

$('mic').addEventListener('click', () => {
  if (rec) return stopListening();
  if (busy) {
    stopSpeaking();
    return;
  }
  startListening();
});
$('kbd').addEventListener('click', () => {
  $('typeForm').hidden = !$('typeForm').hidden;
  if (!$('typeForm').hidden) $('typeText').focus();
});
$('typeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('typeText').value.trim();
  $('typeText').value = '';
  send(text);
});

setInterval(() => started && load(), 60000);
load();
