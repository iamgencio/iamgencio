import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config';

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const verifyHash = (p: string, h: string) => bcrypt.compare(p, h);
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomDigits = (n: number) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
export const randomCode = (n: number) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
};

export function hmac(payload: string | Buffer, secret = config.webhookSecret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const key = crypto.createHash('sha256').update(config.dataKey).digest();
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(blob: string): string {
  const raw = Buffer.from(blob, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export const luhnCheckDigit = (partial: string) => {
  let sum = 0;
  for (let i = partial.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = Number(partial[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
};
