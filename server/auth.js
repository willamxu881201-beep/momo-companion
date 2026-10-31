// Two kinds of access:
//  - Mom: password login → session cookie (30 days).
//  - The kid page: one shared link with a random key, usable on any device.
//    Opening it sets a cookie so the key leaves the address bar. Mom can change
//    the key in the console, which cuts off every device on the old link.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PARENT_COOKIE = 'momo_parent';
export const KID_COOKIE = 'momo_kid';
const PARENT_TTL_MS = 30 * 86400000;
export const KID_TTL_S = 400 * 86400;

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

function sameHash(a, b) {
  return timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

export function passwordMatches(given, expected) {
  if (!expected) return false;
  return sameHash(given, expected);
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

  // ---- the kid link ----------------------------------------------------------

  kidKey() {
    const { key } = this.store.getSetting('kidLink');
    return key || this.rotateKidKey();
  }

  rotateKidKey() {
    const key = randomBytes(12).toString('base64url');
    this.store.setSetting('kidLink', { key });
    return key;
  }

  keyMatches(given) {
    return Boolean(given) && sameHash(given, this.kidKey());
  }

  // The cookie carries a hash of the key, so a new key retires every old cookie.
  kidCookieValue() {
    return sha256(`kid:${this.kidKey()}`);
  }

  isKid(cookies) {
    const t = cookies[KID_COOKIE];
    return Boolean(t) && sameHash(t, this.kidCookieValue());
  }
}
