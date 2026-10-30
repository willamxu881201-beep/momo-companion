import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { Family } from '../server/family.js';
import { Auth, KID_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { createHandler } from '../server/http.js';

const webDir = mkdtempSync(join(tmpdir(), 'momo-web-'));
mkdirSync(join(webDir, 'vid'));
writeFileSync(join(webDir, 'kid.html'), '<!doctype html><title>kid</title>');
const VIDEO = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
writeFileSync(join(webDir, 'vid', 'loop.mp4'), VIDEO);

let at = new Date('2026-10-28T08:05:00Z'); // 16:05 in Kuala Lumpur
const store = openDb(':memory:');
store.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 1 });
store.saveTemplate({ title: '写作业', time: '16:00', minutes: 40, days: 'school' });
const family = new Family(store, { clock: () => at });
const auth = new Auth(store, { parentPassword: 'test-password' });
const sent = [];
const hub = { size: 1, send: (e) => sent.push(e) };
const config = { publicUrl: '', parentPassword: 'test-password', limits: { chatPerDay: 80, asrPerDay: 150, ttsCharsPerDay: 20000 } };
const brain = { forget() {} }; // (the routes here don't talk)
const server = createServer(createHandler({ config, store, family, brain, auth, hub, webDir }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  rmSync(webDir, { recursive: true, force: true });
});

const get = (path, headers = {}) => fetch(base + path, { headers });
const bytes = async (res) => [...Buffer.from(await res.arrayBuffer())];

test('videos are served whole or by byte range, as Safari needs', async () => {
  const whole = await get('/vid/loop.mp4');
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.match(whole.headers.get('cache-control'), /max-age=\d+/);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), VIDEO);

  const probe = await get('/vid/loop.mp4', { Range: 'bytes=0-1' }); // Safari's first question
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('content-range'), 'bytes 0-1/100');
  assert.equal(probe.headers.get('content-length'), '2');
  assert.deepEqual(await bytes(probe), [0, 1]);

  const tail = await get('/vid/loop.mp4', { Range: 'bytes=95-' });
  assert.equal(tail.headers.get('content-range'), 'bytes 95-99/100');
  assert.deepEqual(await bytes(tail), [95, 96, 97, 98, 99]);

  const clamped = await get('/vid/loop.mp4', { Range: 'bytes=98-500' });
  assert.equal(clamped.headers.get('content-range'), 'bytes 98-99/100');
  assert.deepEqual(await bytes(clamped), [98, 99]);

  const suffix = await get('/vid/loop.mp4', { Range: 'bytes=-3' });
  assert.deepEqual(await bytes(suffix), [97, 98, 99]);

  const past = await get('/vid/loop.mp4', { Range: 'bytes=200-' });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), 'bytes */100');
  await past.arrayBuffer();
});

test('pages carry the CSP; paths outside web/ are not served', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /media-src 'self'/);
  await page.arrayBuffer();

  // fetch() would tidy the dots away, so send the raw path.
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/../package.json' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 404);
});

// Open the kid link the way a browser would and keep the cookie it sets.
async function openKidLink(key) {
  const res = await fetch(`${base}/?k=${encodeURIComponent(key)}`, { redirect: 'manual' });
  await res.arrayBuffer();
  const set = res.headers.get('set-cookie') || '';
  return { status: res.status, location: res.headers.get('location'), cookie: set.split(';')[0] };
}

test('the kid link opens the page on any device; a new link retires the old one', async () => {
  const first = await openKidLink(auth.kidKey());
  assert.equal(first.status, 302);
  assert.equal(first.location, '/');
  assert.match(first.cookie, new RegExp(`^${KID_COOKIE}=`));
  const second = await openKidLink(auth.kidKey()); // another tablet, same link
  assert.equal(second.cookie, first.cookie);
  assert.equal((await get('/api/state', { Cookie: first.cookie })).status, 200);

  const wrong = await openKidLink('not-the-key');
  assert.equal(wrong.status, 302);
  assert.equal(wrong.cookie, '');
  const none = await get('/api/state');
  assert.equal(none.status, 401);
  await none.arrayBuffer();

  auth.rotateKidKey();
  const old = await get('/api/state', { Cookie: first.cookie });
  assert.equal(old.status, 401);
  await old.arrayBuffer();
  const fresh = await openKidLink(auth.kidKey());
  assert.equal((await get('/api/state', { Cookie: fresh.cookie })).status, 200);
});

test("a kid page's screen and browser go to the server log, tidied", async () => {
  const { cookie: kid } = await openKidLink(auth.kidKey());
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  try {
    const res = await fetch(base + '/api/hello', {
      method: 'POST',
      headers: { Cookie: kid, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (HarmonyOS) ArkWeb/4.1.6.1' },
      body: JSON.stringify({ w: 961.4, h: 584, dpr: 'x', extra: 'ignored' }),
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  } finally {
    console.log = log;
  }
  assert.deepEqual(logged, ['[kid] screen 961.4x584 @0 Mozilla/5.0 (HarmonyOS) ArkWeb/4.1.6.1']);
  const stranger = await fetch(base + '/api/hello', { method: 'POST', body: '{}' });
  assert.equal(stranger.status, 401);
  await stranger.arrayBuffer();
});

test('the tablet is told when it is quiet time', async () => {
  const { cookie: kid } = await openKidLink(auth.kidKey());
  const headers = { Cookie: kid };
  at = new Date('2026-10-28T08:05:00Z'); // 16:05
  assert.equal((await (await get('/api/state', headers)).json()).quiet, false);
  at = new Date('2026-10-28T14:00:00Z'); // 22:00, after the default 21:30
  assert.equal((await (await get('/api/state', headers)).json()).quiet, true);
});

test("Mom's review is cheered on the tablet, but only refreshed at night", async () => {
  const { token } = auth.login('127.0.0.1', 'test-password');
  const headers = { Cookie: `${PARENT_COOKIE}=${token}`, 'Content-Type': 'application/json' };
  const review = (id, approve) => fetch(`${base}/api/parent/review`, { method: 'POST', headers, body: JSON.stringify({ id, approve }) });

  at = new Date('2026-10-28T08:20:00Z'); // 16:20, homework started at 16:00
  const task = family.tasks('2026-10-28')[0];
  family.markDone(task.id);
  sent.length = 0;
  let res = await review(task.id, true);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.deepEqual(sent, [{ type: 'reviewed', approve: true, title: '写作业', points: 15 }]);

  at = new Date('2026-10-28T14:00:00Z'); // 22:00
  sent.length = 0;
  res = await review(task.id, false);
  await res.arrayBuffer();
  assert.deepEqual(sent, [{ type: 'refresh' }]);
});

test('the tablet is told where she is; MoMo can start a task, and choose where free time is spent', async () => {
  const { cookie: kid } = await openKidLink(auth.kidKey());
  const headers = { Cookie: kid, 'Content-Type': 'application/json' };
  const state = async () => (await get('/api/state', headers)).json();
  const post = (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

  store.saveTemplate({ title: '练琴', time: '19:30', minutes: 20, days: 'every' });
  at = new Date('2026-10-28T10:00:00Z'); // 18:00: free time
  let s = await state();
  assert.equal(s.activity, null);
  assert.deepEqual(s.scene, { key: 'courtyard', night: false });

  const piano = s.tasks.find((t) => t.title === '练琴');
  const started = await (await post(`/api/tasks/${piano.id}/start`, {})).json();
  assert.equal(started.line, '好嘞，我们去琴房！练琴，开始～');
  assert.deepEqual(started.state.scene, { key: 'piano', night: false });
  assert.deepEqual([started.state.activity.title, started.state.activity.started], ['练琴', true]);

  at = new Date('2026-10-28T11:00:00Z'); // 19:00: the started task has run its time (its own is 19:30); free time, at night
  assert.equal((await (await post('/api/profile', { scene: 'sky' })).json()).state.profile.scene, 'sky');
  s = await state();
  assert.deepEqual(s.scene, { key: 'sky', night: true });
  assert.equal((await post('/api/profile', { scene: 'study' })).status, 400, 'free time is not spent in the study');
  at = new Date('2026-10-28T08:05:00Z');
});
