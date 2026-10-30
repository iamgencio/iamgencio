import { Db, one, pool } from '../db';
import { config } from '../config';
import { verifyHash } from '../lib/crypto';
import { AppError, forbidden, tooMany } from '../lib/errors';
import { AuthUser } from '../http/auth';

/** Verifies the 4-digit transaction PIN with attempt counting and temporary lock. */
export async function verifyPin(userId: string, pin: string) {
  const u = await one<any>('SELECT pin_hash, pin_attempts, pin_locked_until FROM users WHERE id=$1', [userId]);
  if (!u?.pin_hash) throw new AppError(403, 'pin_not_set', 'Set your transaction PIN first');
  if (u.pin_locked_until && new Date(u.pin_locked_until) > new Date()) {
    throw tooMany('PIN locked after too many attempts. Try again later.', 'pin_locked');
  }
  if (!(await verifyHash(pin, u.pin_hash))) {
    const attempts = u.pin_attempts + 1;
    const lock = attempts >= config.maxPinAttempts;
    await pool.query(
      `UPDATE users SET pin_attempts=$2, pin_locked_until=${lock ? `now() + interval '${config.pinLockMin} minutes'` : 'NULL'} WHERE id=$1`,
      [userId, lock ? 0 : attempts],
    );
    throw new AppError(403, 'invalid_pin', lock ? 'Invalid PIN. PIN is now locked.' : `Invalid PIN. ${config.maxPinAttempts - attempts} attempt(s) left.`);
  }
  if (u.pin_attempts) await pool.query('UPDATE users SET pin_attempts=0 WHERE id=$1', [userId]);
}

export function requireTier(user: AuthUser, tier: number, what = 'This action') {
  if (user.kycTier < tier) throw forbidden(`${what} requires KYC tier ${tier}`, 'kyc_tier_required');
}

export async function assertWalletOwner(db: Db, walletId: string, userId: string) {
  const w = await one<any>('SELECT * FROM wallets WHERE id=$1 AND user_id=$2', [walletId, userId], db);
  if (!w) throw new AppError(404, 'wallet_not_found', 'Wallet not found');
  return w;
}

/** Gate for every money-out action: phone verified + valid transaction PIN. */
export async function authorizeSpend(user: AuthUser, pin: string) {
  if (!user.phoneVerified) throw forbidden('Verify your phone number before sending money', 'phone_not_verified');
  await verifyPin(user.id, pin);
}
