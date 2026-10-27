// Two kinds of access:
//  - Mom: password login → session cookie (30 days).
//  - The tablet: paired once from a short-lived link Mom creates → device
//    cookie (400 days). Only hashes of tokens are stored.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PARENT_COOKIE = 'momo_parent';
export const DEVICE_COOKIE = 'momo_device';
const PARENT_TTL_MS = 30 * 86400000;
const DEVICE_TTL_S = 400 * 86400;
const PAIR_TTL_MS = 15 * 60000;

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export function passwordMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(sha256(given), 'hex');
  const b = Buffer.from(sha256(expected), 'hex');
  return timingSafeEqual(a, b);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    maxAge !== undefined ? `Max-Age=${maxAge}` : null,
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export class Auth {
  constructor(store, { parentPassword }) {
    this.store = store;
    this.parentPassword = parentPassword;
    this.failures = new Map(); // ip -> [timestamps]
  }

  // Five wrong passwords in ten minutes locks that address out for a while.
  loginBlocked(ip) {
    const recent = (this.failures.get(ip) || []).filter((t) => Date.now() - t < 10 * 60000);
    this.failures.set(ip, recent);
    return recent.length >= 5;
  }

  login(ip, password) {
    if (this.loginBlocked(ip)) return { ok: false, reason: '尝试次数太多，请 10 分钟后再试' };
    if (!passwordMatches(password, this.parentPassword)) {
      this.failures.get(ip).push(Date.now());
      return { ok: false, reason: '密码不对' };
    }
    const token = newToken();
    this.store.addParentSession(sha256(token), Date.now() + PARENT_TTL_MS);
    return { ok: true, token, maxAge: PARENT_TTL_MS / 1000 };
  }

  isParent(cookies) {
    const t = cookies[PARENT_COOKIE];
    return Boolean(t) && this.store.hasParentSession(sha256(t));
  }

  logout(cookies) {
    const t = cookies[PARENT_COOKIE];
    if (t) this.store.removeParentSession(sha256(t));
  }

  createPairingCode() {
    const code = randomBytes(9).toString('base64url');
    this.store.addPairingCode(sha256(code), Date.now() + PAIR_TTL_MS);
    return code;
  }

  pair(code, name) {
    if (!code || !this.store.takePairingCode(sha256(code))) return { ok: false, reason: '配对链接无效或已过期，请让妈妈重新生成' };
    const token = newToken();
    this.store.addDevice(String(name || '平板').slice(0, 20), sha256(token));
    return { ok: true, token, maxAge: DEVICE_TTL_S };
  }

  device(cookies) {
    const t = cookies[DEVICE_COOKIE];
    return t ? this.store.findDevice(sha256(t)) : null;
  }
}
