'use strict';
// The pairing code arrives in the URL fragment, so it never reaches server logs.
const code = location.hash.slice(1);
const msg = document.getElementById('msg');
if (!code) msg.textContent = '链接不完整，请让妈妈重新生成配对链接。';

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '配对中…';
  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name: document.getElementById('name').value }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    msg.textContent = '配对成功！';
    history.replaceState(null, '', '/pair');
    location.href = '/';
  } else {
    msg.textContent = data.error || '配对失败';
  }
});
