import { config } from '../config';
import { Db, one, query } from '../db';
import { forbidden, unprocessable } from '../lib/errors';
import { toNgn } from './ledger';

export const tierOf = (n: number) => config.tiers[n] ?? config.tiers[0];

/** KYC-tier based per-transaction and daily outgoing limits (NGN-equivalent). */
export async function checkOutgoingLimits(db: Db, userId: string, tier: number, currency: string, amount: number) {
  const t = tierOf(tier);
  const ngn = toNgn(amount, currency);
  if (ngn > t.single) {
    throw unprocessable(`Amount exceeds your ${t.name} single transaction limit. Upgrade your KYC tier.`, 'tier_single_limit_exceeded', { limit_ngn_minor: t.single });
  }
  const rows = await query<{ currency: string; total: string }>(
    `SELECT currency, SUM(amount)::bigint AS total FROM transactions
      WHERE sender_user_id=$1 AND (receiver_user_id IS NULL OR receiver_user_id <> $1)
        AND status IN ('success','pending') AND type NOT IN ('reversal','interest','adjustment')
        AND created_at >= date_trunc('day', now())
      GROUP BY currency`,
    [userId], db,
  );
  const spent = rows.reduce((s, r) => s + toNgn(Number(r.total), r.currency), 0);
  if (spent + ngn > t.daily) {
    throw unprocessable(`Daily limit for ${t.name} exceeded. Upgrade your KYC tier.`, 'tier_daily_limit_exceeded', { limit_ngn_minor: t.daily, used_ngn_minor: spent });
  }
}

export async function checkReceiveCap(db: Db, receiverUserId: string, currency: string, amount: number) {
  const u = await one<any>('SELECT kyc_tier FROM users WHERE id=$1', [receiverUserId], db);
  if (!u) return;
  const t = tierOf(u.kyc_tier);
  const rows = await query<{ currency: string; total: string }>(
    "SELECT currency, SUM(balance)::bigint AS total FROM wallets WHERE user_id=$1 AND kind='main' GROUP BY currency", [receiverUserId], db,
  );
  const held = rows.reduce((s, r) => s + toNgn(Number(r.total), r.currency), 0);
  if (held + toNgn(amount, currency) > t.maxBalance) {
    throw forbidden('Recipient cannot receive this amount (their account tier balance limit would be exceeded)', 'recipient_balance_cap');
  }
}

export function bankTransferFee(amount: number): number {
  return config.bankTransferFees.find((f) => amount <= f.upTo)!.fee;
}
