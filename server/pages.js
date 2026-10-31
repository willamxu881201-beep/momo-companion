// Pages of a file as pictures, to look at and to point at (the file viewer on both
// pages): a photo is its own one page; a PDF's pages are drawn by poppler (pdftoppm);
// Word, Excel, PowerPoint and the like go through LibreOffice to PDF first. A page is
// drawn the first time it is asked for and kept beside the file, and goes with it.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toPdf } from './extract.js';

const OFFICE = new Set(['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'rtf']);
const SIZE = 1500; // px, a page's longer side: small writing stays readable
export const MAX_PAGES = 300;

export class Pages {
  constructor(files, { run = execFile, convert = toPdf } = {}) {
    Object.assign(this, { files, run, convert });
    this.making = new Map(); // what is being drawn, so two asking at once wait for one
  }

  dir(id) {
    return join(this.files.root, 'pages', String(id));
  }

  // How a file can be looked at page by page: { kind: 'photo' | 'pages', n }, or null
  // (it is words only, or something to play or save).
  async count(f) {
    if (f.kind === 'photo') return { kind: 'photo', n: 1 };
    const type = f.result && f.result.type;
    if (type !== 'pdf' && !OFFICE.has(type)) return null;
    const pdf = await this.pdf(f);
    const info = await this.tool('pdfinfo', [pdf]);
    const n = Number((/^Pages:\s+(\d+)/m.exec(info) || [])[1]) || 0;
    return n ? { kind: 'pages', n: Math.min(n, MAX_PAGES) } : null;
  }

  // Page n (from 1) as a picture: its path on disk, and its type.
  async page(f, n) {
    if (f.kind === 'photo') return { path: this.files.pathOf(f), type: f.mime };
    const out = join(this.dir(f.id), `${n}.jpg`);
    if (!existsSync(out)) {
      const pdf = await this.pdf(f);
      await this.once(out, async () => {
        mkdirSync(this.dir(f.id), { recursive: true });
        const base = join(this.dir(f.id), `draw-${n}`);
        await this.tool('pdftoppm', ['-jpeg', '-jpegopt', 'quality=82', '-scale-to', String(SIZE), '-f', String(n), '-l', String(n), '-singlefile', pdf, base]);
        renameSync(`${base}.jpg`, out);
      });
    }
    return { path: out, type: 'image/jpeg' };
  }

  // The file as a PDF: itself, or made once by LibreOffice.
  async pdf(f) {
    if (f.result.type === 'pdf') return this.files.pathOf(f);
    const out = join(this.dir(f.id), 'doc.pdf');
    if (!existsSync(out)) {
      await this.once(out, async () => {
        const buf = await this.convert(readFileSync(this.files.pathOf(f)), f.result.type);
        mkdirSync(this.dir(f.id), { recursive: true });
        writeFileSync(`${out}.part`, buf);
        renameSync(`${out}.part`, out);
      });
    }
    return out;
  }

  // A file's drawn pages go with it.
  forget(id) {
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  once(key, make) {
    if (!this.making.has(key)) {
      const job = make().finally(() => this.making.delete(key));
      this.making.set(key, job);
    }
    return this.making.get(key);
  }

  tool(cmd, args) {
    return new Promise((resolve, reject) => {
      this.run(cmd, args, { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) reject(Object.assign(new Error(err.code === 'ENOENT' ? `${cmd} is not installed` : `${cmd}: ${String(err.message).split('\n')[0].slice(0, 160)}`), { missing: err.code === 'ENOENT' }));
        else resolve(String(stdout));
      });
    });
  }
}
