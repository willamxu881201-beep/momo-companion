// Kid page: talk to the companion, see today's tasks, watch the pet grow.
'use strict';

const $ = (id) => document.getElementById(id);
let state = null;
let started = false;
let busy = false;
let audioCtx = null;
let rec = null;
let currentAudio = null;

// ---- server ------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    showUnpaired();
    throw new Error('unpaired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '出错了');
  return data;
}

async function load() {
  try {
    render(await api('/api/state'));
  } catch (err) {
    if (err.message !== 'unpaired') console.warn(err);
  }
}

function showUnpaired() {
  $('unpaired').hidden = false;
  $('start').hidden = true;
  $('app').hidden = true;
}

// ---- rendering ---------------------------------------------------------------

const STATUS = { todo: '', redo: '再做一下', waiting: '⏳ 等妈妈看', confirmed: '✓ 完成' };

function render(s) {
  state = s;
  const g = s.profile.girl;
  const p = s.profile.pet;
  document.body.dataset.girl = g;
  $('girlImg').src = `/img/girl_${g}.jpg`;
  $('girlImg').alt = s.girls[g] ? s.girls[g].name : '';
  $('petImg').src = `/img/pet_${p}.jpg`;
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

  const pet = s.pets[p] || { name: '' };
  const af = s.affinity;
  $('petName').textContent = pet.name;
  $('stageName').textContent = af.stageName || `第 ${af.stage} 阶段`;
  const pct = af.next ? Math.round(((af.points - af.prev) / (af.next - af.prev)) * 100) : 100;
  $('meterFill').style.width = `${Math.max(3, Math.min(100, pct))}%`;
  $('loveText').textContent = af.next ? `好感度 ${af.points}，再攒 ${af.next - af.points} 点就进化` : `好感度 ${af.points}，已经是最厉害的样子啦`;

  if (!started) {
    $('unpaired').hidden = true;
    $('start').hidden = false;
  }
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// ---- speaking ----------------------------------------------------------------

function say(text, petAction) {
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
  }
  return speak(text);
}

async function speak(text) {
  stopSpeaking();
  const girl = $('girlFig');
  girl.classList.add('talking');
  try {
    if (state && state.tts) {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.status === 200) {
        const url = URL.createObjectURL(await res.blob());
        await playAudio(url);
        URL.revokeObjectURL(url);
        return;
      }
    }
    await browserSpeak(text);
  } catch (err) {
    console.warn('speak failed', err);
  } finally {
    girl.classList.remove('talking');
  }
}

function playAudio(url) {
  return new Promise((resolve) => {
    const a = new Audio(url);
    currentAudio = a;
    a.onended = a.onerror = () => resolve();
    a.play().catch(() => resolve());
  });
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.0;
    u.pitch = 1.15;
    const voice = speechSynthesis.getVoices().find((v) => /zh[-_]CN/i.test(v.lang));
    if (voice) u.voice = voice;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
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
    if (err.message !== 'unpaired') await say('哎呀，网络有点慢，我们再试一次好吗？');
  }
}

function setBusy(on, label) {
  busy = on;
  const mic = $('mic');
  mic.classList.toggle('busy', on);
  mic.textContent = on ? label : '按一下说话';
}

// ---- listening (16 kHz mono WAV) ---------------------------------------------

async function startListening() {
  stopSpeaking();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch {
    $('typeForm').hidden = false;
    await say('我听不到声音，麦克风好像没打开。先打字跟我说吧。');
    return;
  }
  const src = audioCtx.createMediaStreamSource(stream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  const r = { stream, src, proc, bufs: [], total: 0, heard: false, silentMs: 0, t0: Date.now(), rate: audioCtx.sampleRate };
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
    } else if (r.heard) {
      r.silentMs += (d.length / r.rate) * 1000;
    }
    if ((r.heard && r.silentMs > 1300) || Date.now() - r.t0 > 15000) stopListening();
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
    const wav = encodeWav16k(r.bufs, r.total, r.rate);
    const { text } = await api('/api/asr', { wav });
    setBusy(false);
    if (text) await send(text);
    else await say('我没听清楚，可以再说一遍吗？');
  } catch (err) {
    setBusy(false);
    if (err.message !== 'unpaired') await say('我没听清楚，可以再说一遍吗？');
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
    const pet = state.pets[state.profile.pet];
    await say(`记下啦！等妈妈看过，好感度就会涨。`, pet ? `${pet.name}${pet.moves[0]}` : null);
  } catch (err) {
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
      b.querySelector('img').src = `/img/${kind}_${k}.jpg`;
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
    if (kind === 'girl') say(`我是${state.girls[key].name}，以后我陪着你！`);
    else {
      const p = state.pets[key];
      say(`${p.name}来啦！`, `${p.name}${p.moves[0]}`);
    }
  } catch (err) {
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
    if (ev.type === 'alarm') await chime();
    if (ev.line) {
      const pet = state && state.pets[state.profile.pet];
      await say(ev.line, pet ? `${pet.name}${pet.moves[1] || pet.moves[0]}` : null);
    }
    load();
  };
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
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  await audioCtx.resume().catch(() => {});
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
  $('start').hidden = true;
  $('app').hidden = false;
  wakeLock();
  connectEvents();
  const kid = state ? state.profile.kidName : '';
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
