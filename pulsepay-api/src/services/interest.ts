import { one, query, tx } from '../db';
import { postTransaction, systemWallet } from './ledger';
import { formatMoney, notify } from './notify';

/** Accrues one day of interest on every active savings pocket. Idempotent per pocket per calendar day. */
export async function accrueDailyInterest(day = new Date().toISOString().slice(0, 10)) {
  const pockets = await query<any>(
    `SELECT p.*, w.balance, w.currency FROM savings_pockets p JOIN wallets w ON w.id=p.wallet_id WHERE p.status='active' AND w.balance > 0 AND p.interest_rate_bps > 0`);
  let credited = 0, total = 0;
  for (const p of pockets) {
    const interest = Math.floor((p.balance * p.interest_rate_bps) / 10_000 / 365);
    if (interest <= 0) continue;
    const ref = `INT-${p.id}-${day}`;
    const done = await tx(async (c) => {
      if (await one('SELECT 1 FROM transactions WHERE external_reference=$1', [ref], c)) return false;
      const sys = await systemWallet(c, 'INTEREST', p.currency);
      await postTransaction(c, {
        type: 'interest', category: 'interest', currency: p.currency, amount: interest, externalReference: ref,
        narration: `Interest on ${p.name}`, senderWalletId: sys.id, receiverWalletId: p.wallet_id, receiverUserId: p.user_id,
        legs: [{ walletId: sys.id, direction: 'debit', amount: interest }, { walletId: p.wallet_id, direction: 'credit', amount: interest }],
      });
      await c.query('UPDATE savings_pockets SET interest_earned = interest_earned + $2 WHERE id=$1', [p.id, interest]);
      return true;
    });
    if (done) { credited++; total += interest; await notify(p.user_id, { type: 'transaction', title: 'Interest earned', body: `You earned ${formatMoney(interest, p.currency)} on ${p.name}.` }); }
  }
  return { day, pockets_credited: credited, total_interest: total };
}
