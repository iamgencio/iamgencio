import { PoolClient } from 'pg';
import { config } from '../config';
import { Db, one, query } from '../db';
import { randomDigits } from '../lib/crypto';
import { AppError, forbidden, notFound, unprocessable } from '../lib/errors';
import { newReference } from '../lib/util';

export interface Leg { walletId: string; direction: 'debit' | 'credit'; amount: number; label?: string }

export interface PostInput {
  type: string;
  category?: string;
  status?: 'pending' | 'success' | 'failed';
  reference?: string;
  externalReference?: string;
  narration?: string;
  currency: string;
  amount: number;
  fee?: number;
  senderWalletId?: string;
  receiverWalletId?: string;
  senderUserId?: string | null;
  receiverUserId?: string | null;
  counterparty?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  parentId?: string;
  legs: Leg[];
}

export class InsufficientFunds extends AppError {
  constructor() { super(422, 'insufficient_funds', 'Insufficient balance'); }
}

/**
 * Atomically posts a balanced set of ledger legs. Must run inside a DB transaction (`c`).
 * Wallets are locked in id order to avoid deadlocks; per-currency debits must equal credits.
 */
export async function postTransaction(c: PoolClient, input: PostInput) {
  const ids = [...new Set(input.legs.map((l) => l.walletId))].sort();
  const wallets = await query<any>('SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids], c);
  const byId = new Map(wallets.map((w) => [w.id, w]));
  if (byId.size !== ids.length) throw notFound('Wallet not found', 'wallet_not_found');

  const totals = new Map<string, number>();
  for (const l of input.legs) {
    if (!Number.isSafeInteger(l.amount) || l.amount <= 0) throw new Error('Invalid leg amount');
    const w = byId.get(l.walletId);
    const cur = w.currency as string;
    totals.set(cur, (totals.get(cur) ?? 0) + (l.direction === 'debit' ? l.amount : -l.amount));
    if (w.kind !== 'system' && w.status !== 'active') {
      throw forbidden(`Wallet ${w.account_number} is ${w.status}`, 'wallet_' + w.status);
    }
  }
  for (const [cur, net] of totals) if (net !== 0) throw new Error(`Unbalanced ledger posting in ${cur}: ${net}`);

  const completed = (input.status ?? 'success') !== 'pending';
  const txRow = await one<any>(
    `INSERT INTO transactions
      (reference, external_reference, type, category, status, currency, amount, fee, narration,
       sender_wallet_id, receiver_wallet_id, sender_user_id, receiver_user_id, counterparty, meta, parent_id, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, ${completed ? 'now()' : 'NULL'}) RETURNING *`,
    [
      input.reference ?? newReference(), input.externalReference ?? null, input.type, input.category ?? 'other',
      input.status ?? 'success', input.currency, input.amount, input.fee ?? 0, input.narration ?? null,
      input.senderWalletId ?? null, input.receiverWalletId ?? null, input.senderUserId ?? null, input.receiverUserId ?? null,
      input.counterparty ? JSON.stringify(input.counterparty) : null, JSON.stringify(input.meta ?? {}), input.parentId ?? null,
    ],
    c,
  );

  const balances = new Map(wallets.map((w) => [w.id, w.balance as number]));
  for (const l of input.legs) {
    const w = byId.get(l.walletId);
    const next = (balances.get(l.walletId) as number) + (l.direction === 'credit' ? l.amount : -l.amount);
    if (!w.allow_negative && next < 0) throw new InsufficientFunds();
    if (!Number.isSafeInteger(next)) throw unprocessable('Balance overflow');
    balances.set(l.walletId, next);
    await c.query(
      `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, currency, balance_after, label)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [txRow.id, l.walletId, l.direction, l.amount, w.currency, next, l.label ?? null],
    );
  }
  for (const [id, bal] of balances) {
    await c.query('UPDATE wallets SET balance=$2, updated_at=now() WHERE id=$1', [id, bal]);
  }
  return txRow as Transaction;
}

export interface Transaction {
  id: string; reference: string; type: string; category: string; status: string; currency: string;
  amount: number; fee: number; narration: string | null;
  sender_wallet_id: string | null; receiver_wallet_id: string | null;
  sender_user_id: string | null; receiver_user_id: string | null;
  counterparty: any; meta: any; parent_id: string | null; created_at: string; completed_at: string | null;
}

export async function newAccountNumber(db: Db): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const n = '90' + randomDigits(8);
    if (!(await one('SELECT 1 FROM wallets WHERE account_number=$1', [n], db))) return n;
  }
  throw new Error('Could not allocate account number');
}

export async function createWallet(
  db: Db,
  p: { userId: string; currency: string; kind?: 'main' | 'savings' | 'card'; name?: string },
) {
  const num = await newAccountNumber(db);
  return one<any>(
    `INSERT INTO wallets (user_id, kind, currency, name, account_number) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [p.userId, p.kind ?? 'main', p.currency, p.name ?? `${p.currency} wallet`, num],
    db,
  );
}

export type SystemWalletKind = 'SETTLEMENT' | 'FEES' | 'BILLS' | 'INTEREST' | 'CARDS' | 'ADJUSTMENTS' | 'FX';
export async function systemWallet(db: Db, kind: SystemWalletKind, currency: string) {
  const name = `${kind}_${currency}`;
  const existing = await one<any>("SELECT * FROM wallets WHERE kind='system' AND name=$1", [name], db);
  if (existing) return existing;
  const acct = `SYS-${kind}-${currency}`;
  await db.query(
    `INSERT INTO wallets (kind, currency, name, account_number, allow_negative) VALUES ('system',$1,$2,$3,true) ON CONFLICT (account_number) DO NOTHING`,
    [currency, name, acct],
  );
  return one<any>("SELECT * FROM wallets WHERE kind='system' AND name=$1", [name], db);
}

export async function userMainWallet(db: Db, userId: string, currency = config.baseCurrency) {
  const w = await one<any>("SELECT * FROM wallets WHERE user_id=$1 AND kind='main' AND currency=$2", [userId, currency], db);
  if (!w) throw notFound(`You have no ${currency} wallet`, 'wallet_not_found');
  return w;
}

export function toNgn(amount: number, currency: string): number {
  const rate = config.fxRatesToNgn[currency];
  return Math.round(amount * rate);
}

/** Moves `amount` of a transaction back: creates a mirror transaction and flags the original as reversed. */
export async function reverseTransaction(c: PoolClient, txId: string, reason: string, finalStatus: 'reversed' | 'failed' = 'reversed') {
  const orig = await one<any>('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [txId], c);
  if (!orig) throw notFound('Transaction not found');
  if (orig.status === 'reversed' || orig.status === 'failed') throw unprocessable('Transaction already reversed', 'already_reversed');
  const entries = await query<any>('SELECT * FROM ledger_entries WHERE transaction_id=$1 ORDER BY id', [txId], c);
  const legs: Leg[] = entries.map((e) => ({
    walletId: e.wallet_id, amount: e.amount, direction: e.direction === 'debit' ? 'credit' : 'debit', label: 'reversal',
  }));
  const rev = await postTransaction(c, {
    type: 'reversal', category: 'reversal', currency: orig.currency, amount: orig.amount, fee: 0,
    senderWalletId: orig.receiver_wallet_id ?? undefined, receiverWalletId: orig.sender_wallet_id ?? undefined,
    senderUserId: orig.receiver_user_id, receiverUserId: orig.sender_user_id,
    narration: `Reversal of ${orig.reference}: ${reason}`, parentId: orig.id, legs,
    meta: { reason, original_reference: orig.reference },
  });
  await c.query("UPDATE transactions SET status=$2, completed_at=now() WHERE id=$1", [txId, finalStatus]);
  return rev;
}
