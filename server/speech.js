// Speech in and out.
//  - Listening: the tablet records 16 kHz mono WAV. Doubao's flash recogniser
//    (openspeech) answers in a fraction of a second because it has an edge node
//    next to the server; when the speech app hasn't enabled it, we fall back to
//    Ark's multimodal model, which is much slower from here for longer clips.
//    Audio is never written to disk.
//  - Speaking: Doubao TTS 2.0 (openspeech, v3 unidirectional API). If its
//    credentials are missing, the tablet falls back to the browser's voice.

import { randomUUID } from 'node:crypto';
import { arkChat } from './ark.js';
import { request } from './client.js';

const ASR_PROMPT = '你是语音转写引擎。只输出音频里说话的原文，不回答、不解释、不评论、不翻译。听不清就输出空字符串。';
export const SPEECH_ORIGIN = 'https://openspeech.bytedance.com';
const TTS_URL = `${SPEECH_ORIGIN}/api/v3/tts/unidirectional`;
const FLASH_URL = `${SPEECH_ORIGIN}/api/v3/auc/bigmodel/recognize/flash`;

// Doubao's flash recogniser. Resolves the text, or throws an error whose `code`
// is the service's status code (45000030 means the app hasn't enabled it).
export async function transcribeFlash({ appId, token, wav }) {
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
    body: JSON.stringify({ user: { uid: 'momo-tablet' }, audio: { data: wav.toString('base64'), format: 'wav' }, request: { model_name: 'bigmodel' } }),
  });
  const code = Number(res.headers['x-api-status-code']);
  if (code !== 20000000) {
    throw Object.assign(new Error(`flash ASR ${code || res.status}: ${String(res.headers['x-api-message'] || '').slice(0, 120)}`), { code });
  }
  let text = '';
  try {
    text = JSON.parse(res.body.toString('utf8')).result?.text || '';
  } catch {
    /* empty */
  }
  return cleanTranscript(text);
}

export async function transcribe({ apiKey, model, wavBase64 }) {
  const r = await arkChat({
    apiKey,
    model,
    maxTokens: 200,
    timeoutMs: 40000, // a few seconds of audio can take 20 s to upload from here
    messages: [
      { role: 'system', content: ASR_PROMPT },
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

// Returns an MP3 buffer, or null when TTS isn't configured or fails.
export async function synthesize({ appId, token, speaker, text }) {
  if (!appId || !token || !text) return null;
  const res = await request(TTS_URL, {
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
      req_params: {
        text,
        speaker,
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    }),
  });
  const body = res.body.toString('utf8');
  if (res.status >= 400) throw new Error(`TTS HTTP ${res.status}: ${body.slice(0, 200)}`);
  // The reply is a stream of JSON lines, each carrying a base64 audio chunk.
  const chunks = [];
  for (const line of body.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      const j = JSON.parse(l);
      if (j.data) chunks.push(Buffer.from(j.data, 'base64'));
      else if (j.code && j.code !== 20000000 && j.code !== 0) throw new Error(`TTS code ${j.code}: ${j.message || ''}`);
    } catch (err) {
      if (err.message.startsWith('TTS code')) throw err;
    }
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}
