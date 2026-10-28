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

// ---- the two characters ------------------------------------------------------
// Each is a stack of layers in one frame (see kid.css). show() asks for a loop,
// a still, or a loop with a still standing in for it. A loop only lights once it
// has really played, so the still underneath covers every failure: no H.264,
// iOS Low Power Mode, slow Wi-Fi.

const STILL_ONLY = matchMedia('(prefers-reduced-motion: reduce)').matches;
// The colour each loop was painted on, where its edge fades out (sampled from the videos).
// The page background is a gradient between the girl's and the pet's, so both melt into it.
const GIRL_BG = { a: '#ead2ce', b: '#94b8c7', c: '#c8a782', d: '#9fa3db' };
const PET_BG = {
  '1_1': '#f3e1c9', '1_2': '#ecdbc9', '1_3': '#ead7c5', '1_4': '#e3d4c5',
  '2_1': '#dfbd84', '2_2': '#dcb987', '2_3': '#d3c0a1', '2_4': '#d7c3a1',
  '3_1': '#e3c0cb', '3_2': '#e2b9cc', '3_3': '#dbb9ca', '3_4': '#debed0',
  '4_1': '#a2c3d1', '4_2': '#9ebfcf', '4_3': '#a3c4d5', '4_4': '#99bcc7',
};
const EXPRESSIONS = ['happy', 'talk', 'think', 'sleepy', 'cheer', 'worried'];

class Figure {
  constructor(fig) {
    this.fig = fig;
    this.base = fig.querySelector('.base');
    this.expr = fig.querySelector('.expr');
    this.loops = {};
    this.want = {};
    this.seq = 0;
    this.warmKey = '';
    this.warm = [];
    for (const v of fig.querySelectorAll('video')) {
      v.muted = true; // iOS looks at the property, not only the attribute
      v.addEventListener('playing', () => {
        v.ok = true;
        this.paint();
      });
      v.addEventListener('error', () => {
        v.failed = true;
        this.paint();
      });
      this.loops[v.dataset.loop] = v;
    }
  }

  // The bottom still, the loops by name, and stills worth fetching ahead of time.
  set(base, loops, extras) {
    if (this.base.getAttribute('src') !== base) this.base.src = base;
    for (const [name, v] of Object.entries(this.loops)) {
      const src = STILL_ONLY ? null : loops[name] || null;
      if (v.getAttribute('src') === src) continue;
      v.ok = false;
      v.failed = false;
      if (src) v.src = src;
      else {
        v.removeAttribute('src');
        v.load();
      }
    }
    const key = extras.join('|');
    if (key !== this.warmKey) {
      this.warmKey = key;
      this.warm = extras.map((src) => Object.assign(new Image(), { src }));
    }
  }

  // { loop: 'idle' }, { img: url }, or both: the image stands in while the loop can't play.
  show(want) {
    this.want = want;
    this.paint();
  }

  paint() {
    const asked = this.want.loop ? this.loops[this.want.loop] : null;
    const usable = asked && asked.getAttribute('src') && !asked.failed ? asked : null;
    for (const v of Object.values(this.loops)) {
      if (v === usable) {
        if (v.paused) {
          v.play().catch((err) => {
            if (err && err.name === 'AbortError') return; // we paused it again before it started
            v.failed = true;
            this.paint();
          });
        }
      } else if (!v.paused) v.pause();
      v.classList.toggle('on', v === usable && v.ok === true);
    }
    const live = Boolean(usable && usable.ok);
    this.fig.classList.toggle('live', live);
    this.still(live ? null : this.want.img || null);
  }

  // The expression layer. A new picture is decoded first so it never fades in half-drawn.
  async still(url) {
    const seq = ++this.seq;
    if (!url) {
      this.expr.classList.remove('on');
      return;
    }
    if (this.expr.getAttribute('src') !== url) {
      this.expr.src = url;
      try {
        await this.expr.decode();
      } catch {
        return; // missing picture: leave whatever is under it
      }
      if (seq !== this.seq) return;
    }
    this.expr.classList.add('on');
  }

  // Called inside the start tap: a play() begun by a gesture unlocks the element
  // for later, even where muted autoplay is otherwise blocked.
  prime() {
    for (const v of Object.values(this.loops)) {
      if (!v.getAttribute('src')) continue;
      v.failed = false;
      v.play().then(() => this.paint(), () => {});
    }
  }
}

const girl = new Figure($('girlFig'));
const pet = new Figure($('petFig'));
const look = { speaking: false, thinking: false, mood: null, petMood: null };

// Most important first: a passing mood, talking, thinking, asleep at night, idle.
function pose() {
  if (!state) return;
  const face = (name) => `/img/expr/${state.profile.girl}_${name}.jpg`;
  if (look.mood) girl.show({ img: face(look.mood) });
  else if (look.speaking) girl.show({ loop: 'talk', img: face('talk') });
  else if (look.thinking) girl.show({ img: face('think') });
  else if (state.quiet) girl.show({ img: face('sleepy') });
  else girl.show({ loop: 'idle' });
  girl.fig.classList.toggle('talking', look.speaking);

  const p = `/img/pet/${state.profile.pet}_${state.affinity.stage}`;
  if (look.petMood) pet.show({ img: `${p}_${look.petMood}.jpg` });
  else if (state.quiet) pet.show({ img: `${p}_sleepy.jpg` });
  else pet.show({ loop: 'idle' });
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
  girl.set(`/img/girl_${g}.jpg`, { idle: `/vid/girl_${g}_idle.mp4`, talk: `/vid/girl_${g}_talk.mp4` },
    EXPRESSIONS.map((n) => `/img/expr/${g}_${n}.jpg`));
  pet.set(`/img/pet/${p}_${stage}.jpg`, { idle: `/vid/pet_${p}_${stage}.mp4` },
    ['happy', 'sleepy'].map((n) => `/img/pet/${p}_${stage}_${n}.jpg`));
  $('girlImg').alt = s.girls[g] ? s.girls[g].name : '';
  $('petImg').alt = s.pets[p] ? s.pets[p].name : '';
  $('startImg').src = `/img/girl_${g}.jpg`;
  $('who').textContent = s.girls[g] ? s.girls[g].name : '';
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

function say(text, petAction) {
  if (evolved) {
    text = `${text}哇！${evolved}`;
    evolved = null;
    petAction = petAction || '✨ 进化啦 ✨';
    mood('cheer', 3000);
    const fig = $('petFig');
    fig.classList.remove('evolve');
    void fig.offsetWidth;
    fig.classList.add('evolve');
    clearTimeout(say.evolveTimer);
    say.evolveTimer = setTimeout(() => fig.classList.remove('evolve'), 4500);
  }
  $('say').textContent = text;
  if (petAction) {
    $('petSay').textContent = petAction;
    $('petSay').hidden = false;
    const fig = $('petFig');
    fig.classList.remove('react');
    void fig.offsetWidth;
    fig.classList.add('react');
    clearTimeout(say.petTimer);
    say.petTimer = setTimeout(() => ($('petSay').hidden = true), 6000);
    petMood('happy');
  }
  return speak(text);
}

async function speak(text) {
  stopSpeaking();
  const my = ++speakSeq;
  const mine = () => my === speakSeq;
  // Her mouth moves only while there is sound; until then she keeps her thinking face.
  const mouth = (on) => {
    if (!mine()) return;
    look.speaking = on;
    look.thinking = false;
    pose();
  };
  try {
    if (state && state.tts) {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!mine()) return; // a newer line took over while this one was fetched
      if (res.status === 200) {
        const bytes = await res.arrayBuffer();
        if (mine()) await playClip(bytes, () => mouth(true));
        return;
      }
    }
    await browserSpeak(text, () => mouth(true));
  } catch (err) {
    console.warn('speak failed', err);
  } finally {
    mouth(false);
  }
}

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

async function playClip(bytes, onStart) {
  if (audioCtx) {
    try {
      if (audioCtx.state !== 'running') await audioCtx.resume();
      const buffer = await audioCtx.decodeAudioData(bytes.slice(0));
      if (audioCtx.state === 'running') {
        await new Promise((resolve) => {
          const src = audioCtx.createBufferSource();
          src.buffer = buffer;
          src.connect(audioCtx.destination);
          src.onended = () => resolve();
          currentAudio = {
            stop() {
              try {
                src.stop();
              } catch {
                /* already stopped */
              }
              resolve();
            },
          };
          src.start();
          onStart();
        });
        return;
      }
    } catch (err) {
      console.warn('web audio failed, trying <audio>', err);
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
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
    await say(r.reply, r.petAction);
  } catch (err) {
    setBusy(false);
    if (err.message !== 'locked') {
      mood('worried');
      await say('哎呀，网络有点慢，我们再试一次好吗？');
    }
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
    mood('worried');
    await say('我听不到声音，麦克风好像没打开。先打字跟我说吧。');
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
    if ((r.heard && r.silentMs > 1000) || Date.now() - r.t0 > 15000) stopListening();
  };
  src.connect(proc);
  proc.connect(audioCtx.destination);
  rec = r;
  const mic = $('mic');
  mic.classList.add('listening');
  mic.textContent = '说完点我';
}

async function stopListening() {
  const r = rec;
  if (!r) return;
  rec = null;
  r.proc.disconnect();
  r.src.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  $('mic').classList.remove('listening');
  if (!r.heard) {
    setBusy(false);
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
    else {
      mood('worried');
      await say('我没听清楚，可以再说一遍吗？');
    }
  } catch (err) {
    setBusy(false);
    if (err.message !== 'locked') {
      mood('worried');
      await say('我没听清楚，可以再说一遍吗？');
    }
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
    mood('happy');
    await say(`记下啦！等妈妈看过，好感度就会涨。`, p ? `${p.name}${p.moves[0]}` : null);
  } catch (err) {
    mood('worried');
    await say('哎呀，没记上，再点一次试试？');
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
    if (kind === 'girl') {
      mood('happy');
      say(`我是${state.girls[key].name}，以后我陪着你！`);
    } else {
      const p = state.pets[key];
      say(`${p.name}来啦！`, `${p.name}${p.moves[0]}`);
    }
  } catch (err) {
    mood('worried');
    say('换不了这个伙伴，问问妈妈吧。');
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
      await say(ev.line, p ? `${p.name}${p.moves[1] || p.moves[0]}` : null);
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
    mood('cheer', 3000);
    await say(`妈妈看过「${ev.title}」啦，说你做得真棒！${ev.points ? `好感度加 ${ev.points}。` : ''}`, p ? `${p.name}${p.moves[0]}` : null);
  } else {
    mood('happy');
    await say(`妈妈说「${ev.title}」还要再做一下。没关系，我陪着你，加油！`);
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
  girl.prime();
  pet.prime();
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
  const kid = state ? state.profile.kidName : '';
  mood('happy', 2000);
  say(`${kid}，我在这儿呢！想问什么就按一下说话。`);
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
