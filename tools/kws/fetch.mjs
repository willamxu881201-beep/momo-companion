// Puts the wake-word listener's parts into web/kws/ (语音唤醒; see web/kws/README.md):
//  - sherpa-onnx's own WebAssembly build, from npm (sherpa-onnx@2.0.1, Apache-2.0), with
//    three changes so that it runs in a browser too (it is built for Node);
//  - the keyword-spotting model, from ModelScope (zipformer, wenetspeech, 3.3M, int8;
//    Apache-2.0).
// Every file is checked against the checksum it had when this was written, so what is
// served is what was reviewed. Run from the repository: node tools/kws/fetch.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../web/kws');
const NPM = { url: 'https://registry.npmjs.org/sherpa-onnx/-/sherpa-onnx-2.0.1.tgz', sha512: 'MlcZOKglIO+U+PL635cWjLYVgW9PwGTAZ5vgGIWHchw7MC1bHyEy5428chj15K00EF5SF0jp3KgGOHUbiGj2/g==' };
const MODEL = 'https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/resolve/master';
const MODEL_FILES = {
  'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx': '017af32f2c0138f931d05fbc009ee864295e910aff304f77d2f563815fc834fb',
  'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx': 'fe53b8d6a07bc5373d1770649025a5a985c8fb3dab70323386a1b73aacba0546',
  'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx': '431de10b554f134ef8af320feea2db337e641290449a3d3f6cb6e5f5fd2c9c3d',
  'tokens.txt': '72316508d9119696145abc6f1f8cdc46287535c34e5ce7e595f845cb1499cf2e',
};

// The build is for Node: its file system is Node's, and it asks Node for path functions.
// In a browser it gets the in-memory file system instead (the model is written into it)
// and these path functions.
const BROWSER_PATH = `(()=>{var parts=(p,abs)=>{var out=[];for(var s of p.split("/")){if(!s||s===".")continue;if(s===".."){if(out.length&&out[out.length-1]!=="..")out.pop();else if(!abs)out.push("..")}else out.push(s)}return out};var normalize=p=>{var abs=p.charAt(0)==="/",trail=p.slice(-1)==="/";var r=parts(p,abs).join("/");if(!r&&!abs)r=".";if(r&&trail)r+="/";return(abs?"/":"")+r};var resolve=(...ps)=>{var r="";for(var i=ps.length-1;i>=0&&r.charAt(0)!=="/";i--){if(ps[i])r=ps[i]+"/"+r}return"/"+parts(r,true).join("/")};var relative=(from,to)=>{var f=resolve(from).split("/").filter(Boolean),t=resolve(to).split("/").filter(Boolean),i=0;while(i<f.length&&i<t.length&&f[i]===t[i])i++;return[...Array(f.length-i).fill(".."),...t.slice(i)].join("/")};var dirname=p=>{if(!p)return".";var e=p.length;while(e>1&&p.charAt(e-1)==="/")e--;var i=p.lastIndexOf("/",e-1);return i<0?".":i===0?"/":p.slice(0,i)};var basename=p=>{var e=p.length;while(e>1&&p.charAt(e-1)==="/")e--;return p.slice(p.lastIndexOf("/",e-1)+1,e)};return{isAbsolute:p=>p.charAt(0)==="/",normalize,dirname,basename,join:(...ps)=>normalize(ps.filter(Boolean).join("/")),posix:{resolve,relative}}})()`;
const PATCHES = [
  ['var nodePath=require("path");', `var nodePath=ENVIRONMENT_IS_NODE?require("path"):${BROWSER_PATH};`],
  ['if(!ENVIRONMENT_IS_NODE){throw new Error("NODERAWFS is currently only supported on Node.js environment.")}', ''],
  ['var VFS={...FS};for(var _key in NODERAWFS){FS[_key]=_wrapNodeError(NODERAWFS[_key])}', 'var VFS={...FS};if(ENVIRONMENT_IS_NODE){for(var _key in NODERAWFS){FS[_key]=_wrapNodeError(NODERAWFS[_key])}}'],
];

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const digest = (alg, buf, enc = 'hex') => createHash(alg).update(buf).digest(enc);

mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'kws-'));
try {
  const tgz = await get(NPM.url);
  if (digest('sha512', tgz, 'base64') !== NPM.sha512) throw new Error('the npm package is not the one reviewed');
  writeFileSync(join(tmp, 'p.tgz'), tgz);
  execFileSync('tar', ['-xzf', join(tmp, 'p.tgz'), '-C', tmp]);
  let glue = readFileSync(join(tmp, 'package/sherpa-onnx-wasm-nodejs.js'), 'utf8');
  for (const [from, to] of PATCHES) {
    if (glue.split(from).length !== 2) throw new Error(`not found once in the build: ${from.slice(0, 60)}`);
    glue = glue.replace(from, () => to);
  }
  writeFileSync(join(OUT, 'sherpa-onnx-wasm-nodejs.js'), `// sherpa-onnx 2.0.1 (Apache-2.0), changed to run in a browser too: see README.md.\n${glue}`);
  for (const f of ['sherpa-onnx-wasm-nodejs.wasm', 'sherpa-onnx-kws.js']) writeFileSync(join(OUT, f), readFileSync(join(tmp, 'package', f)));
  for (const [f, sha] of Object.entries(MODEL_FILES)) {
    const buf = await get(`${MODEL}/${f}`);
    if (digest('sha256', buf) !== sha) throw new Error(`${f} is not the one reviewed`);
    writeFileSync(join(OUT, f), buf);
  }
  console.log(`web/kws: sherpa-onnx 2.0.1 (changed for the browser) and the model, checked`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
