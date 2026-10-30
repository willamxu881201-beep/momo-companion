// Kid page: talk to the companion, see today's tasks, watch the pet grow. The
// companion herself (stage, voice, listening) lives in companion.js, shared with Mom's page.

import {
  $, api, app, chime, look, placeBubble, pose, say, sendFile, setBusy, showCharacters, sleep, snapshot, stopSpeaking, wakeUp,
} from './companion.js';

app.send = send;
app.onLocked = showLocked;
app.reload = load;

// ---- server ------------------------------------------------------------------

async function load() {
  try {
    render(await api('/api/state'));
    if (app.evolved && !look.speaking) say('');
  } catch (err) {
    if (err.message !== 'locked') console.warn(err);
  }
}

function showLocked() {
  $('locked').hidden = false;
  $('start').hidden = true;
  $('app').hidden = true;
}

// ---- rendering ---------------------------------------------------------------

const STATUS = { todo: '', redo: '再做一下', waiting: '⏳ 等妈妈看', confirmed: '✓ 完成' };

function render(s) {
  app.state = s;
  const g = s.profile.girl;
  const p = s.profile.pet;
  showCharacters(s);
  $('startImg').src = `/img/girl_${g}.jpg`;
  $('date').textContent = s.dateZh;
  $('dlabel').textContent = s.today.label;

  const nowMin = s.now.minutes;
  const open = s.tasks.filter((t) => t.status === 'todo' || t.status === 'redo');
  const upcoming = open.find((t) => t.time && toMin(t.time) >= nowMin - 30) || open[0];
  const now = s.activity && s.tasks.find((t) => t.id === s.activity.id);
  $('next').textContent = now
    ? `现在：${now.icon || ''}${now.title}${s.activity.place ? ` · ${s.scenes[s.activity.place]}` : ''}`
    : upcoming
      ? `下一件：${upcoming.icon || ''}${upcoming.title}${upcoming.time ? ' ' + upcoming.time : ''}`
      : s.tasks.length ? '今天的事都交给妈妈看啦' : '';

  const a = s.alarms[0];
  $('alarm').hidden = !a;
  if (a) $('alarm').textContent = `⏰ ${a.date === s.now.date ? '' : '明天 '}${a.time} ${a.label}`;
  // Mom's looks through the camera are never secret: MoMo sees how many there were today.
  $('looked').hidden = !s.looked;
  if (s.looked) $('looked').textContent = `📷 妈妈今天看过 ${s.looked.n} 次 · ${s.looked.last}`;

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

  if (!app.started) {
    $('locked').hidden = true;
    $('start').hidden = false;
  }
}

// The last stage seen on this tablet, so each new one is announced once. Never
// at night: growth that happens after bedtime is a surprise for the morning.
function noteStage(s) {
  if (!app.started || s.quiet) return;
  const now = s.affinity.stage;
  let seen = null;
  try {
    seen = Number(localStorage.getItem('momo.stage')) || null;
  } catch {
    return; // storage blocked: skip the announcement rather than repeat it
  }
  if (seen && now > seen) {
    const p = s.pets[s.profile.pet];
    app.evolved = `${p ? p.name : '宠物'}进化啦，${s.affinity.stageUp || `现在是第 ${now} 阶段`}！`;
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

// ---- tasks, picker -----------------------------------------------------------

// A task tapped: start it now (the scene goes to its place), or say it's done.
let pending = null;
function askDone(t) {
  if (t.status === 'waiting' || t.status === 'confirmed') {
    say(t.status === 'waiting' ? `「${t.title}」已经记下啦，等妈妈看过就有好感度。` : `「${t.title}」妈妈已经确认过啦，真棒！`);
    return;
  }
  pending = t;
  const going = t.started || (app.state.activity && app.state.activity.id === t.id);
  $('confirmText').textContent = going ? `「${t.title}」做完了吗？` : `「${t.title}」：现在开始，还是已经做完了？`;
  $('confirmStart').hidden = Boolean(going);
  $('confirm').hidden = false;
}

$('confirmStart').addEventListener('click', async () => {
  $('confirm').hidden = true;
  if (!pending) return;
  const t = pending;
  pending = null;
  try {
    const r = await api(`/api/tasks/${t.id}/start`, {});
    render(r.state);
    await say(r.line, { mood: 'cheer' });
  } catch (err) {
    if (err.message !== 'locked') await say(`哎呀，${err.message}。`, { mood: 'worried' });
  }
});

$('confirmYes').addEventListener('click', async () => {
  $('confirm').hidden = true;
  if (!pending) return;
  const t = pending;
  pending = null;
  try {
    const r = await api(`/api/tasks/${t.id}/done`, {});
    render(r.state);
    const p = app.state.pets[app.state.profile.pet];
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
      b.querySelector('img').src = kind === 'girl' ? `/img/girl_${k}.jpg` : `/img/pet/${k}_${app.state.affinity.stage}.jpg`;
      b.querySelector('span').textContent = v.name;
      b.addEventListener('click', () => choose(kind, k));
      box.appendChild(b);
    }
  };
  fill($('pickGirls'), app.state.girls, 'girl', app.state.profile.girl);
  fill($('pickPets'), app.state.pets, 'pet', app.state.profile.pet);
  // Where free time is spent: a picture of each place ('plain' is the page's own colours).
  $('pickScenes').replaceChildren(
    ...app.state.freeScenes.map((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(k === app.state.profile.scene));
      b.innerHTML = k === 'plain' ? '<i class="plain"></i><span></span>' : '<img alt=""><span></span>';
      if (k !== 'plain') b.querySelector('img').src = `/img/scene/${k}_day.webp`;
      b.querySelector('span').textContent = app.state.scenes[k];
      b.addEventListener('click', () => choose('scene', k));
      return b;
    }),
  );
  $('picker').hidden = false;
}

async function choose(kind, key) {
  try {
    const r = await api('/api/profile', { [kind]: key });
    render(r.state);
    openPicker();
    if (kind === 'girl') say(`我是${app.state.girls[key].name}，以后我陪着你！`, { mood: 'happy' });
    else if (kind === 'scene') say(r.state.activity ? `好呀，做完这件事，我们就去${app.state.scenes[key]}玩。` : `好呀，我们去${app.state.scenes[key]}！`, { mood: 'happy' });
    else {
      const p = app.state.pets[key];
      say(`${p.name}来啦！`, { pet: `${p.name}${p.moves[0]}` });
    }
  } catch (err) {
    say('换不了这个伙伴，问问妈妈吧。', { mood: 'worried' });
  }
}

$('swap').addEventListener('click', openPicker);
$('pickClose').addEventListener('click', () => ($('picker').hidden = true));

// ---- photos -------------------------------------------------------------------
// MoMo shows the companion a photo (homework, the teacher's list, a timetable) or a
// file; the companion reads it and says what she made of it.

$('photoBtn').addEventListener('click', () => $('photoInput').click());
$('photoInput').addEventListener('change', async () => {
  const file = $('photoInput').files[0];
  $('photoInput').value = '';
  if (!file) return;
  stopSpeaking();
  setBusy(true, file.type.startsWith('image/') ? '看一看…' : '读一读…');
  try {
    const r = await sendFile(file);
    if (r.state) render(r.state);
    setBusy(false);
    await say(r.line, { mood: 'happy' });
  } catch (err) {
    setBusy(false);
    if (err.message !== 'locked') await say(`哎呀，${err.message}。`, { mood: 'worried' });
  }
});

// ---- live events -------------------------------------------------------------
// One at a time and in order: a reminder, then Mom's message, then a check-in.

let queue = Promise.resolve();
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    queue = queue.then(() => handle(ev)).catch((err) => console.warn(err));
  };
}

// When the companion speaks up on her own (coach.js), she waits until MoMo isn't
// talking with her; a line that has waited two minutes is let go.
async function free() {
  const until = Date.now() + 120000;
  while (app.busy || app.rec || look.speaking || !$('confirm').hidden) {
    if (Date.now() > until) return false;
    await sleep(500);
  }
  return true;
}

async function handle(ev) {
  if (ev.type === 'refresh') return load();
  if (ev.proactive && !(await free())) return load();
  if (ev.type === 'reviewed') return reviewed(ev);
  if (ev.type === 'check') return lookIn(ev);
  if (ev.type === 'message') {
    await say(ev.line, { mood: 'happy' });
    return api(`/api/messages/${ev.id}/heard`, {}).catch(() => {});
  }
  if (ev.type === 'say') return say(ev.line, { mood: ev.mood || null });
  if (ev.type === 'alarm') await chime();
  if (ev.line) {
    const p = app.state && app.state.pets[app.state.profile.pet];
    await say(ev.line, { pet: p ? `${p.name}${p.moves[1] || p.moves[0]}` : null });
  }
  load();
}

// Mom asked to look in. The companion says so while the camera opens (its picture
// shows in the corner), takes one photo (and listens a few seconds for the piano),
// and sends it to Mom.
async function lookIn(ev) {
  const told = say(ev.line, { mood: 'happy' });
  let body;
  try {
    body = await snapshot({ listen: ev.listen });
  } catch {
    body = { error: 'camera' };
  }
  await told;
  await api(`/api/checks/${ev.id}`, body).catch(() => {});
  if (body.error) await say('摄像头打不开，这次没拍成，没关系。', { mood: 'worried' });
  else await say('拍好啦，我拿给妈妈看。', { mood: 'happy' });
}

// Mom just looked at a task on her phone.
async function reviewed(ev) {
  try {
    render(await api('/api/state'));
  } catch {
    /* the line still makes sense without fresh numbers */
  }
  const p = app.state && app.state.pets[app.state.profile.pet];
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
  $('start').hidden = true;
  $('app').hidden = false;
  await wakeUp();
  wakeLock();
  connectEvents();
  // The server logs the screen size and browser, so layouts can be tuned for the real devices.
  fetch('/api/hello', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }),
  }).catch(() => {});
  if (app.state) render(app.state); // someone is watching now, so a new pet stage can be announced
  const kid = app.state ? app.state.profile.kidName : '';
  say(`${kid}，我在这儿呢！想问什么就按一下说话。`, { mood: 'happy' });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.started) {
    wakeLock();
    load();
  }
});

setInterval(() => app.started && load(), 60000);
load();
