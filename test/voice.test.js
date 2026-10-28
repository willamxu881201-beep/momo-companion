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
import { flashText } from '../server/speech.js';

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
// Stand-ins for the two recognisers. `flashSays` is what the flash one does next.
const heard = [];
let flashSays = { text: '明天上什么课？' };
async function flashAsr() {
  heard.push('flash');
  if (flashSays.code) throw Object.assign(new Error(`flash ASR ${flashSays.code}`), { code: flashSays.code, status: 200 });
  return flashSays.text;
}
async function arkAsr() {
  heard.push('ark');
  return '明天上什么课';
}
// The brain hands over its early answer before it has finished, as the real one does.
const brain = {
  async reply(key, text, { onEarly } = {}) {
    onEarly('明天见');
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { reply: '明天见', petAction: null, actions: [] };
  },
};
const hub = { size: 0, send() {} };
const server = createServer(createHandler({ config, store, family, brain, auth, hub, webDir, tts, flashAsr, arkAsr }));
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

test('the reply is voiced as soon as it exists, before the tablet asks, and only once', async () => {
  const chat = await post('/api/chat', { text: '明天见' });
  assert.equal((await chat.json()).reply, '明天见');
  assert.ok(calls.includes('明天见'), 'synthesis started from the early answer');
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

// One second of a clear tone, loud enough to be sent for recognition.
function toneWav() {
  const n = 16000;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n * 2, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 9000), 44 + i * 2);
  return wav.toString('base64');
}
const listen = async () => (await (await post('/api/asr', { wav: toneWav() })).json()).text;

test("the flash recogniser's answers are read as the docs describe", () => {
  const answer = (code, body = '') => ({ status: 200, headers: { 'x-api-status-code': String(code), 'x-api-message': 'msg' }, body: Buffer.from(body) });
  assert.equal(flashText(answer(20000000, JSON.stringify({ result: { text: '“明天上什么课？”' } }))), '明天上什么课？');
  assert.equal(flashText(answer(20000003)), '', 'silence is no words, not a failure');
  assert.equal(flashText(answer(45000002)), '', 'nor is empty audio');
  assert.throws(() => flashText(answer(45000030)), (err) => err.code === 45000030);
});

test('speech goes to the flash recogniser; when it is busy, that one clip goes to Ark', async () => {
  const log = console.warn;
  console.warn = () => {};
  try {
    heard.length = 0;
    assert.equal(await listen(), '明天上什么课？');
    assert.deepEqual(heard, ['flash']);

    flashSays = { code: 55000031 }; // server busy
    assert.equal(await listen(), '明天上什么课');
    flashSays = { text: '好的' };
    assert.equal(await listen(), '好的');
    assert.deepEqual(heard, ['flash', 'flash', 'ark', 'flash'], 'busy is not a reason to stop asking');
  } finally {
    console.warn = log;
  }
});

// Last in this file: it leaves the flash recogniser switched off for ten minutes.
test('when the flash recogniser is not granted, Ark takes over for a while', async () => {
  const log = console.warn;
  console.warn = () => {};
  try {
    heard.length = 0;
    flashSays = { code: 45000030 };
    assert.equal(await listen(), '明天上什么课');
    flashSays = { text: '好的' };
    assert.equal(await listen(), '明天上什么课');
    assert.deepEqual(heard, ['flash', 'ark', 'ark']);
  } finally {
    console.warn = log;
  }
});
