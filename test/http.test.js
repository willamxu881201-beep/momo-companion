import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { Family } from '../server/family.js';
import { Auth, DEVICE_COOKIE, PARENT_COOKIE } from '../server/auth.js';
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
const server = createServer(createHandler({ config, store, family, brain: {}, auth, hub, webDir }));
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

test('the tablet is told when it is quiet time', async () => {
  const { token } = auth.pair(auth.createPairingCode(), 'test tablet');
  const headers = { Cookie: `${DEVICE_COOKIE}=${token}` };
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
