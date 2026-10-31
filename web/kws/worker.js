// 语音唤醒: listens for the companion's name, on the tablet, off the page's thread. The
// listener is sherpa-onnx's keyword spotter (its own WebAssembly build and model, see
// README.md here); what it hears never leaves this worker.
// In:  { type: 'start', keywords }  once (keywords: "y ún j í @云笈", a line per name)
//      { type: 'audio', rate, samples }  the microphone, a piece at a time
//      { type: 'keywords', keywords }  another name to listen for
//      { type: 'reset' }  forget what was heard so far
// Out: { type: 'ready', ms }, { type: 'wake', keyword }, { type: 'error', message }
/* global Module, createKws */
importScripts('sherpa-onnx-wasm-nodejs.js', 'sherpa-onnx-kws.js');

const MODEL = {
  encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  tokens: 'tokens.txt',
};
const THRESHOLD = 0.25; // tried on the companions' own voices: every name, and nothing else but "星星" for 芯芯

let wasm = null;
let kws = null;
let stream = null;

async function load() {
  wasm = await Module({ locateFile: (f) => f, print: () => {}, printErr: () => {} });
  for (const f of Object.values(MODEL)) {
    const res = await fetch(f);
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    wasm.FS.writeFile(`/${f}`, new Uint8Array(await res.arrayBuffer()));
  }
}

function listenFor(keywords) {
  if (stream) stream.free();
  if (kws) kws.free();
  kws = createKws(wasm, {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: `/${MODEL.encoder}`, decoder: `/${MODEL.decoder}`, joiner: `/${MODEL.joiner}` },
      tokens: `/${MODEL.tokens}`,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: 1.0,
    keywordsThreshold: THRESHOLD,
    keywords: '',
    keywordsBuf: keywords,
    keywordsBufSize: new TextEncoder().encode(keywords).length,
  });
  stream = kws.createStream();
}

let queue = Promise.resolve();
onmessage = ({ data }) => {
  queue = queue.then(() => handle(data)).catch((err) => postMessage({ type: 'error', message: String(err && err.message ? err.message : err) }));
};

async function handle(m) {
  if (m.type === 'start') {
    const t0 = performance.now();
    await load();
    listenFor(m.keywords);
    postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) });
  } else if (!kws) {
    /* not ready yet */
  } else if (m.type === 'audio') {
    stream.acceptWaveform(m.rate, m.samples);
    while (kws.isReady(stream)) {
      kws.decode(stream);
      const r = kws.getResult(stream);
      if (r.keyword) {
        kws.reset(stream);
        postMessage({ type: 'wake', keyword: r.keyword });
      }
    }
  } else if (m.type === 'keywords') {
    listenFor(m.keywords);
  } else if (m.type === 'reset') {
    stream.free();
    stream = kws.createStream();
  }
}
