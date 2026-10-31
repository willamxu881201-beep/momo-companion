// Speech in and out.
//  - Listening: the tablet records 16 kHz mono WAV. Doubao's flash recogniser
//    (openspeech) answers in a fraction of a second because it has an edge node
//    next to the server; when the speech app hasn't enabled it, we fall back to
//    Ark's multimodal model in Beijing, about 2 s for a few seconds of speech
//    (with BBR, see deploy/sysctl-momo.conf). Audio is never written to disk.
//  - Speaking: Doubao TTS 2.0 (openspeech, v3 unidirectional API), streamed to
//    the tablet as PCM while it is being made, so the voice starts about half a
//    second after the reply instead of when the whole line is done. If its
//    credentials are missing, the tablet falls back to the browser's voice.

import { randomUUID } from 'node:crypto';
import { arkChat } from './ark.js';
import { request, stream } from './client.js';

const ASR_PROMPT = '你是语音转写引擎。只输出音频里说话的原文，不回答、不解释、不评论、不翻译。听不清就输出空字符串。';
export const SPEECH_ORIGIN = 'https://openspeech.bytedance.com';
const TTS_URL = `${SPEECH_ORIGIN}/api/v3/tts/unidirectional`;
const FLASH_URL = `${SPEECH_ORIGIN}/api/v3/auc/bigmodel/recognize/flash`;

// Doubao's flash recogniser. Resolves the text ('' when there was no speech), or
// throws an error carrying the service's status `code` and the HTTP `status`.
// hotwords: names it would otherwise mishear (云笈 comes out as 云集 without).
export async function transcribeFlash({ appId, token, wav, hotwords = [] }) {
  const request = { model_name: 'bigmodel' };
  if (hotwords.length) request.corpus = { context: JSON.stringify({ hotwords: hotwords.map((word) => ({ word })) }) };
  const res = await request(FLASH_URL, {
    method: 'POST',
    timeoutMs: 15000,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Key': appId,
      'X-Api-Access-Key': token,
      'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
      'X-Api-Request-Id': randomUUID(),
      'X-Api-Sequence': '-1',
    },
    body: JSON.stringify({ user: { uid: 'momo-tablet' }, audio: { data: wav.toString('base64'), format: 'wav' }, request }),
  });
  return flashText(res);
}

// Reads the flash recogniser's answer. Its documented codes: 20000000 success,
// 20000003 silence, 45000002 empty audio, 4500xxxx bad request, 550xxxxx service
// trouble. 45000030, seen in practice, means the app hasn't been granted it.
export function flashText({ status, headers, body }) {
  const code = Number(headers['x-api-status-code']);
  if (code === 20000003 || code === 45000002) return '';
  if (code !== 20000000) {
    throw Object.assign(new Error(`flash ASR ${code || status}: ${String(headers['x-api-message'] || '').slice(0, 120)}`), { code, status });
  }
  let text = '';
  try {
    text = JSON.parse(body.toString('utf8')).result?.text || '';
  } catch {
    /* empty */
  }
  return cleanTranscript(text);
}

// names: words that may be said and should be written just so.
export async function transcribe({ apiKey, model, wavBase64, names = [] }) {
  const r = await arkChat({
    apiKey,
    model,
    maxTokens: 200,
    timeoutMs: 40000, // the upload to Beijing took up to 20 s before BBR; keep the margin
    messages: [
      { role: 'system', content: names.length ? `${ASR_PROMPT}可能说到的名字：${names.join('、')}。` : ASR_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } },
          { type: 'text', text: '转写' },
        ],
      },
    ],
  });
  return cleanTranscript(r.content);
}

// Loudness of a 16-bit PCM WAV (0..1 RMS). Used to skip near-silent clips:
// the model will happily "hear" a word in background noise.
export function wavRms(buf) {
  if (!buf || buf.length <= 44) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    sum += v * v;
    n += 1;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export function wavSeconds(buf, sampleRate = 16000) {
  return buf && buf.length > 44 ? (buf.length - 44) / 2 / sampleRate : 0;
}

export function cleanTranscript(s) {
  return String(s || '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/^(转写|原文)[:：]\s*/, '')
    .trim();
}

// The voice is raw 16-bit little-endian mono PCM at this rate, so the tablet can
// start playing the first piece while the rest is still being made.
export const PCM_RATE = 24000;

// Doubao TTS 2.0 streams a line as JSON lines, each carrying a base64 piece of audio.
// onAudio gets every piece as it arrives; the promise settles when the line is done.
// Throws when the service refuses or sends no audio at all.
export async function synthesizeStream({ appId, token, speaker, text, onAudio }) {
  const res = await stream(TTS_URL, {
    method: 'POST',
    timeoutMs: 20000,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Key': appId,
      'X-Api-Access-Key': token,
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'momo-tablet' },
      req_params: { text, speaker, audio_params: { format: 'pcm', sample_rate: PCM_RATE } },
    }),
  });
  res.setEncoding('utf8');
  if (res.statusCode >= 400) {
    let body = '';
    for await (const c of res) body += c;
    throw new Error(`TTS HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
  }
  let got = 0;
  const line = (l) => {
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      return; // blank or partial line
    }
    if (j.data) {
      const audio = Buffer.from(j.data, 'base64');
      got += audio.length;
      onAudio(audio);
    } else if (j.code && j.code !== 20000000) throw new Error(`TTS code ${j.code}: ${j.message || ''}`);
  };
  let rest = '';
  for await (const chunk of res) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    lines.forEach(line);
  }
  line(rest);
  if (!got) throw new Error('TTS sent no audio');
}

// One line of speech while it is being made: the audio so far, and a way to follow
// it. Whoever asks for the line, early or late, gets all of it from the start.
export class Clip {
  constructor() {
    this.chunks = [];
    this.done = false;
    this.waiting = [];
  }

  add(audio) {
    this.chunks.push(audio);
    this.wake();
  }

  end() {
    this.done = true;
    this.wake();
  }

  wake() {
    const waiting = this.waiting;
    this.waiting = [];
    waiting.forEach((resolve) => resolve());
  }

  next() {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  // Resolves once there is some audio, or the line is over without any.
  async started() {
    while (!this.chunks.length && !this.done) await this.next();
  }

  async *read() {
    for (let i = 0; ; ) {
      while (i < this.chunks.length) yield this.chunks[i++];
      if (this.done) return;
      await this.next();
    }
  }
}
