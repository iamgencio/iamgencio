import { config } from '../config';
import { one } from '../db';
import { hashPassword } from '../lib/crypto';
import { createWallet } from './ledger';
import { newReferralCode } from './auth';
import { pool } from '../db';

/** Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD if none exists. */
export async function ensureAdmin() {
  if (await one("SELECT 1 FROM users WHERE role='admin' LIMIT 1")) return;
  const u = await one<any>(
    `INSERT INTO users (email, phone, first_name, last_name, password_hash, role, kyc_tier, email_verified_at, phone_verified_at, referral_code)
     VALUES ($1,'+2340000000000','Platform','Admin',$2,'admin',3,now(),now(),$3) RETURNING *`,
    [config.adminEmail.toLowerCase(), await hashPassword(config.adminPassword), await newReferralCode()]);
  await createWallet(pool, { userId: u.id, currency: 'NGN' });
}
