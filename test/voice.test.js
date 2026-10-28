import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { Family } from '../server/family.js';
import { Auth } from '../server/auth.js';
import { createHandler } from '../server/http.js';

const webDir = mkdtempSync(join(tmpdir(), 'momo-web-'));
writeFileSync(join(webDir, 'kid.html'), '<!doctype html><title>kid</title>');

const store = openDb(':memory:');
store.setSetting('cycle', { anchorDate: '2026-10-26', anchorDay: 1 });
const family = new Family(store, { clock: () => new Date('2026-10-28T08:05:00Z') });
const auth = new Auth(store, { parentPassword: 'test-password' });
const config = {
  publicUrl: '',
  parentPassword: 'test-password',
  ttsAppId: 'app',
  ttsToken: 'token',
  limits: { chatPerDay: 80, asrPerDay: 150, ttsCharsPerDay: 20000 },
};

// A stand-in for Doubao TTS: three pieces, 40 ms apart. '坏' is a line it can't voice.
const calls = [];
let finishedAt = 0;
async function tts({ text, onAudio }) {
  calls.push(text);
  if (text === '坏') throw new Error('TTS code 40000001: refused');
  for (const piece of [[1, 2, 3], [4, 5], [6]]) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    onAudio(Buffer.from(piece));
  }
  finishedAt = Date.now();
}
const brain = { reply: async () => ({ reply: '明天见', petAction: null, actions: [] }) };
const hub = { size: 0, send() {} };
const server = createServer(createHandler({ config, store, family, brain, auth, hub, webDir, tts }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  rmSync(webDir, { recursive: true, force: true });
});

const kidLink = await fetch(`${base}/?k=${auth.kidKey()}`, { redirect: 'manual' });
const headers = { Cookie: kidLink.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
const post = (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

// Reads a response body piece by piece, noting when the first piece came.
async function readAll(res) {
  const reader = res.body.getReader();
  const bytes = [];
  let firstAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstAt) firstAt = Date.now();
    bytes.push(...value);
  }
  return { bytes, firstAt };
}

test('the voice streams to the tablet while it is being made', async () => {
  const res = await post('/api/tts', { text: '你好' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-audio-format'), 'pcm_s16le;rate=24000');
  const { bytes, firstAt } = await readAll(res);
  assert.deepEqual(bytes, [1, 2, 3, 4, 5, 6]);
  assert.ok(firstAt < finishedAt, 'the first piece arrived before the line was finished');
  assert.equal(store.usage(family.now().date, 'tts'), 2);

  const again = await readAll(await post('/api/tts', { text: '你好' }));
  assert.deepEqual(again.bytes, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(calls, ['你好'], 'a repeat comes from memory');
});

test('two tablets asking at once share one synthesis', async () => {
  const [a, b] = await Promise.all([post('/api/tts', { text: '一起' }), post('/api/tts', { text: '一起' })]);
  assert.deepEqual((await readAll(a)).bytes, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual((await readAll(b)).bytes, [1, 2, 3, 4, 5, 6]);
  assert.equal(calls.filter((t) => t === '一起').length, 1);
});

test('the reply is voiced as soon as it exists, before the tablet asks', async () => {
  const chat = await post('/api/chat', { text: '明天见' });
  assert.equal((await chat.json()).reply, '明天见');
  assert.ok(calls.includes('明天见'), 'synthesis started with the reply');
  const { bytes } = await readAll(await post('/api/tts', { text: '明天见' }));
  assert.deepEqual(bytes, [1, 2, 3, 4, 5, 6]);
  assert.equal(calls.filter((t) => t === '明天见').length, 1);
});

test("a line the service can't voice gets 204, and is tried afresh next time", async () => {
  const log = console.error;
  console.error = () => {};
  try {
    const first = await post('/api/tts', { text: '坏' });
    assert.equal(first.status, 204);
    const second = await post('/api/tts', { text: '坏' });
    assert.equal(second.status, 204);
  } finally {
    console.error = log;
  }
  assert.equal(calls.filter((t) => t === '坏').length, 2);
});
