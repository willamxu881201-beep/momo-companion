// Everything sent to the companion — photos, documents, any other file — and the
// tablet's check-in snapshots, on disk under DATA_DIR/files. What people send is kept
// until Mom deletes it (管理 → 文件), so the companion can read it again any time; the
// snapshots go after a week (see sweep, run by the scheduler). An upload is written to
// disk as it arrives, never held whole in memory. A PDF that is only pictures is read as
// page images, made with poppler's pdftoppm (deploy/install.sh installs it).

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Transform, pipeline } from 'node:stream';
import { FOREVER } from './db.js';

export const KEEP_DAYS = 7; // the tablet's check-in snapshots
export const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/rtf': 'rtf', 'text/plain': 'txt', 'text/csv': 'csv',
};

export class Files {
  constructor(store, dataDir) {
    this.store = store;
    this.root = join(dataDir, 'files');
  }

  // A new file's place on disk (relative to the files folder, and absolute).
  place(name, mime) {
    const ext = MIME_EXT[mime] || (/\.([a-z0-9]{1,8})$/i.exec(String(name)) || [])[1]?.toLowerCase() || 'bin';
    const rel = `${new Date().toISOString().slice(0, 7)}/${randomBytes(9).toString('base64url')}.${ext}`;
    const abs = join(this.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    return { rel, abs };
  }

  // Kept for good if a person sent it; the tablet's snapshots for KEEP_DAYS.
  expiry(who) {
    return who === 'kid' || who === 'mom' ? FOREVER : Date.now() + KEEP_DAYS * 86400000;
  }

  save({ who, kind, mime, name = '', buf, status = 'read' }) {
    const { rel, abs } = this.place(name, mime);
    writeFileSync(abs, buf, { mode: 0o600 });
    const id = this.store.addFile({ who, kind, mime, name: String(name).slice(0, 80), path: rel, bytes: buf.length, expires: this.expiry(who) });
    if (status !== 'read') this.store.setFileStatus(id, status);
    return id;
  }

  // An upload, written to disk as it arrives (at most `max` bytes). Resolves to the new
  // file's id once all of it is there; the file is 'reading' until someone reads it.
  receive(req, { who, name = '', mime = '', max }) {
    const { rel, abs } = this.place(name, mime);
    let bytes = 0;
    const count = new Transform({
      transform(chunk, enc, done) {
        bytes += chunk.length;
        done(bytes > max ? Object.assign(new Error(`文件太大了，最多 ${Math.round(max / 1048576)} MB`), { status: 413 }) : null, chunk);
      },
    });
    return new Promise((resolve, reject) => {
      pipeline(req, count, createWriteStream(abs, { mode: 0o600 }), (err) => {
        if (!err && !bytes) err = Object.assign(new Error('文件是空的'), { status: 400 });
        if (err) {
          rmSync(abs, { force: true });
          reject(err.status ? err : Object.assign(new Error('文件没传完，网络断了'), { status: 400 }));
          return;
        }
        const id = this.store.addFile({ who, kind: 'file', mime: mime || 'application/octet-stream', name: String(name).slice(0, 80), path: rel, bytes, expires: this.expiry(who) });
        this.store.setFileStatus(id, 'reading');
        resolve(id);
      });
    });
  }

  pathOf(file) {
    return join(this.root, file.path);
  }

  // The file to send back, a piece at a time.
  stream(file) {
    return createReadStream(this.pathOf(file));
  }

  read(id) {
    const file = this.store.getFile(id);
    if (!file) return null;
    try {
      return { file, buf: readFileSync(join(this.root, file.path)) };
    } catch {
      return null;
    }
  }

  // Deletes one file, now.
  remove(id) {
    const f = this.store.getFile(id);
    if (!f) return;
    try {
      unlinkSync(join(this.root, f.path));
    } catch {
      /* already gone */
    }
    this.store.deleteFile(id);
  }

  // Deletes what is past its keep-by date; returns how many went.
  sweep(now = Date.now()) {
    const old = this.store.expiredFiles(now);
    for (const f of old) {
      try {
        unlinkSync(join(this.root, f.path));
      } catch {
        /* already gone */
      }
      this.store.deleteFile(f.id);
    }
    return old.length;
  }
}

// The first pages of a PDF as JPEG images. Rejects when pdftoppm is missing or fails.
export function pdfPages(buf, { pages = 2, dpi = 110 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'momo-pdf-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(dir, 'in.pdf'), buf);
  return new Promise((resolve, reject) => {
    execFile('pdftoppm', ['-jpeg', '-r', String(dpi), '-f', '1', '-l', String(pages), join(dir, 'in.pdf'), join(dir, 'p')], { timeout: 30000 }, (err) => {
      if (err) {
        cleanup();
        reject(Object.assign(new Error(err.code === 'ENOENT' ? 'pdftoppm is not installed' : `pdftoppm failed: ${err.message}`), { missing: err.code === 'ENOENT' }));
        return;
      }
      const out = readdirSync(dir).filter((f) => f.startsWith('p') && f.endsWith('.jpg')).sort().map((f) => readFileSync(join(dir, f)));
      cleanup();
      resolve(out);
    });
  });
}
