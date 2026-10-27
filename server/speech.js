// Speech in and out.
//  - Listening: the tablet records 16 kHz mono WAV and we transcribe it with
//    Ark's multimodal model (input_audio). Audio is never written to disk.
//  - Speaking: Doubao TTS 2.0 (openspeech, v3 unidirectional API). If its
//    credentials are missing, the tablet falls back to the browser's voice.

import { randomUUID } from 'node:crypto';
import { arkChat } from './ark.js';

const ASR_PROMPT = '你是语音转写引擎。只输出音频里说话的原文，不回答、不解释、不评论、不翻译。听不清就输出空字符串。';
const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export async function transcribe({ apiKey, model, wavBase64 }) {
  const r = await arkChat({
    apiKey,
    model,
    maxTokens: 200,
    timeoutMs: 20000,
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
  const res = await fetch(TTS_URL, {
    method: 'POST',
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
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${body.slice(0, 200)}`);
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
