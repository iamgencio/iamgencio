import { Db, one, pool } from '../db';

export async function raiseTier(userId: string, tier: number, db: Db = pool): Promise<number> {
  const u = await one<any>('UPDATE users SET kyc_tier=GREATEST(kyc_tier,$2), updated_at=now() WHERE id=$1 RETURNING kyc_tier', [userId, tier], db);
  return u.kyc_tier;
}
