// Mom's settings, in the "管理" sheet on her page: timetable and holidays, daily tasks,
// companion and quiet hours, the kid link. renderAdmin(s) fills the forms from
// /api/parent/state; the forms save straight away and hand the new state to onSaved.

import { $, api } from './companion.js';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const REASON = { task: '完成任务', ontime: '按时完成', chat: '聊天', 'checkin-am': '早上打招呼', 'checkin-pm': '晚上打招呼' };
let S = null;
let onSaved = () => {};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}

async function act(path, body, msgEl) {
  try {
    const s = await api(path, body);
    if (s && s.cycle) {
      render(s);
      onSaved(s);
    }
    if (msgEl) msgEl.textContent = '已保存';
    return s;
  } catch (err) {
    if (msgEl) msgEl.textContent = err.message;
    else alertMsg(err.message);
    return null;
  }
}

function alertMsg(text) {
  const el = h('div', { class: 'card', role: 'alert' }, text);
  el.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;max-width:520px;margin:auto;z-index:20';
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

// ---- render -------------------------------------------------------------------

export function initAdmin({ saved = () => {} } = {}) {
  onSaved = saved;
}

export function renderAdmin(s) {
  render(s);
}

function render(s) {
  S = s;
  renderToday(s);
  renderTimetable(s);
  renderTemplates(s);
  renderCompanion(s);
  renderTablets(s);
}

function renderToday(s) {
  const a = s.affinity;
  const pet = s.pets[s.profile.pet];
  $('affinity').textContent = `${a.points} 点 · ${pet ? pet.name : ''}第 ${a.stage} 阶段` + (a.next ? `，再 ${a.next - a.points} 点进化` : '，已是最高阶段');
  $('ledger').replaceChildren(
    ...s.ledger.slice(0, 10).map((l) => h('li', {}, h('span', { class: 'grow' }, `${l.date} ${REASON[l.reason] || l.reason}`), `+${l.delta}`)),
  );
  const u = s.usage;
  $('usage').textContent = `沫沫对话 ${u.chat}/${u.limits.chatPerDay} 次 · 妈妈对话 ${u.momchat || 0}/${u.limits.momChatPerDay || '-'} 次 · 语音识别 ${u.asr}/${u.limits.asrPerDay} 次 · 配音 ${u.tts}/${u.limits.ttsCharsPerDay} 字 · 看照片 ${u.vision || 0}/${u.limits.visionPerDay || '-'} 次` + (s.push ? ` · 手机推送 ${u.notify || 0}/${u.limits.notifyPerDay} 条` : '');
}

function renderTimetable(s) {
  const c = s.cycle;
  $('anchorDate').value = c.anchorDate || s.now.date;
  $('cycleLength').value = c.cycleLength;
  $('anchorDay').replaceChildren(...Array.from({ length: c.cycleLength }, (_, i) => h('option', { value: i + 1, selected: c.anchorDay === i + 1 }, i + 1)));
  $('weekdays').replaceChildren(
    h('legend', {}, '上学的日子'),
    ...[1, 2, 3, 4, 5, 6, 0].map((d) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: d, checked: c.schoolWeekdays.includes(d) }), `周${WEEK[d]}`)),
  );

  $('days').replaceChildren(
    ...s.days.map((d) => {
      const sel = h('select', { 'aria-label': `${d.dateZh} 改成` },
        h('option', { value: '' }, '改成…'),
        h('option', { value: 'off' }, '放假'),
        ...Array.from({ length: c.cycleLength }, (_, i) => h('option', { value: i + 1 }, `D${i + 1}`)),
      );
      sel.addEventListener('change', () => sel.value && act('/api/parent/override', { date: d.date, value: sel.value }));
      return h('li', {},
        h('span', { class: 'grow' }, d.dateZh),
        h('span', { class: `pill ${d.override === 'off' ? 'off' : d.override ? 'set' : ''}` }, d.label + (d.override ? '（手动）' : '')),
        d.override ? h('button', { class: 'small secondary', type: 'button', onclick: () => act('/api/parent/override', { date: d.date, value: null }) }, '恢复') : sel,
      );
    }),
  );

  // Don't wipe what Mom is typing when the page refreshes after another save.
  if (!$('courses').querySelector('textarea.dirty')) {
    $('courses').replaceChildren(
      ...Array.from({ length: c.cycleLength }, (_, i) => {
        const day = i + 1;
        const ta = h('textarea', { 'aria-label': `D${day} 的课`, 'data-day': day, placeholder: '数学\n华文\n体育：穿运动鞋' });
        ta.value = (s.courses[day] || []).map((x) => (x.note ? `${x.name}：${x.note}` : x.name)).join('\n');
        ta.addEventListener('input', () => ta.classList.add('dirty'));
        return h('div', { class: 'day' }, h('b', {}, `D${day}`), ta);
      }),
    );
  }

  $('overrides').replaceChildren(
    ...s.overrides.map((o) => h('li', {},
      h('span', { class: 'grow' }, `${o.date} ${o.value === 'off' ? '放假' : 'D' + o.value}${o.note ? ' · ' + o.note : ''}`),
      h('button', { class: 'small secondary', type: 'button', onclick: () => act('/api/parent/override', { date: o.date, value: null }) }, '删除'),
    )),
  );
}

function renderTemplates(s) {
  const dayText = (d) => ({ school: '上学的日子', offday: '不上学的日子', every: '每天' }[d] || '周' + String(d).split(',').map((x) => WEEK[Number(x)]).join('、'));
  $('templates').replaceChildren(
    ...(s.templates.length
      ? s.templates.map((t) => h('li', {},
          h('span', { class: 'grow' }, `${t.icon || ''} ${t.title}`, h('br'), h('small', { class: 'hint' }, `${t.time || '不定时'} · ${t.minutes} 分钟 · ${dayText(t.days)}${t.active ? '' : ' · 已停用'}`)),
          h('button', { class: 'small secondary', type: 'button', onclick: () => editTemplate(t) }, '编辑'),
          h('button', { class: 'small no', type: 'button', onclick: () => act(`/api/parent/templates/${t.id}/delete`, {}) }, '删除'),
        ))
      : [h('li', { class: 'empty' }, '还没有任务')]),
  );
  if (!$('tplWeekdays').children.length) {
    $('tplWeekdays').append(h('legend', {}, '星期'), ...[1, 2, 3, 4, 5, 6, 0].map((d) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: d }), `周${WEEK[d]}`)));
  }
}

function editTemplate(t) {
  $('tplTitle').textContent = '编辑任务';
  $('tplId').value = t.id;
  $('tplIcon').value = t.icon;
  $('tplName').value = t.title;
  $('tplTime').value = t.time || '';
  $('tplMinutes').value = t.minutes;
  const custom = !['school', 'offday', 'every'].includes(t.days);
  $('tplDays').value = custom ? 'custom' : t.days;
  $('tplWeekdays').hidden = !custom;
  const picked = custom ? String(t.days).split(',') : [];
  $('tplWeekdays').querySelectorAll('input').forEach((i) => (i.checked = picked.includes(i.value)));
  $('tplActive').checked = !!t.active;
  $('tplCancel').hidden = false;
  $('tplForm').scrollIntoView({ behavior: 'smooth' });
}

function resetTemplateForm() {
  $('tplForm').reset();
  $('tplId').value = '';
  $('tplTitle').textContent = '新增每天的任务';
  $('tplWeekdays').hidden = true;
  $('tplCancel').hidden = true;
}

function renderCompanion(s) {
  $('kidName').value = s.profile.kidName;
  $('curGirl').replaceChildren(...Object.entries(s.girls).map(([k, g]) => h('option', { value: k, selected: k === s.profile.girl }, `${k.toUpperCase()} ${g.name}`)));
  $('curPet').replaceChildren(...Object.entries(s.pets).map(([k, p]) => h('option', { value: k, selected: k === s.profile.pet }, `${k} ${p.name}（${p.kind}）`)));
  $('hideGirls').replaceChildren(h('legend', {}, '不给沫沫选的少女'), ...Object.entries(s.girls).map(([k, g]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, checked: s.hidden.girls.includes(k) }), g.name)));
  $('hidePets').replaceChildren(h('legend', {}, '不给沫沫选的宠物'), ...Object.entries(s.pets).map(([k, p]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, checked: s.hidden.pets.includes(k) }), p.name)));
  $('quietStart').value = s.quiet.start;
  $('quietEnd').value = s.quiet.end;
  $('voices').replaceChildren(h('legend', {}, '配音音色（豆包语音 2.0 的音色 ID）'), ...Object.entries(s.girls).map(([k, g]) => h('label', {}, g.name, h('input', { value: s.voices[k], 'data-girl': k, spellcheck: 'false' }))));
  $('ttsNote').textContent = s.tts ? '豆包配音已开启。' : '服务器还没配置豆包语音的 AppID 和 Token，现在用平板自带的声音说话。';
}

function renderTablets(s) {
  $('kidUrl').value = `${location.origin}/?k=${s.kidKey}`;
  $('online').textContent = s.tablets
    ? `现在有 ${s.tablets} 台设备开着孩子页面`
    : '现在没有设备开着孩子页面（页面开着才能到点提醒）';
  const kid = s.profile.kidName || '孩子';
  $('pushNote').textContent = s.push
    ? `已开（${s.push}）：这个页面没打开时，${kid}的留言、看看${kid}的结果、${kid}做完的任务和发来的照片、文件会推送到手机。`
    : `还没开。想在这个页面没打开时也收到${kid}的留言，需要在服务器的 /etc/momo/momo.env 里填 NOTIFY_URL，再重启服务（填法见 README「手机推送」）。`;
  $('testPush').hidden = !s.push;
}

// ---- events -------------------------------------------------------------------

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  for (const x of $('tabs').querySelectorAll('button')) x.setAttribute('aria-selected', String(x === b));
  for (const t of document.querySelectorAll('#admin .tab')) t.hidden = t.id !== `tab-${b.dataset.tab}`;
});

$('cycleForm').addEventListener('submit', (e) => {
  e.preventDefault();
  act('/api/parent/cycle', {
    anchorDate: $('anchorDate').value,
    anchorDay: Number($('anchorDay').value),
    cycleLength: Number($('cycleLength').value),
    schoolWeekdays: [...$('weekdays').querySelectorAll('input:checked')].map((i) => Number(i.value)),
  });
});

$('saveCourses').addEventListener('click', async () => {
  const boxes = [...$('courses').querySelectorAll('textarea')];
  $('coursesMsg').textContent = '保存中…';
  try {
    let s = null;
    for (const ta of boxes) {
      const list = ta.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, ...rest] = l.split(/[：:]/);
        return { name: name.trim(), note: rest.join('：').trim() };
      });
      s = await api('/api/parent/courses', { day: Number(ta.dataset.day), list });
    }
    boxes.forEach((ta) => ta.classList.remove('dirty'));
    if (s) render(s);
    $('coursesMsg').textContent = '课表已保存';
  } catch (err) {
    $('coursesMsg').textContent = err.message;
  }
});

$('holidayForm').addEventListener('submit', (e) => {
  e.preventDefault();
  act('/api/parent/holidays', { from: $('holFrom').value, to: $('holTo').value, note: $('holNote').value });
});

$('tplDays').addEventListener('change', () => ($('tplWeekdays').hidden = $('tplDays').value !== 'custom'));
$('tplCancel').addEventListener('click', resetTemplateForm);
$('tplForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let days = $('tplDays').value;
  if (days === 'custom') {
    days = [...$('tplWeekdays').querySelectorAll('input:checked')].map((i) => i.value).join(',');
    if (!days) return alertMsg('请至少选一个星期');
  }
  const ok = await act('/api/parent/templates', {
    id: $('tplId').value ? Number($('tplId').value) : undefined,
    icon: $('tplIcon').value.trim(),
    title: $('tplName').value.trim(),
    time: $('tplTime').value || null,
    minutes: Number($('tplMinutes').value),
    days,
    active: $('tplActive').checked,
  });
  if (ok) resetTemplateForm();
});

$('companionForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const voices = {};
  $('voices').querySelectorAll('input').forEach((i) => (voices[i.dataset.girl] = i.value.trim()));
  act('/api/parent/settings', {
    profile: { kidName: $('kidName').value.trim(), girl: $('curGirl').value, pet: $('curPet').value },
    hidden: {
      girls: [...$('hideGirls').querySelectorAll('input:checked')].map((i) => i.value),
      pets: [...$('hidePets').querySelectorAll('input:checked')].map((i) => i.value),
    },
    quiet: { start: $('quietStart').value, end: $('quietEnd').value },
    voices,
  }, $('companionMsg'));
});

$('kidCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('kidUrl').value);
    $('kidCopy').textContent = '已复制';
  } catch {
    $('kidUrl').select();
  }
});
$('kidRotate').addEventListener('click', async () => {
  if (!confirm('换新链接后，旧链接马上失效，每台设备都要重新打开新链接。确定要换吗？')) return;
  const s = await act('/api/parent/kid-link', {});
  if (s) {
    $('kidCopy').textContent = '复制';
    $('kidMsg').textContent = '已换成新链接，请在平板上重新打开。';
  }
});

$('testReminder').addEventListener('click', async () => {
  try {
    const r = await api('/api/parent/test-reminder', {});
    $('testMsg').textContent = r.tablets ? '已发送，平板应该在说话了' : '没有平板在线，提醒没有送达';
  } catch (err) {
    $('testMsg').textContent = err.message;
  }
});

$('testPush').addEventListener('click', async () => {
  $('pushMsg').textContent = '发送中…';
  try {
    const r = await api('/api/parent/test-push', {});
    $('pushMsg').textContent = r.ok ? '已发出，看看手机收到没有' : `没发出去：${r.error}`;
  } catch (err) {
    $('pushMsg').textContent = err.message;
  }
});

// A refresh from outside (Mom's page polls) only touches the read-only parts, never a form.
export function refreshAdmin(s) {
  S = s;
  renderToday(s);
  renderTablets(s);
}
