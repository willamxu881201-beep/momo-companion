// 语音唤醒 (MoMo's page): call the companion by her name and she listens, no tap needed.
// Her name is listened for here on the tablet (kws/worker.js, sherpa-onnx's keyword
// spotter): nothing that is said leaves the tablet until her name is heard. Then what
// is said is recorded as after a tap on the mic, from two seconds back, so that "云笈，
// 明天上什么课" comes whole; the server checks that her name was really said.
// Not while she speaks (she would hear her own name), listens or thinks, nor while the
// camera is on or the page is out of sight.

import { $, app, audio, chirp, look, startListening } from './companion.js';

const PRE_MS = 2000; // sound kept from before her name was heard
const AFTER_MS = 600; // after she has spoken, a moment before listening for her name again

let w = null; // the listener: { worker, keywords, ready, stream, src, proc, ring, ringLen, resting, restedAt }

const resting = () => look.speaking || app.busy || app.rec || document.hidden || !$('camBox').hidden || !$('confirm').hidden;

// Listens for this name ({ name, tokens }: tokens as the model spells it, "y ún j í"),
// or switches to it. onReady(name) once it is listening.
export async function listenForName({ name, tokens }, onReady = () => {}) {
  const keywords = `${tokens} @${name}`;
  if (w) {
    if (w.keywords !== keywords) {
      w.keywords = keywords; // (a listener still waiting for the microphone starts with it)
      if (w.worker) w.worker.postMessage({ type: 'keywords', keywords });
      if (w.ready) onReady(name);
    }
    return;
  }
  const ctx = audio();
  if (!ctx || !window.Worker || !window.WebAssembly) return;
  const me = { keywords, ready: false, ring: [], ringLen: 0, resting: true, restedAt: 0, worker: null };
  w = me;
  // The microphone first: without one, the listener (20 MB) isn't even loaded.
  try {
    me.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch {
    if (w === me) w = null; // no microphone: tapping still works
    return;
  }
  if (w !== me) {
    me.stream.getTracks().forEach((t) => t.stop());
    return;
  }
  me.worker = new Worker('/kws/worker.js');
  me.worker.onmessage = ({ data }) => {
    if (w !== me) return;
    if (data.type === 'ready') {
      me.ready = true;
      console.log(`[wake] listening for her name (ready in ${data.ms} ms)`);
      onReady(name);
    } else if (data.type === 'wake') heard(me);
    else if (data.type === 'error') {
      console.warn('[wake]', data.message);
      stopListeningForName();
    }
  };
  me.worker.onerror = (e) => {
    console.warn('[wake] the listener failed:', e.message);
    if (w === me) stopListeningForName();
  };
  me.worker.postMessage({ type: 'start', keywords: me.keywords });
  me.src = ctx.createMediaStreamSource(me.stream);
  me.proc = ctx.createScriptProcessor(4096, 1, 1);
  me.proc.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    me.ring.push(d);
    me.ringLen += d.length;
    while (me.ring.length > 1 && me.ringLen - me.ring[0].length > (PRE_MS / 1000) * ctx.sampleRate) me.ringLen -= me.ring.shift().length;
    const now = performance.now();
    if (resting()) {
      me.resting = true;
      me.restedAt = now;
      return;
    }
    if (now - me.restedAt < AFTER_MS || !me.ready) return;
    if (me.resting) {
      me.resting = false;
      me.worker.postMessage({ type: 'reset' }); // from here on, what was said before doesn't count
    }
    const s = d.slice();
    me.worker.postMessage({ type: 'audio', rate: ctx.sampleRate, samples: s }, [s.buffer]);
  };
  me.src.connect(me.proc);
  me.proc.connect(ctx.destination);
}

// Her name: she listens to what is said, starting with the last two seconds.
function heard(me) {
  if (w !== me || resting() || !me.stream) return;
  const pre = me.ring;
  me.ring = [];
  me.ringLen = 0;
  me.resting = true;
  me.restedAt = performance.now();
  chirp();
  console.log('[wake] heard her name');
  startListening({ stream: me.stream, pre });
}

export function stopListeningForName() {
  if (!w) return;
  const me = w;
  w = null;
  if (me.worker) me.worker.terminate();
  if (me.proc) {
    me.proc.disconnect();
    me.src.disconnect();
  }
  if (!me.stream) return;
  if (app.rec && app.rec.stream === me.stream) app.rec.own = true; // she is listening through it: it stops when she is done
  else me.stream.getTracks().forEach((t) => t.stop());
}

export const listeningForName = () => Boolean(w && w.ready);
