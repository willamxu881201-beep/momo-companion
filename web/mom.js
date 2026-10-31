// Mom's page: the same companion as MoMo's, talking with Mom. She answers questions about
// MoMo's day, looks in on her through the tablet's camera, passes messages both ways,
// reads photos and documents (timetables, homework, notices, score sheets…) and answers
// from them, and keeps Mom posted as things happen. A rail on the left opens what Mom
// needs on the right, one at a time: the day's record (to begin with), today's tasks to
// confirm, what was just said, buttons to look in, and all the files — one opens there
// to look at and point at (viewer.js). The settings live in the 管理 sheet (admin.js).

import {
  $, api, app, busyLabel, petLife, pick, placeBubble, pose, say, sendFile, setBusy, showCharacters, sleep, stopSpeaking, wakeUp,
} from './companion.js';
import { initAdmin, refreshAdmin, refreshFiles, renderAdmin } from './admin.js';
import { caption, clearView, markFrom, showPages, view } from './viewer.js';

app.send = send;
app.followUp = () => Boolean(app.state && app.state.voice && app.state.voice.followUp); // 连续对话
app.onLocked = showLogin;
app.reload = reload;
app.pokeLines = ['妈妈好呀！', '我在呢，要我帮您看看沫沫吗？', '嘿嘿，妈妈也来戳我啦～'];
app.bubbleMax = 36; // her answers to Mom run longer: the whole of each is in the 刚才说的 list
app.onSay = (text) => {
  addChat('her', text);
  caption(text); // under a page on show, too
};
app.petLines = ['{p}也想妈妈啦！', '{p}在跟您打招呼呢！'];

let mom = null; // /api/parent/state
let events = null;

// ---- the rail and its panels -------------------------------------------------------
// One panel at a time on the right (below her, on a phone); the day's record to begin
// with, and again when one is closed. (文件's button, while a file is open in it, goes
// back to the list first; leaving it closes the file.)

let open = 'feed';

function openPanel(name) {
  open = name;
  for (const sec of $('side').children) sec.hidden = sec.id !== `panel-${name}`;
  document.querySelectorAll('.rail [data-panel]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.panel === name)));
  if (name !== 'files') {
    reading(false);
    if (!$('fileView').hidden) closeFile(); // the list, when she comes back
  }
  if (name === 'files' && !$('fileLib').hidden) refreshFiles();
  restage();
}

// A file open: the panel widens to read it in, and the characters make room.
function reading(on) {
  document.body.classList.toggle('reading', on);
  if (!on) clearView();
}

function restage() {
  requestAnimationFrame(() => {
    petLife.layout();
    placeBubble();
  });
}

document.querySelectorAll('.rail [data-panel]').forEach((b) =>
  b.addEventListener('click', () => {
    const name = b.dataset.panel;
    if (name === 'files' && open === 'files' && !$('fileView').hidden) return showLibrary();
    openPanel(open === name && open !== 'feed' ? 'feed' : name);
  }),
);
openPanel('feed');
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--dock-h', `${Math.round(e.target.getBoundingClientRect().height)}px`)).observe(document.querySelector('.dock'));

// ---- loading ------------------------------------------------------------------

async function load() {
  try {
    const [kid, parent] = await Promise.all([api('/api/state'), api('/api/parent/state')]);
    $('login').hidden = true;
    render(kid, parent);
    loadFeed();
    if (!app.started) $('start').hidden = false;
  } catch (err) {
    if (err.message !== 'locked') console.warn(err);
  }
}

function showLogin() {
  $('login').hidden = false;
  $('start').hidden = true;
  $('app').hidden = true;
  $('admin').hidden = true;
}

const STATUS = { todo: '还没做', redo: '要重做', waiting: '等你确认', confirmed: '✓ 已确认' };

// What the bar says: whether the tablet is on, and what MoMo is up to.
function tabletLine(kid, parent) {
  if (!parent.tablets) return '平板现在没打开';
  const a = kid.activity;
  if (!a) return `平板开着 · ${kid.profile.kidName}的伙伴在线`;
  return `平板开着 · ${kid.profile.kidName}${a.place ? `在${kid.scenes[a.place]}` : ''}：${a.title}${a.started ? `（${hhmm(a.from)} 开始）` : ''}`;
}
const KIND_ICON = {
  done: '✅', review: '👍', reminder: '⏰', alarm: '⏰', photo: '🖼️', timetable: '🗓️', homework_list: '📝',
  homework_page: '📖', check: '📷', message: '💬', task: '➕', undo: '↩️', document: '📄', file: '📁',
};
const hhmm = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}

function render(kid, parent) {
  app.state = kid;
  mom = parent;
  showCharacters(kid);
  $('startImg').src = `/img/girl_${kid.profile.girl}.jpg`;
  $('date').textContent = kid.dateZh;
  $('dlabel').textContent = kid.today.label;
  $('next').textContent = tabletLine(kid, parent);
  $('lookTitle').textContent = `看看${kid.profile.kidName}`;
  $('tellTitle').textContent = `想让伙伴告诉${kid.profile.kidName}什么？`;

  const list = $('tasks');
  list.replaceChildren(
    ...(parent.today.length
      ? parent.today.map((t) =>
          el('li', { class: t.status },
            el('div', { class: 'row-task' },
              el('span', { class: 'icon' }, t.icon || '⭐'),
              el('span', { class: 'what' }, el('span', { class: 'title' }, t.title), el('br'), el('span', { class: 'time' }, [t.time, t.note].filter(Boolean).join(' · ') || `约 ${t.minutes} 分钟`)),
              t.status === 'waiting'
                ? el('span', { class: 'acts' },
                    el('button', { class: 'ok', type: 'button', onclick: () => review(t, true) }, '✓ 确认'),
                    el('button', { class: 'redo', type: 'button', onclick: () => review(t, false) }, '再做'))
                : el('span', { class: 'st' }, STATUS[t.status] || ''),
            )))
      : [el('li', { class: 'empty' }, '今天还没有任务。可以跟伙伴说“加一个任务”，或者把作业清单拍照发给她。')]),
  );
  renderAdmin(parent);
  pose();
  placeBubble();
}

async function loadFeed() {
  try {
    const f = await api('/api/parent/feed');
    events = f.events;
    renderFeed();
    // MoMo's messages that came while the page was closed.
    if (app.started) for (const m of f.unread) await say(`${app.state.profile.kidName}让我告诉你：${m.text}`, { mood: 'happy' });
    else pendingUnread.push(...f.unread);
  } catch (err) {
    if (err.message !== 'locked') console.warn(err);
  }
}
const pendingUnread = [];

function renderFeed() {
  $('feed').replaceChildren(
    ...(events.length
      ? events.map((e) =>
          el('li', { class: e.undone ? 'undone' : '' },
            el('span', { class: 'when' }, hhmm(e.at)),
            el('span', { class: 'what' }, `${KIND_ICON[e.kind] || '·'} ${e.text}`),
            e.doc
              ? el('button', { class: 'thumb doc', type: 'button', onclick: () => showFile(e.fileId), 'aria-label': '看文件' }, e.kind === 'file' ? '📁' : '📄')
              : e.fileId ? el('button', { class: 'thumb', type: 'button', onclick: () => showPhoto(e), 'aria-label': '看照片' }, el('img', { src: `/api/parent/files/${e.fileId}`, alt: '', loading: 'lazy' })) : null,
            e.undo ? el('button', { class: 'undo', type: 'button', onclick: () => undo(e) }, '撤销') : null,
          ))
      : [el('li', { class: 'empty' }, '今天还没有动态')]),
  );
}

function showPhoto(e) {
  $('photoImg').src = `/api/parent/files/${e.fileId}`;
  $('photoText').textContent = `${hhmm(e.at)} ${e.text}`;
  $('photo').hidden = false;
}
$('photoClose').addEventListener('click', () => ($('photo').hidden = true));
$('photo').addEventListener('click', (e) => e.target === $('photo') && ($('photo').hidden = true));

// A file, open in the 文件 panel: its pages to look at and point at (a touch asks her
// what is there), what the companion made of it, how far reading it got, whether MoMo
// may see it, and the file itself to save.
const READ_ZH = { reading: '正在读', stored: '存着，读不了', failed: '这次没读成' };
let shownDoc = null;
async function showFile(id) {
  let d;
  try {
    d = await api(`/api/parent/docs/${id}`);
  } catch (err) {
    if (err.message !== 'locked') say(`没打开：${err.message}`, { mood: 'worried' });
    return;
  }
  shownDoc = d;
  $('fileLib').hidden = true;
  $('fileView').hidden = false;
  openPanel('files');
  reading(true);
  restage();
  const kid = app.state ? app.state.profile.kidName : '孩子';
  const doc = d.doc;
  const day = new Date(d.at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  $('docTitle').textContent = doc ? doc.title : d.name || '文件';
  $('docMeta').textContent = [`${day} ${hhmm(d.at)} ${d.who === 'kid' ? kid : '妈妈'}发来的${d.typeZh || ''}文件`, d.name && `《${d.name}》`, d.size, sizeZh(d.bytes), READ_ZH[d.status], d.cut && '太长，只存下了前面一大半'].filter(Boolean).join(' · ');
  $('docGist').textContent = doc ? doc.gist : d.summary;
  $('docShare').checked = d.shared;
  $('docShare').disabled = d.who === 'kid';
  $('docShareRow').hidden = d.status === 'reading';
  $('docReread').hidden = !['failed', 'stored'].includes(d.status);
  const list = (title, items) => (items.length ? [el('h3', {}, title), el('ul', {}, ...items.map((x) => el('li', {}, x)))] : []);
  $('docMore').replaceChildren(
    ...(doc
      ? [
          ...list('要点', doc.points),
          ...list('日子', doc.dates.map((x) => `${x.dateZh}：${x.what}`)),
          ...list('要做的', doc.todo),
        ]
      : []),
  );
  $('docSave').href = `/api/parent/files/${d.id}?download=1`;
  await showPages(d);
}

function showLibrary() {
  closeFile();
  refreshFiles();
  restage();
}

function closeFile() {
  shownDoc = null;
  reading(false);
  $('fileView').hidden = true;
  $('fileLib').hidden = false;
}
$('fileBack').addEventListener('click', showLibrary);
const sizeZh = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
$('docShare').addEventListener('change', async () => {
  try {
    shownDoc = await api(`/api/parent/files/${shownDoc.id}/share`, { kid: $('docShare').checked });
  } catch (err) {
    $('docShare').checked = !$('docShare').checked;
    if (err.message !== 'locked') say(`没改成：${err.message}`, { mood: 'worried' });
  }
});
$('docDelete').addEventListener('click', async () => {
  if (!confirm(`删除《${shownDoc.name || '这个文件'}》？删除以后伙伴就读不到它了。`)) return;
  try {
    await api(`/api/parent/files/${shownDoc.id}/delete`, {});
    showLibrary();
    reload();
    say('好的，删掉了。', { mood: 'happy' });
  } catch (err) {
    if (err.message !== 'locked') say(`没删成：${err.message}`, { mood: 'worried' });
  }
});
$('docReread').addEventListener('click', async () => {
  try {
    await api(`/api/parent/files/${shownDoc.id}/reread`, {});
    say('好，我再读一次，读完告诉你。', { mood: 'happy' });
  } catch (err) {
    if (err.message !== 'locked') say(`哎呀，${err.message}。`, { mood: 'worried' });
  }
});
// Ask about it: the question box opens with the document's name already in it (and the
// file stays open, so what she talks about can be lit on its page).
$('docAsk').addEventListener('click', () => {
  $('typeForm').hidden = false;
  $('typeText').value = `《${shownDoc && shownDoc.doc ? shownDoc.doc.title : (shownDoc && shownDoc.name) || '这个文件'}》里`;
  $('typeText').focus();
});

async function undo(e) {
  if (!confirm(`撤销「${e.text}」？`)) return;
  try {
    const s = await api(`/api/parent/undo/${e.id}`, {});
    mom = s;
    await reload();
    say('好的，已经改回去了。', { mood: 'happy' });
  } catch (err) {
    say(`没撤销成：${err.message}`, { mood: 'worried' });
  }
}

async function reload() {
  try {
    const [kid, parent] = await Promise.all([api('/api/state'), api('/api/parent/state')]);
    render(kid, parent);
    await loadFeed();
  } catch (err) {
    if (err.message !== 'locked') console.warn(err);
  }
}

async function review(t, approve) {
  try {
    await api('/api/parent/review', { id: t.id, approve });
    await reload();
    const kid = app.state.profile.kidName;
    say(approve ? `好的，「${t.title}」确认啦，我去告诉${kid}！` : `好的，我会温柔地让${kid}把「${t.title}」再做一下。`, { mood: approve ? 'cheer' : 'happy' });
  } catch (err) {
    say(`没确认成：${err.message}`, { mood: 'worried' });
  }
}

// ---- talking with the companion ----------------------------------------------------

// The last few things said, Mom's and hers, in full.
const chatLog = [];
function addChat(who, text) {
  chatLog.push({ who, text });
  if (chatLog.length > 8) chatLog.shift();
  $('chatNone').hidden = true;
  $('chat').replaceChildren(...chatLog.map((m) => el('li', { class: m.who }, m.text)));
  $('chat').scrollTop = $('chat').scrollHeight;
}

// What she says while a slow answer is on its way: for something to do, or to look up.
const ON_IT = ['好的～', '好，马上办。'];
const LOOKING = ['好的，我看看～', '嗯，我查一下哦。', '好，我翻翻今天的记录。', '稍等，我看一下。'];
const asksToDo = (text) => /告诉|转告|跟她说|让她|提醒|加个|加一个|闹钟|定个|设个/.test(text);

async function send(text) {
  if (!text) return;
  addChat('me', text);
  stopSpeaking();
  setBusy(true, '想一想…');
  $('heard').hidden = false;
  $('heard').textContent = `你说：${text}`;
  if (view.id) markFrom(text); // about the page on show: found there while the answer comes
  let answered = false;
  const asked = api('/api/parent/chat', { text }).finally(() => (answered = true));
  // Looking through the day can take a few seconds. If it does, she says so first,
  // then goes back to thinking until the answer is in.
  await Promise.race([asked.catch(() => {}), sleep(1200)]);
  if (!answered) {
    await say(pick(asksToDo(text) ? ON_IT : LOOKING), { aside: true });
    if (!answered) setBusy(true, '查一查…');
  }
  try {
    const r = await asked;
    setBusy(false);
    if (r.actions && r.actions.length) reload();
    await say(r.reply, { mood: 'happy' });
  } catch (err) {
    setBusy(false);
    if (err.message !== 'locked') await say('哎呀，网络有点慢，您再说一次好吗？', { mood: 'worried' });
  }
}

// Look in on MoMo: the tablet takes a photo, the answer comes back as an event.
document.querySelector('.quick').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-check]');
  if (!b) return;
  try {
    const r = await api('/api/parent/check', { what: b.dataset.check });
    await say(r.text, { mood: r.ok ? 'happy' : 'worried' });
  } catch (err) {
    if (err.message !== 'locked') say(`没看成：${err.message}`, { mood: 'worried' });
  }
});

$('tellBtn').addEventListener('click', () => {
  $('tell').hidden = false;
  $('tellText').focus();
});
$('tellCancel').addEventListener('click', () => ($('tell').hidden = true));
$('tellForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('tellText').value.trim();
  if (!text) return;
  $('tell').hidden = true;
  $('tellText').value = '';
  try {
    const r = await api('/api/parent/tell', { text });
    const kid = app.state.profile.kidName;
    await say(r.quiet ? `好的，现在是安静时间，明早平板醒来我就告诉${kid}。` : r.tablets ? `好的，我这就告诉${kid}。` : `好的，平板现在没开，等${kid}打开我马上告诉她。`, { mood: 'happy' });
  } catch (err) {
    say(`没转告成：${err.message}`, { mood: 'worried' });
  }
});

// A photo or file: a timetable, the teacher's homework list, a page of homework.
$('photoBtn').addEventListener('click', () => $('photoInput').click());
$('photoInput').addEventListener('change', async () => {
  const file = $('photoInput').files[0];
  $('photoInput').value = '';
  if (!file) return;
  stopSpeaking();
  const reading = file.type.startsWith('image/') ? '看一看…' : '读一读…';
  setBusy(true, reading);
  try {
    const r = await sendFile(file, (k) => busyLabel(k < 1 ? `发送 ${Math.round(k * 100)}%` : reading));
    setBusy(false);
    reload();
    await say(r.line, { mood: r.kind === 'stored' || r.kind === 'failed' ? null : 'happy' });
  } catch (err) {
    setBusy(false);
    if (err.message !== 'locked') await say(`哎呀，${err.message}。`, { mood: 'worried' });
  }
});

// ---- live: the day's events, check-in results, MoMo's messages -------------------------

let queue = Promise.resolve();
let refreshTimer = 0;
let es = null;
// Open only while the page is in front. While it isn't, the server knows Mom isn't
// looking and sends MoMo's news to her phone instead (if a push service is set up).
function connectEvents() {
  if (es) return;
  es = new EventSource('/api/parent/events');
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.type === 'event' || ev.type === 'refresh') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(reload, 400); // several events in a row: one reload
      return;
    }
    queue = queue.then(() => handle(ev)).catch((err) => console.warn(err));
  };
}

function disconnectEvents() {
  if (!es) return;
  es.close();
  es = null;
}

async function handle(ev) {
  if (ev.type === 'check') {
    await reload();
    const e = ev.fileId && events.find((x) => x.fileId === ev.fileId);
    if (e) showPhoto(e);
    return say(ev.text, { mood: ev.ok ? (ev.posture && ev.posture.ok === false ? 'worried' : 'happy') : 'worried' });
  }
  if (ev.type === 'message') {
    reload();
    return say(ev.line, { mood: 'happy' });
  }
  // A file she has finished reading (it took a while), and the like.
  if (ev.type === 'say') {
    reload();
    return say(ev.line, { mood: ev.mood || null });
  }
}

// ---- login, start ----------------------------------------------------------------

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginMsg').textContent = '';
  try {
    const res = await fetch('/api/parent/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '登录失败');
    $('password').value = '';
    load();
  } catch (err) {
    $('loginMsg').textContent = err.message;
  }
});

$('startBtn').addEventListener('click', async () => {
  $('start').hidden = true;
  $('app').hidden = false;
  await wakeUp();
  connectEvents();
  if (app.state) render(app.state, mom);
  const kid = app.state ? app.state.profile.kidName : '孩子';
  const waiting = mom ? mom.today.filter((t) => t.status === 'waiting').length : 0;
  await say(waiting ? `妈妈好！${kid}有 ${waiting} 件事等您确认。想知道什么就问我。` : `妈妈好！想知道${kid}今天怎么样，就问我吧。`, { mood: 'happy' });
  for (const m of pendingUnread.splice(0)) await say(`${kid}让我告诉你：${m.text}`, { mood: 'happy' });
});

$('adminBtn').addEventListener('click', () => ($('admin').hidden = false));
$('adminClose').addEventListener('click', () => {
  $('admin').hidden = true;
  reload();
});
$('logout').addEventListener('click', async () => {
  await api('/api/parent/logout', {}).catch(() => {});
  location.reload();
});

initAdmin({ saved: (s) => (mom = s), openFile: showFile });

document.addEventListener('visibilitychange', () => {
  if (!app.started) return;
  if (document.visibilityState === 'visible') {
    connectEvents();
    reload();
  } else disconnectEvents();
});
setInterval(async () => {
  if (!app.started || document.hidden || !$('admin').hidden) return;
  try {
    const s = await api('/api/parent/state');
    mom = s;
    refreshAdmin(s);
    $('next').textContent = tabletLine(app.state, s);
  } catch {
    /* next time */
  }
}, 30000);

load();
