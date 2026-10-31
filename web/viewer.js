// A file's pages in the panel, on both pages: pictures the server draws (pages.js), one
// at a time, to look at and to point at. A touch on the page drops a ring there and asks
// the companion what it is; she answers, and the place she talks about lights up. Marks
// are boxes in thousandths of the page, so they stay put at any size: a homework page's
// problems are outlined with their numbers, and the one being talked about glows
// (markFrom: what was asked or said, found on the page).

import { $, api, app, say, setBusy, stopSpeaking } from './companion.js';

export const view = { id: null, page: 1, pages: 0, problems: [] }; // what is on show
let turning = 0;
let showing = 0; // the latest showPages: closing, or opening another, drops the one before

// Shows a file's pages, if it has any (a photo is one; a PDF or an Office file is
// drawn page by page). False when it is words only, or something to play or save.
export async function showPages(card) {
  clearView();
  const my = showing;
  for (const id of ['paperBox', 'paperZoom', 'pointHint', 'pager']) $(id).hidden = true; // until it is known
  let info = { pages: 0 };
  try {
    info = await api(`/api/files/${card.id}/pages`);
  } catch {
    /* no pages, then */
  }
  if (my !== showing) return false;
  const paged = info.pages > 0;
  for (const id of ['paperBox', 'paperZoom', 'pointHint']) $(id).hidden = !paged;
  $('pager').hidden = !(info.pages > 1);
  if (!paged) return false;
  Object.assign(view, { id: card.id, pages: info.pages, problems: info.problems || [] });
  $('pointHint').textContent = `点一下纸上的地方，问问${herName()}这是什么`;
  $('pointHint').classList.remove('said');
  await turnTo(1);
  return true;
}

const herName = () => {
  const s = app.state;
  return s && s.girls[s.profile.girl] ? s.girls[s.profile.girl].name : '伙伴';
};

// What she just said, under the page too, on a phone: there the page covers her bubble.
// (Held sideways, her bubble is beside it, and the page keeps the room.)
const wide = () => matchMedia('(orientation: landscape) and (min-width: 600px)').matches;
export function caption(line) {
  if (!view.id || !line || wide()) return;
  $('pointHint').textContent = `${herName()}：${line}`;
  $('pointHint').classList.add('said');
}

export function clearView() {
  showing += 1;
  Object.assign(view, { id: null, page: 1, pages: 0, problems: [] });
  $('marks').textContent = '';
  $('paperImg').removeAttribute('src');
  $('paperBox').classList.remove('zoomed');
  $('paperZoom').setAttribute('aria-pressed', 'false');
}

async function turnTo(n) {
  const my = ++turning;
  view.page = n;
  $('pageNo').textContent = `${n} / ${view.pages}`;
  $('pagePrev').disabled = n <= 1;
  $('pageNext').disabled = n >= view.pages;
  $('marks').textContent = '';
  const img = $('paperImg');
  img.src = `/api/files/${view.id}/pages/${n}`;
  await img.decode().catch(() => {});
  if (my !== turning) return;
  $('paperBox').scrollTo({ top: 0, left: 0 });
  if (n === 1) for (const p of view.problems) addMark(p.box, 'problem', String(p.n).replace(/[()（）.、]/g, ''));
}

function addMark(box, kind, label = '') {
  const [x1, y1, x2, y2] = box;
  const el = document.createElement('div');
  el.className = `mark ${kind}`;
  Object.assign(el.style, { left: `${x1 / 10}%`, top: `${y1 / 10}%`, width: `${(x2 - x1) / 10}%`, height: `${(y2 - y1) / 10}%` });
  if (label) el.appendChild(Object.assign(document.createElement('b'), { textContent: label }));
  $('marks').appendChild(el);
  return el;
}

// Lights up a place on the page on show, and brings it into sight.
export function mark(box) {
  if (!box || !view.id) return;
  $('marks').querySelectorAll('.mark.hot').forEach((m) => m.remove());
  addMark(box, 'hot').scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

// What was asked or said, marked on the page if it is about something there. quick:
// only what is known at once (a homework page's "第三题"), no looking.
export async function markFrom(text, { quick = false } = {}) {
  if (!view.id || !text) return;
  const { id, page } = view;
  try {
    const r = await api(`/api/files/${id}/find`, { page, text, quick });
    if (r.box && view.id === id && view.page === page) mark(r.box);
  } catch {
    /* nothing marked */
  }
}

const inside = (b, x, y) => x * 1000 >= b[0] && x * 1000 <= b[2] && y * 1000 >= b[1] && y * 1000 <= b[3];

// A touch on the page: what is there? The ring shows where; a problem touched is lit
// at once, and her answer says the rest.
$('paper').addEventListener('click', async (e) => {
  if (!view.id || app.busy || app.rec) return;
  const r = $('paper').getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  $('marks').querySelectorAll('.tap').forEach((t) => t.remove());
  const ring = Object.assign(document.createElement('div'), { className: 'tap' });
  Object.assign(ring.style, { left: `${x * 100}%`, top: `${y * 100}%` });
  $('marks').appendChild(ring);
  const touched = view.problems.find((p) => view.page === 1 && inside(p.box, x, y));
  if (touched) mark(touched.box);
  stopSpeaking();
  setBusy(true, '看一看…');
  const { id, page } = view;
  try {
    const a = await api(`/api/files/${id}/point`, { page, x, y });
    setBusy(false);
    ring.classList.add('done');
    if (a.box && view.id === id && view.page === page) mark(a.box);
    await say(a.reply, { mood: 'happy' });
    app.onPointed();
  } catch (err) {
    setBusy(false);
    ring.remove();
    if (err.message !== 'locked') say('这里我没看清，换个地方点点看？', { mood: 'worried' });
  }
});

$('pagePrev').addEventListener('click', () => view.page > 1 && turnTo(view.page - 1));
$('pageNext').addEventListener('click', () => view.page < view.pages && turnTo(view.page + 1));
$('paperZoom').addEventListener('click', () => {
  const on = $('paperBox').classList.toggle('zoomed');
  $('paperZoom').setAttribute('aria-pressed', String(on));
});
