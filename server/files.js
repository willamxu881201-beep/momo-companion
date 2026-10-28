// Photos and files sent to the companion, and the tablet's check-in snapshots. Each is
// kept on disk under DATA_DIR/files for a week, so Mom can look at it, then deleted
// (see sweep, run by the scheduler). PDFs are read as page images, made with poppler's
// pdftoppm when it is installed (deploy/install.sh installs it).

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEEP_DAYS = 7;
export const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export class Files {
  constructor(store, dataDir) {
    this.store = store;
    this.root = join(dataDir, 'files');
  }

  save({ who, kind, mime, name = '', buf, days = KEEP_DAYS }) {
    const rel = `${new Date().toISOString().slice(0, 7)}/${randomBytes(9).toString('base64url')}.${MIME_EXT[mime] || 'bin'}`;
    const abs = join(this.root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf, { mode: 0o600 });
    return this.store.addFile({ who, kind, mime, name: String(name).slice(0, 80), path: rel, bytes: buf.length, expires: Date.now() + days * 86400000 });
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
