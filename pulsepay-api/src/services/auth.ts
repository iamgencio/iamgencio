import { Request } from 'express';
import { PoolClient } from 'pg';
import { config } from '../config';
import { one, pool, query } from '../db';
import { hashPassword, randomCode, randomDigits, randomToken, sha256, verifyHash } from '../lib/crypto';
import { AppError, unauthorized } from '../lib/errors';
import { signAccessToken } from '../http/auth';
import { sendEmail, sendSms } from './providers';

export type OtpPurpose = 'verify_email' | 'verify_phone' | 'reset_password';

export function publicUser(u: any) {
  return {
    id: u.id, email: u.email, phone: u.phone, first_name: u.first_name, last_name: u.last_name, paytag: u.paytag,
    role: u.role, status: u.status, kyc_tier: u.kyc_tier, email_verified: !!u.email_verified_at, phone_verified: !!u.phone_verified_at,
    has_pin: !!u.pin_hash, date_of_birth: u.date_of_birth, address: u.address, avatar_url: u.avatar_url,
    referral_code: u.referral_code, notification_prefs: u.notification_prefs, created_at: u.created_at,
  };
}

export async function issueOtp(userId: string | null, target: string, channel: 'email' | 'sms', purpose: OtpPurpose, db: Pick<PoolClient, 'query'> = pool) {
  const code = randomDigits(6);
  await db.query("UPDATE otps SET consumed_at=now() WHERE target=$1 AND purpose=$2 AND consumed_at IS NULL", [target, purpose]);
  await db.query(
    `INSERT INTO otps (user_id, target, channel, purpose, code_hash, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)`,
    [userId, target, channel, purpose, sha256(`${target}:${purpose}:${code}`), String(config.otpTtlSec)],
  );
  const msg = `Your PulsePay verification code is ${code}. It expires in ${config.otpTtlSec / 60} minutes. Never share it.`;
  if (channel === 'sms') await sendSms(target, msg); else await sendEmail(target, 'Your PulsePay code', msg);
  return config.exposeDevOtp ? code : undefined;
}

export async function consumeOtp(target: string, purpose: OtpPurpose, code: string) {
  const row = await one<any>(
    `SELECT * FROM otps WHERE target=$1 AND purpose=$2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [target, purpose],
  );
  if (!row || new Date(row.expires_at) < new Date()) throw new AppError(400, 'otp_expired', 'Code expired or not found. Request a new one.');
  if (row.attempts >= config.otpMaxAttempts) throw new AppError(429, 'otp_locked', 'Too many attempts. Request a new code.');
  if (row.code_hash !== sha256(`${target}:${purpose}:${code}`)) {
    await pool.query('UPDATE otps SET attempts = attempts + 1 WHERE id=$1', [row.id]);
    throw new AppError(400, 'otp_invalid', 'Invalid code');
  }
  await pool.query('UPDATE otps SET consumed_at=now() WHERE id=$1', [row.id]);
  return row;
}

export async function createSession(userId: string, role: string, req: Request, deviceName?: string) {
  const refresh = randomToken(48);
  const s = await one<any>(
    `INSERT INTO sessions (user_id, token_hash, device_name, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval) RETURNING id`,
    [userId, sha256(refresh), deviceName ?? null, req.headers['user-agent'] ?? null, req.ip ?? null, String(config.refreshTtlSec)],
  );
  return { access_token: signAccessToken(userId, s.id, role), refresh_token: refresh, token_type: 'Bearer', expires_in: config.accessTtlSec };
}

/** Rotating refresh tokens with reuse detection: replaying a rotated token revokes every session of the user. */
export async function rotateSession(refreshToken: string, req: Request) {
  const row = await one<any>(
    `SELECT s.*, u.role, u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1`, [sha256(refreshToken)],
  );
  if (!row) throw unauthorized('Invalid refresh token', 'refresh_invalid');
  if (row.revoked_at) {
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [row.user_id]);
    throw unauthorized('Refresh token reuse detected. All sessions revoked.', 'refresh_reuse');
  }
  if (new Date(row.expires_at) < new Date() || row.status !== 'active') throw unauthorized('Session expired', 'session_expired');
  const next = await createSession(row.user_id, row.role, req, row.device_name);
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [row.id]);
  return next;
}

export async function findUserByIdentifier(identifier: string) {
  const id = identifier.trim();
  const phone = /^[+\d][\d\s\-()]+$/.test(id) ? (await import('../lib/util')).normalizePhone(id) : null;
  return one<any>('SELECT * FROM users WHERE lower(email)=lower($1) OR phone=$2 OR lower(paytag)=lower($1)', [id, phone]);
}

export async function newReferralCode() {
  for (;;) {
    const code = randomCode(8);
    if (!(await one('SELECT 1 FROM users WHERE referral_code=$1', [code]))) return code;
  }
}

export async function setPassword(userId: string, password: string) {
  await pool.query('UPDATE users SET password_hash=$2, failed_login_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1', [userId, await hashPassword(password)]);
}

export async function checkPassword(userId: string, password: string) {
  const u = await one<any>('SELECT password_hash FROM users WHERE id=$1', [userId]);
  return !!u && (await verifyHash(password, u.password_hash));
}

export const listSessions = (userId: string) =>
  query('SELECT id, device_name, user_agent, ip, last_used_at, created_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC', [userId]);
