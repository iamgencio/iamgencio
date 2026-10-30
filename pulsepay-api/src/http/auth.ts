import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { one } from '../db';
import { forbidden, unauthorized } from '../lib/errors';

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'support' | 'admin';
  kycTier: number;
  status: string;
  sessionId: string;
  firstName: string;
  lastName: string;
  hasPin: boolean;
  phoneVerified: boolean;
  emailVerified: boolean;
}

export function signAccessToken(userId: string, sessionId: string, role: string) {
  return jwt.sign({ sub: userId, sid: sessionId, role }, config.jwtSecret, { expiresIn: config.accessTtlSec, issuer: 'pulsepay' });
}

export async function authenticate(req: Request): Promise<AuthUser> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  let payload: any;
  try {
    payload = jwt.verify(h.slice(7), config.jwtSecret, { issuer: 'pulsepay' });
  } catch {
    throw unauthorized('Invalid or expired token', 'token_invalid');
  }
  const row = await one<any>(
    `SELECT u.id, u.email, u.role, u.kyc_tier, u.status, u.first_name, u.last_name, (u.pin_hash IS NOT NULL) AS has_pin, (u.phone_verified_at IS NOT NULL) AS phone_verified, (u.email_verified_at IS NOT NULL) AS email_verified,
            s.id AS sid, s.revoked_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND u.id = $2`,
    [payload.sid, payload.sub],
  );
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) throw unauthorized('Session expired', 'session_expired');
  if (row.status !== 'active') throw forbidden('Account is ' + row.status, 'account_' + row.status);
  return {
    id: row.id, email: row.email, role: row.role, kycTier: row.kyc_tier, status: row.status,
    sessionId: row.sid, firstName: row.first_name, lastName: row.last_name, hasPin: row.has_pin, phoneVerified: row.phone_verified, emailVerified: row.email_verified,
  };
}
