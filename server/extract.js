// What a document says, as text: Word, Excel and PowerPoint files (.docx, .xlsx and
// .pptx are read here, straight from their zipped XML; the older .doc/.xls/.ppt, WPS's
// own files, OpenDocument files and RTF are first turned into those by LibreOffice),
// PDFs (poppler's pdftotext), e-books (EPUB), web pages, and any plain text or CSV
// (UTF-8, or the GBK a Chinese Windows saves), whatever its name. The text comes in parts —
// pages, sheets, slides — each starting with a line like 【第2页】, so an answer can
// say where something is. A document that is mostly pictures (a scan, screenshots
// pasted into Word) has little text: its pictures come back too, to be read as such.

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const MAX_TEXT = 400_000; // characters kept of one document
const MAX_PART = 40 * 1024 * 1024; // what one part of an Office file may unpack to
const MAX_ROWS = 5000; // rows read of one sheet

export const DOC_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  rtf: 'application/rtf',
  text: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  epub: 'application/epub+zip',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};
export const TYPE_ZH = {
  pdf: 'PDF', docx: 'Word', doc: 'Word', rtf: 'Word', odt: 'Word', xlsx: 'Excel', xls: 'Excel', ods: 'Excel', csv: 'Excel',
  pptx: 'PPT', ppt: 'PPT', odp: 'PPT', text: '文本', html: '网页', epub: '电子书',
};
export const PART_ZH = { pdf: '页', xlsx: '张表', xls: '张表', ods: '张表', pptx: '张幻灯片', ppt: '张幻灯片', odp: '张幻灯片', epub: '章' };

const BY_EXT = {
  pdf: 'pdf',
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
  pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', potx: 'pptx',
  doc: 'doc', dot: 'doc', wps: 'doc',
  xls: 'xls', xlt: 'xls', et: 'xls',
  ppt: 'ppt', pps: 'ppt', pot: 'ppt', dps: 'ppt',
  rtf: 'rtf',
  txt: 'text', text: 'text', md: 'text', markdown: 'text', log: 'text', json: 'text',
  csv: 'csv', tsv: 'csv',
  html: 'html', htm: 'html', xhtml: 'html', mht: 'html',
};
const BY_MIME = {
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/rtf': 'rtf', 'text/rtf': 'rtf', 'text/csv': 'csv', 'text/plain': 'text', 'text/markdown': 'text',
};

// What kind of file this is, from its first bytes (and its name, where those can't
// tell): { type, mime, zip? }; null for anything not read here. type: image, pdf,
// docx, xlsx, pptx, doc, xls, ppt, rtf, text or csv.
export function detect(buf, name = '', mime = '') {
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(String(name)) || [])[1]?.toLowerCase();
  const sig = (s, at = 0) => buf.length >= at + s.length && buf.toString('latin1', at, at + s.length) === s;
  if (sig('\xff\xd8\xff')) return { type: 'image', mime: 'image/jpeg' };
  if (sig('\x89PNG')) return { type: 'image', mime: 'image/png' };
  if (sig('RIFF') && sig('WEBP', 8)) return { type: 'image', mime: 'image/webp' };
  if (sig('GIF8')) return { type: 'image', mime: 'image/gif' };
  if (sig('BM') && buf.length > 54 && buf.readUInt32LE(2) === buf.length) return { type: 'image', mime: 'image/bmp' };
  if (sig('ftyp', 4) && /^(heic|heix|mif1|msf1)$/.test(buf.toString('latin1', 8, 12))) return { type: 'image', mime: 'image/heic' };
  if (sig('%PDF-')) return { type: 'pdf', mime: DOC_MIME.pdf };
  if (sig('PK\x03\x04')) {
    let zip;
    try {
      zip = unzip(buf);
    } catch {
      return null;
    }
    for (const [type, part] of [['docx', 'word/document.xml'], ['xlsx', 'xl/workbook.xml'], ['pptx', 'ppt/presentation.xml']]) {
      if (zip.has(part)) return { type, mime: DOC_MIME[type], zip };
    }
    // OpenDocument and EPUB say what they are in a "mimetype" part.
    const kind = zip.has('mimetype') ? String(zip.text('mimetype')).trim() : '';
    for (const type of ['odt', 'ods', 'odp', 'epub']) if (kind === DOC_MIME[type]) return { type, mime: DOC_MIME[type], zip };
    return null;
  }
  if (sig('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')) {
    // The old Office files (and WPS's) share one container; the streams in it say
    // which kind it is, and failing that, the name.
    const has = (stream) => buf.includes(Buffer.from(stream, 'utf16le'));
    const type = has('WordDocument') ? 'doc' : has('Workbook') || has('Book') ? 'xls' : has('PowerPoint Document') ? 'ppt' : BY_EXT[ext] || BY_MIME[mime];
    return ['doc', 'xls', 'ppt'].includes(type) ? { type, mime: DOC_MIME[type] } : null;
  }
  if (sig('{\\rtf')) return { type: 'rtf', mime: DOC_MIME.rtf };
  // Anything else that is text — whatever its name says — is read as text.
  if (!looksLikeText(buf)) return null;
  const head = decodeText(buf.subarray(0, 2048)).trimStart().toLowerCase();
  const type = BY_EXT[ext] === 'csv' || BY_MIME[mime] === 'csv' ? 'csv' : BY_EXT[ext] === 'html' || /^(<!doctype html|<html)/.test(head) ? 'html' : 'text';
  return { type, mime: DOC_MIME[type] };
}

// What a file that can't be read is, roughly, for saying so: 音频, 视频, 压缩包, or 文件.
export function roughly(buf, name = '', mime = '') {
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(String(name)) || [])[1]?.toLowerCase() || '';
  const sig = (s, at = 0) => buf.length >= at + s.length && buf.toString('latin1', at, at + s.length) === s;
  if (/^audio\//.test(mime) || /^(mp3|m4a|wav|aac|flac|ogg|amr|wma|opus)$/.test(ext) || sig('ID3') || sig('fLaC') || (sig('RIFF') && sig('WAVE', 8))) return '音频';
  if (/^video\//.test(mime) || /^(mp4|mov|avi|mkv|wmv|flv|webm|3gp|m4v)$/.test(ext) || sig('\x1aE\xdf\xa3') || sig('ftyp', 4)) return '视频';
  if (/^(zip|rar|7z|gz|tgz|tar|bz2|xz)$/.test(ext) || sig('PK\x03\x04') || sig('Rar!') || sig('7z\xbc\xaf') || sig('\x1f\x8b')) return '压缩包';
  if (/^image\//.test(mime)) return '图片';
  return '文件';
}

// The text of a document: { text, parts, pictures, cut }. parts: how many pages,
// sheets or slides. pictures: when there is hardly any text, the pictures in an
// Office file ({ mime, buf }, in document order). cut: it was too long to keep whole.
// run: child_process.execFile (a stand-in in tests).
export async function extract(buf, kind, { run = execFile } = {}) {
  let r;
  switch (kind.type) {
    case 'docx':
      r = docx(kind.zip || unzip(buf));
      break;
    case 'xlsx':
      r = xlsx(kind.zip || unzip(buf));
      break;
    case 'pptx':
      r = pptx(kind.zip || unzip(buf));
      break;
    case 'pdf':
      r = await pdfText(buf, run);
      break;
    case 'doc':
    case 'rtf':
      r = docx(unzip(await convert(run, buf, kind.type, 'docx')));
      break;
    case 'xls':
      r = xlsx(unzip(await convert(run, buf, 'xls', 'xlsx')));
      break;
    case 'ppt':
      r = pptx(unzip(await convert(run, buf, 'ppt', 'pptx')));
      break;
    case 'odt':
      r = docx(unzip(await convert(run, buf, 'odt', 'docx')));
      break;
    case 'ods':
      r = xlsx(unzip(await convert(run, buf, 'ods', 'xlsx')));
      break;
    case 'odp':
      r = pptx(unzip(await convert(run, buf, 'odp', 'pptx')));
      break;
    case 'epub':
      r = epub(kind.zip || unzip(buf));
      break;
    case 'html':
      r = { text: htmlText(decodeText(buf)) };
      break;
    case 'csv': {
      const text = decodeText(buf);
      r = { text: tableLines(delimited(text)).join('\n') };
      break;
    }
    case 'text':
      r = { text: decodeText(buf) };
      break;
    default:
      throw new Error(`no reader for ${kind.type}`);
  }
  let text = tidy(r.text);
  const cut = text.length > MAX_TEXT;
  if (cut) text = text.slice(0, MAX_TEXT);
  const pictures = r.zip && visible(text) < 60 ? pictures_(r.zip) : [];
  return { text, parts: r.parts || 1, pictures, cut };
}

// How much real text there is: no part labels, no spaces.
export const visible = (text) => String(text).replace(/【[^】\n]*】|\s/g, '').length;

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​﻿]/g, '')
    .replace(/[ \t　]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- plain text and tables ------------------------------------------------------

// UTF-8 (with or without a BOM), UTF-16 with a BOM, or else GB18030 (which covers the
// GBK a Chinese Windows writes).
export function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}

function looksLikeText(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return false;
  const text = decodeText(head);
  const odd = (text.match(/[\u0000-\u0008\u000e-\u001f�]/g) || []).length;
  return odd <= text.length * 0.01;
}

// CSV or tab-separated text as rows of cells; quoted cells may hold commas and line breaks.
function delimited(text) {
  const first = text.slice(0, text.indexOf('\n') + 1 || text.length);
  const sep = ['\t', ',', ';'].reduce((a, s) => (first.split(s).length > first.split(a).length ? s : a), ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= MAX_ROWS) break;
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.map((r) => r.map(cellOf));
}

const cellOf = (s) => {
  const t = String(s).trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? { t, n: Number(t) } : { t };
};

const round = (n) => (Number.isInteger(n) ? n : Number(n.toPrecision(12)));
const TOTALS = /^(合计|总计|小计|总分|总和|平均|均值|total|sum|average|avg)/i;

// A table as lines of text — cells split by " | ", trailing empty cells dropped, empty
// rows skipped — and, under it, figures for each column of numbers (the model is
// better at reading sums than at adding up).
function tableLines(rows) {
  const lines = [];
  for (const r of rows) {
    let end = r.length;
    while (end && !(r[end - 1] && r[end - 1].t)) end -= 1;
    if (end) lines.push(r.slice(0, end).map((c) => String((c && c.t) || '').replace(/\s*\n\s*/g, ' ')).join(' | '));
  }
  const body = rows.filter((r) => r.some((c) => c && c.t));
  const head = body[0] || [];
  const data = body.slice(1).filter((r) => !TOTALS.test(String((r[0] && r[0].t) || '').trim()));
  const stats = [];
  head.forEach((h, col) => {
    const name = String((h && h.t) || '').trim();
    if (!name || h.n !== undefined || data.length < 3) return;
    const vals = data.map((r) => ({ n: r[col] && r[col].n, label: String((r[0] && r[0].t) || '').trim() })).filter((v) => typeof v.n === 'number');
    if (vals.length < 3 || vals.length < data.length * 0.6) return;
    const sum = vals.reduce((a, v) => a + v.n, 0);
    const pick = (better) => vals.reduce((a, v) => (better(v.n, a.n) ? v : a));
    const tag = (v) => (col && v.label ? `（${v.label}）` : '');
    const [hi, lo] = [pick((x, y) => x > y), pick((x, y) => x < y)];
    if (hi.n === lo.n) return; // all the same (a 满分 column): nothing to tell
    stats.push(`${name}：${vals.length} 个，合计 ${round(sum)}，平均 ${round(Math.round((sum / vals.length) * 100) / 100)}，最高 ${hi.n}${tag(hi)}，最低 ${lo.n}${tag(lo)}`);
  });
  if (stats.length) lines.push(`（统计）${stats.slice(0, 12).join('；')}`);
  return lines;
}

// ---- the zipped Office files ------------------------------------------------------

// A zip file's parts, read on demand (only the stored and deflated kinds Office uses).
export function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const parts = new Map();
  let p = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0 && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n -= 1) {
    const len = buf.readUInt16LE(p + 28);
    parts.set(buf.toString('utf8', p + 46, p + 46 + len), {
      method: buf.readUInt16LE(p + 10),
      packed: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      at: buf.readUInt32LE(p + 42),
    });
    p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  const read = (name) => {
    const e = parts.get(name);
    if (!e || e.at + 30 > buf.length || buf.readUInt32LE(e.at) !== 0x04034b50) return null;
    const start = e.at + 30 + buf.readUInt16LE(e.at + 26) + buf.readUInt16LE(e.at + 28);
    const data = buf.subarray(start, start + e.packed);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_PART });
    throw new Error(`zip method ${e.method}`);
  };
  return {
    has: (name) => parts.has(name),
    names: () => [...parts.keys()],
    size: (name) => (parts.get(name) || {}).size || 0,
    read,
    text(name) {
      const b = read(name);
      if (!b) return null;
      return b[0] === 0xff && b[1] === 0xfe ? new TextDecoder('utf-16le').decode(b.subarray(2)) : b.toString('utf8');
    },
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

// Walks XML tag by tag: onTag(name, attributes, 'open' | 'close' | 'empty') and
// onText(text) for what is between tags. Enough for the XML inside Office files.
function walk(xml, onTag, onText) {
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<[!?][^>]*>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[2]) onTag(m[2], m[3], m[1] ? 'close' : m[4] ? 'empty' : 'open');
    else if (m[5] !== undefined) onText(m[5]);
    else if (m[6] !== undefined) onText(decode(m[6]));
  }
}

const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs || '');
  return m ? decode(m[1] ?? m[2]) : null;
};

// A part's relationships: id → { path of the part it points at, type }.
function rels(zip, part) {
  const dir = posix.dirname(part);
  const xml = zip.text(posix.join(dir, '_rels', `${posix.basename(part)}.rels`)) || '';
  const out = {};
  for (const m of xml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (!id || !target || attr(m[1], 'TargetMode') === 'External') continue;
    out[id] = { path: target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(dir, target)), type: attr(m[1], 'Type') || '' };
  }
  return out;
}

// The text of Word's XML (ns 'w') or a slide's (ns 'a'): a line per paragraph, a table
// as a line per row with its cells split by " | ". Text boxes come out as their own
// lines; the copies Office keeps for old readers (mc:Fallback) are skipped. Where Word
// last laid out a new page (w:lastRenderedPageBreak), a 【第N页】 line goes in.
function flow(xml, ns) {
  const [P, T, TBL, TR, TC] = ['p', 't', 'tbl', 'tr', 'tc'].map((t) => `${ns}:${t}`);
  const lines = [];
  const paras = []; // paragraphs being read; a text box's sit inside another's
  const cells = []; // open table cells, each a list of its lines
  const tables = []; // open tables, each a list of rows of cell texts
  let inText = false;
  let skip = 0;
  let pages = 1;
  let newPage = false;
  // A slide's lines are short, and LibreOffice indents them with tabs: trim those.
  const put = (s) => {
    const line = ns === 'a' ? s.trim() : s;
    if (cells.length) cells[cells.length - 1].push(line);
    else lines.push(line);
  };
  walk(
    xml,
    (name, attrs, kind) => {
      if (name === 'mc:Fallback') skip += kind === 'open' ? 1 : kind === 'close' ? -1 : 0;
      if (skip) return;
      if (name === T) inText = kind === 'open';
      else if (name === P) {
        if (kind === 'open') paras.push('');
        else {
          const text = kind === 'close' ? paras.pop() ?? '' : '';
          if (newPage && !cells.length) {
            pages += 1;
            lines.push({ page: pages });
            newPage = false;
          }
          put(text);
        }
      } else if (name === `${ns}:tab` && paras.length && kind !== 'close') paras[paras.length - 1] += '\t';
      else if ((name === `${ns}:br` || name === `${ns}:cr`) && paras.length && kind !== 'close') {
        if (attr(attrs, `${ns}:type`) !== 'page') paras[paras.length - 1] += '\n';
      } else if (name === 'w:lastRenderedPageBreak') newPage = true;
      else if (name === TBL) {
        if (kind === 'open') tables.push([]);
        else if (kind === 'close' && tables.length) {
          const rows = tables.pop().filter((r) => r.some(Boolean));
          for (const r of rows) put(r.join(' | ').replace(/( \| )+$/, ''));
        }
      } else if (name === TR && tables.length) {
        if (kind === 'open') tables[tables.length - 1].push([]);
      } else if (name === TC && tables.length) {
        if (kind === 'open') cells.push([]);
        else if (kind === 'close' && cells.length) {
          const row = tables[tables.length - 1].at(-1);
          const text = cells.pop().map((s) => s.trim()).filter(Boolean).join(' ').replace(/\s*\n\s*/g, ' ');
          if (row) row.push(text);
        } else if (kind === 'empty') tables[tables.length - 1].at(-1)?.push('');
      }
    },
    (text) => {
      if (inText && !skip && paras.length) paras[paras.length - 1] += text;
    },
  );
  const out = [];
  if (pages > 1) out.push('【第1页】');
  for (const l of lines) out.push(typeof l === 'string' ? l : `【第${l.page}页】`);
  return out;
}

function docx(zip) {
  return { text: flow(zip.text('word/document.xml') || '', 'w').join('\n'), zip };
}

function pptx(zip) {
  const pres = zip.text('ppt/presentation.xml') || '';
  const links = rels(zip, 'ppt/presentation.xml');
  const lines = [];
  let n = 0;
  for (const m of pres.matchAll(/<p:sldId\b([^>]*)>/g)) {
    const link = links[attr(m[1], 'r:id')];
    const xml = link && zip.text(link.path);
    if (!xml) continue;
    n += 1;
    lines.push(`【第${n}张幻灯片】`, ...flow(xml, 'a'));
    const notes = Object.values(rels(zip, link.path)).find((l) => /notesSlide$/.test(l.type));
    // (the slide number on the notes page is a field: a number, or LibreOffice's <number>)
    const said = notes ? flow(zip.text(notes.path) || '', 'a').filter((s) => s && !/^(\d+|<number>)$/.test(s)) : [];
    if (said.length) lines.push(`备注：${said.join(' ')}`);
  }
  return { text: lines.join('\n'), parts: n, zip };
}

// The formats a number can be shown in: built-in ids, then the file's own codes.
const BUILT_IN = { 9: 'percent', 10: 'percent', 14: 'date', 15: 'date', 16: 'date', 17: 'date', 18: 'time', 19: 'time', 20: 'time', 21: 'time', 22: 'datetime', 45: 'time', 46: 'time', 47: 'time' };
for (let id = 27; id <= 36; id += 1) BUILT_IN[id] = 'date'; // the Chinese and Japanese date formats
for (let id = 50; id <= 58; id += 1) BUILT_IN[id] = 'date';

function lookOf(code) {
  const c = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?![hms]+\])[^\]]*\]/gi, '').toLowerCase();
  const time = /[hs]/.test(c);
  if (/[yd]/.test(c)) return time ? 'datetime' : 'date';
  if (time) return 'time';
  return c.includes('%') ? 'percent' : null;
}

function numberStyles(xml) {
  if (!xml) return [];
  const own = {};
  for (const m of xml.matchAll(/<numFmt\b([^>]*)>/g)) own[attr(m[1], 'numFmtId')] = attr(m[1], 'formatCode') || '';
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!xfs) return [];
  return [...xfs[1].matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => {
    const id = attr(m[1], 'numFmtId') || '0';
    return id in own ? lookOf(own[id]) : BUILT_IN[id] || null;
  });
}

function sharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  let cur = null;
  let inText = false;
  let phonetic = 0;
  walk(
    xml,
    (name, attrs, kind) => {
      if (name === 'si') {
        if (kind === 'open') cur = '';
        else {
          out.push(kind === 'close' ? cur ?? '' : '');
          cur = null;
        }
      } else if (name === 'rPh') phonetic += kind === 'open' ? 1 : kind === 'close' ? -1 : 0;
      else if (name === 't') inText = kind === 'open';
    },
    (text) => {
      if (cur !== null && inText && !phonetic) cur += text;
    },
  );
  return out;
}

const unescapeX = (s) => s.replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
const columnOf = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || '');
  return m ? [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : null;
};

function excelDate(serial, look, date1904) {
  const iso = new Date(Date.UTC(1899, 11, 30) + Math.round((serial + (date1904 ? 1462 : 0)) * 86400000)).toISOString();
  if (look === 'time') return iso.slice(11, 16);
  return look === 'datetime' && serial % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

function sheetRows(xml, strings, looks, date1904) {
  const rows = [];
  let row = null;
  let cell = null;
  let into = null; // 'v' or 't': where the text being read goes
  let phonetic = 0;
  const finish = () => {
    if (!row || !cell) return;
    const col = columnOf(cell.ref) ?? row.length;
    while (row.length < col) row.push(null);
    row[col] = valueOf(cell);
    cell = null;
  };
  const valueOf = (c) => {
    const raw = unescapeX(c.raw);
    switch (c.type) {
      case 's':
        return { t: unescapeX(strings[Number(raw)] ?? '') };
      case 'inlineStr':
      case 'str':
      case 'e':
        return { t: raw };
      case 'b':
        return { t: raw === '1' ? 'TRUE' : 'FALSE' };
      case 'd':
        return { t: raw.replace(/T00:00(:00(\.0+)?)?Z?$/, '').replace('T', ' ') };
      default: {
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) return { t: raw };
        const look = looks[c.style];
        if (look === 'date' || look === 'datetime' || look === 'time') return { t: excelDate(n, look, date1904) };
        if (look === 'percent') return { t: `${round(n * 100)}%` };
        return { t: String(round(n)), n: round(n) };
      }
    }
  };
  walk(
    xml,
    (name, attrs, kind) => {
      if (name === 'row') {
        if (kind === 'open') row = [];
        else if (kind === 'close' && row) {
          if (rows.length < MAX_ROWS) rows.push(row);
          row = null;
        }
      } else if (name === 'c') {
        if (kind !== 'close') cell = { ref: attr(attrs, 'r'), type: attr(attrs, 't') || 'n', style: Number(attr(attrs, 's') || 0), raw: '' };
        if (kind !== 'open') finish();
      } else if (name === 'v') into = kind === 'open' ? 'v' : null;
      else if (name === 'rPh') phonetic += kind === 'open' ? 1 : kind === 'close' ? -1 : 0;
      else if (name === 't') into = kind === 'open' && !phonetic ? 't' : null;
    },
    (text) => {
      if (cell && into) cell.raw += text;
    },
  );
  return rows;
}

function xlsx(zip) {
  const book = zip.text('xl/workbook.xml') || '';
  const links = rels(zip, 'xl/workbook.xml');
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(book);
  const linked = (type) => Object.values(links).find((l) => l.type.endsWith(`/${type}`));
  const strings = sharedStrings(zip.text((linked('sharedStrings') || {}).path || 'xl/sharedStrings.xml'));
  const looks = numberStyles(zip.text((linked('styles') || {}).path || 'xl/styles.xml'));
  const lines = [];
  let n = 0;
  for (const m of book.matchAll(/<sheet\b([^>]*)>/g)) {
    if (/^(hidden|veryHidden)$/.test(attr(m[1], 'state') || '')) continue;
    const link = links[attr(m[1], 'r:id')];
    const xml = link && link.type.endsWith('/worksheet') && zip.text(link.path);
    if (!xml) continue;
    n += 1;
    lines.push(`【工作表：${attr(m[1], 'name') || n}】`, ...tableLines(sheetRows(xml, strings, looks, date1904)));
  }
  return { text: lines.join('\n'), parts: n, zip };
}

// A web page's words: no scripts, styles or tags; block ends become line breaks.
export function htmlText(html) {
  return decode(
    String(html)
      .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\| ?\n/g, '\n');
}

// An e-book: its chapters in reading order (the spine of its package file).
function epub(zip) {
  const container = zip.text('META-INF/container.xml') || '';
  const opf = (/full-path="([^"]+)"/.exec(container) || [])[1];
  const pkg = (opf && zip.text(opf)) || '';
  const dir = opf ? posix.dirname(opf) : '';
  const items = {};
  for (const m of pkg.matchAll(/<item\b([^>]*)>/g)) items[attr(m[1], 'id')] = attr(m[1], 'href');
  const order = [...pkg.matchAll(/<itemref\b([^>]*)>/g)].map((m) => items[attr(m[1], 'idref')]).filter(Boolean);
  const chapters = (order.length ? order : zip.names().filter((n) => /\.x?html?$/i.test(n)).sort())
    .map((href) => zip.text(order.length ? posix.normalize(posix.join(dir, decodeURIComponent(href))) : href))
    .filter(Boolean)
    .map((x) => htmlText(x).trim())
    .filter(Boolean);
  return { text: chapters.map((t, i) => `【第${i + 1}章】\n${t}`).join('\n'), parts: chapters.length, zip };
}

// The pictures inside an Office file, in the order they were put in.
function pictures_(zip) {
  const num = (s) => Number((/(\d+)\.\w+$/.exec(s) || [])[1] || 0);
  return zip
    .names()
    .filter((n) => /^(word|ppt|xl)\/media\/[^/]+\.(png|jpe?g)$/i.test(n) && zip.size(n) > 20_000 && zip.size(n) < 10_000_000)
    .sort((a, b) => num(a) - num(b))
    .slice(0, 8)
    .map((n) => ({ mime: /\.png$/i.test(n) ? 'image/png' : 'image/jpeg', buf: zip.read(n) }));
}

// ---- through other programs ---------------------------------------------------------

const FILE = '\0file';

// Runs a command-line reader on the file (FILE in args stands for its path); rejects
// with err.missing when the program isn't installed, err.locked when the file has a
// password.
function tool(run, cmd, args, buf) {
  const dir = mkdtempSync(join(tmpdir(), 'momo-doc-'));
  const path = join(dir, 'in');
  writeFileSync(path, buf);
  return new Promise((resolve, reject) => {
    run(cmd, args.map((a) => (a === FILE ? path : a)), { timeout: 60000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) {
        const why = String(stderr || err.message).trim().split('\n')[0].slice(0, 160);
        reject(Object.assign(new Error(err.code === 'ENOENT' ? `${cmd} is not installed` : `${cmd}: ${why}`), { missing: err.code === 'ENOENT', locked: /password|encrypt/i.test(why) }));
      } else resolve(Buffer.from(stdout).toString('utf8'));
    });
  });
}

async function pdfText(buf, run) {
  const pages = (await tool(run, 'pdftotext', ['-layout', '-enc', 'UTF-8', FILE, '-'], buf)).split('\f');
  while (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
  // -layout keeps a table's columns apart with runs of spaces; two are enough.
  return { text: pages.map((p, i) => `【第${i + 1}页】\n${p.replace(/[ \t]{3,}/g, '  ')}`).join('\n'), parts: pages.length };
}

// An old-format document turned into its new format by LibreOffice (deploy/install.sh
// installs it), one at a time: it takes a few seconds and a few hundred MB to run.
let converting = Promise.resolve();
function convert(run, buf, from, to) {
  const job = converting.then(() => convertNow(run, buf, from, to));
  converting = job.catch(() => {});
  return job;
}

function convertNow(run, buf, from, to) {
  const dir = mkdtempSync(join(tmpdir(), 'momo-lo-'));
  writeFileSync(join(dir, `in.${from}`), buf);
  const args = [`-env:UserInstallation=file://${join(dir, 'profile')}`, '--headless', '--norestore', '--nologo', '--convert-to', to, '--outdir', dir, join(dir, `in.${from}`)];
  return new Promise((resolve, reject) => {
    run('soffice', args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      let out = null;
      try {
        out = readFileSync(join(dir, `in.${to}`));
      } catch {
        /* nothing made */
      }
      rmSync(dir, { recursive: true, force: true });
      if (out) resolve(out);
      else if (err && err.code === 'ENOENT') reject(Object.assign(new Error('soffice is not installed'), { missing: true }));
      else reject(new Error(`LibreOffice could not convert it${err ? `: ${String(err.message).split('\n')[0].slice(0, 120)}` : ''}`));
    });
  });
}
