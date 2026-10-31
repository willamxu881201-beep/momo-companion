# 语音唤醒：在平板上听伙伴的名字

沫沫的页面开着时，平板自己听有没有人喊伙伴的名字。这件事在平板上完成，听到名字之前，声音不会离开平板。听到名字后，这一句才像点了「按一下说话」一样发去识别，服务器还会核对确实叫了她的名字（`server/characters.js` 的 `callsHer`）。

用的是开源项目 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（新一代 Kaldi，Apache-2.0）的唤醒词识别。这个文件夹里的文件由 `node tools/kws/fetch.mjs` 生成，每个文件都要和写这个脚本时核对过的校验值一致。

| 文件 | 来源 |
|---|---|
| `sherpa-onnx-wasm-nodejs.wasm`、`sherpa-onnx-kws.js` | npm 上官方的 `sherpa-onnx@2.0.1` 包，原样未改 |
| `sherpa-onnx-wasm-nodejs.js` | 同一个包，改了三处，见下 |
| `encoder-…int8.onnx`、`decoder-…int8.onnx`、`joiner-…int8.onnx`、`tokens.txt` | 魔搭上的 `pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`（Apache-2.0）。模型用 WenetSpeech 训练，建模单元是拼音的声母和韵母，所以任何中文名字都能直接当唤醒词 |
| `worker.js` | 本项目的代码：在 Web Worker 里加载上面这些文件，听名字 |
| `LICENSE` | Apache License 2.0 全文 |

## 为了在浏览器里运行改的三处

npm 上的包是给 Node.js 编译的，`sherpa-onnx-wasm-nodejs.js` 里有三处在浏览器里会出错：

1. 路径函数从 Node 的 `path` 模块取。改成：在浏览器里用一份很小的 POSIX 路径实现。
2. 一开头检查不是 Node 就报错（`NODERAWFS is currently only supported on Node.js environment`）。去掉这个检查。
3. 文件系统换成直接读写本机磁盘（NODERAWFS）。改成只在 Node 里这样做。浏览器里用内存文件系统，`worker.js` 把模型写进去。

`.wasm` 文件本身没有改。

## 效果

用豆包配音念四个名字和一些别的句子测过：

- 灵敏度用默认的 0.25 时，单说名字、名字加问题、叫两遍、"嘿，云笈"都能识别。
- 不叫名字的句子里，只有"星星灯笼"会被当成"芯芯"：读音几乎一样。这种情况由服务器的核对挡下，识别出的文字开头不是她的名字就不回答。

孩子的声音和家里的环境声，要在真的平板上试。

在 Chromium 里，加载和准备好约需 1.8 秒（`tools/browser/run.sh wake`）。第一次要下载约 10 MB（程序压缩后 4.4 MB，模型 4.8 MB），之后浏览器缓存一周。
