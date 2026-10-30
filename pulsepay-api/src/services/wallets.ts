import { PoolClient } from 'pg';
import { one, tx } from '../db';
import { conflict, notFound } from '../lib/errors';
import { config } from '../config';
import { postTransaction, systemWallet } from './ledger';
import { formatMoney, notify } from './notify';

export function publicWallet(w: any) {
  return {
    id: w.id, kind: w.kind, currency: w.currency, name: w.name, account_number: w.account_number,
    balance: w.balance, status: w.status, created_at: w.created_at,
    ...(w.kind === 'main' ? { funding: { bank_name: 'PulsePay MFB', account_number: w.account_number, account_name: w.owner_name } } : {}),
  };
}

/** Credits an inbound bank deposit (from the PSP webhook or the sandbox simulator). Idempotent on `externalReference`. */
export async function creditDeposit(p: {
  accountNumber: string; amount: number; externalReference: string; senderName?: string; senderBank?: string; narration?: string;
}) {
  const existing = await one<any>('SELECT * FROM transactions WHERE external_reference=$1', [p.externalReference]);
  if (existing) return { transaction: existing, duplicate: true };

  try {
    const result = await tx(async (c: PoolClient) => {
      const w = await one<any>("SELECT * FROM wallets WHERE account_number=$1 AND kind='main'", [p.accountNumber], c);
      if (!w) throw notFound('No wallet for this account number', 'wallet_not_found');
      const settlement = await systemWallet(c, 'SETTLEMENT', w.currency);
      const t = await postTransaction(c, {
        type: 'deposit', category: 'deposit', currency: w.currency, amount: p.amount,
        externalReference: p.externalReference, narration: p.narration ?? 'Wallet funding',
        senderWalletId: settlement.id, receiverWalletId: w.id, receiverUserId: w.user_id,
        counterparty: { name: p.senderName ?? 'Bank transfer', bank_name: p.senderBank ?? null },
        legs: [
          { walletId: settlement.id, direction: 'debit', amount: p.amount },
          { walletId: w.id, direction: 'credit', amount: p.amount },
        ],
      });
      return { t, userId: w.user_id as string, currency: w.currency as string };
    });
    await notify(result.userId, {
      type: 'transaction', title: 'Money received',
      body: `${formatMoney(p.amount, result.currency)} credited from ${p.senderName ?? 'bank transfer'}.`,
      data: { transaction_id: result.t.id },
    });
    return { transaction: result.t, duplicate: false };
  } catch (e: any) {
    if (e?.code === '23505') { // lost a race on external_reference
      return { transaction: await one<any>('SELECT * FROM transactions WHERE external_reference=$1', [p.externalReference]), duplicate: true };
    }
    throw e;
  }
}

export function fxQuote(from: string, to: string, amount: number) {
  if (from === to) throw conflict('Currencies must differ', 'same_currency');
  const rf = config.fxRatesToNgn[from], rt = config.fxRatesToNgn[to];
  const mid = rf / rt;                                  // 1 `from` = mid `to`
  const rate = mid * (1 - config.fxSpreadBps / 10_000);  // customer rate after spread
  const received = Math.floor(amount * rate);
  return { from, to, amount, mid_rate: mid, rate, received, spread_bps: config.fxSpreadBps };
}
