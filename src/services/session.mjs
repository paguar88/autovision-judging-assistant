/**
 * Beta session - v1.0 §6, §27.
 *
 * One shared password. No accounts, no user database. Verification is server-side;
 * the password never reaches the browser. The session is a signed, expiring cookie
 * carrying no judge identity.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE = 'cja_session';
const TTL_MS = 8 * 60 * 60 * 1000;   // one judging day

function secret() {
  const s = process.env.SESSION_SECRET || process.env.BETA_PASSWORD;
  if (!s) throw new Error('BETA_PASSWORD (or SESSION_SECRET) is not configured.');
  // Derived, so the cookie signature never contains or reveals the password itself.
  return createHmac('sha256', 'cja-session-v1').update(s).digest();
}

const b64url = (b) => Buffer.from(b).toString('base64url');
const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function verifyPassword(supplied) {
  const expected = process.env.BETA_PASSWORD;
  if (!expected || typeof supplied !== 'string') return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(expected);
  // Compare hashes so length never leaks through the comparison.
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function issueSession() {
  const payload = b64url(JSON.stringify({ sid: randomBytes(9).toString('base64url'), exp: Date.now() + TTL_MS }));
  const token = `${payload}.${sign(payload)}`;
  const attrs = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (process.env.CONTEXT !== 'dev') attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSession() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** @returns {{valid:boolean, sid:string|null}} */
export function readSession(request) {
  const raw = request.headers.get('cookie') || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
  if (!match) return { valid: false, sid: null };
  const token = match.slice(COOKIE.length + 1);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return { valid: false, sid: null };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expect = sign(payload);
  if (sig.length !== expect.length) return { valid: false, sid: null };
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return { valid: false, sid: null };

  try {
    const { sid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!exp || Date.now() > exp) return { valid: false, sid: null };
    return { valid: true, sid };
  } catch {
    return { valid: false, sid: null };
  }
}

export const requireSession = (request) => readSession(request).valid;
