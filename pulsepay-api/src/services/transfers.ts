import { PoolClient } from 'pg';
import { config } from '../config';
import { one, pool, tx } from '../db';
import { AppError, forbidden, notFound, unprocessable } from '../lib/errors';
import { AuthUser } from '../http/auth';
import { postTransaction, reverseTransaction, systemWallet, userMainWallet } from './ledger';
import { bankTransferFee, checkOutgoingLimits, checkReceiveCap } from './limits';
import { formatMoney, notify } from './notify';
import { ProviderResult, resolveBankAccount, sendBankTransfer } from './providers';
import { normalizePhone } from '../lib/util';

export async function lockUser(c: PoolClient, userId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]); // serializes limit checks per user
}

export interface Recipient { account_number?: string; paytag?: string; phone?: string }

/** Resolves an internal recipient to their main wallet in `currency`. */
export async function resolveInternalWallet(c: PoolClient | undefined, r: Recipient, currency: string) {
  const db = c ?? pool;
  let w: any = null;
  if (r.account_number) {
    w = await one<any>(
      "SELECT w.*, u.status AS user_status, u.first_name, u.last_name FROM wallets w JOIN users u ON u.id=w.user_id WHERE w.account_number=$1 AND w.kind='main'",
      [r.account_number], db,
    );
    if (w && w.currency !== currency) throw unprocessable(`Recipient account is a ${w.currency} wallet`, 'currency_mismatch');
  } else {
    const u = r.paytag
      ? await one<any>('SELECT id FROM users WHERE lower(paytag)=lower($1)', [r.paytag.replace(/^@/, '')], db)
      : await one<any>('SELECT id FROM users WHERE phone=$1', [normalizePhone(r.phone!)], db);
    if (u) {
      w = await one<any>(
        "SELECT w.*, u.status AS user_status, u.first_name, u.last_name FROM wallets w JOIN users u ON u.id=w.user_id WHERE w.user_id=$1 AND w.kind='main' AND w.currency=$2",
        [u.id, currency], db,
      );
      if (!w) throw unprocessable(`Recipient has no ${currency} wallet`, 'recipient_no_wallet');
    }
  }
  if (!w || w.user_status !== 'active') throw notFound('Recipient not found', 'recipient_not_found');
  return w;
}

export async function executeInternalTransfer(p: {
  user: AuthUser; recipient: Recipient; currency: string; amount: number; narration?: string;
  type?: string; category?: string; meta?: Record<string, unknown>;
}) {
  const result = await tx(async (c) => {
    await lockUser(c, p.user.id);
    const sender = await userMainWallet(c, p.user.id, p.currency);
    const receiver = await resolveInternalWallet(c, p.recipient, p.currency);
    if (receiver.user_id === p.user.id) throw unprocessable('You cannot send money to yourself', 'self_transfer');
    await checkOutgoingLimits(c, p.user.id, p.user.kycTier, p.currency, p.amount);
    await checkReceiveCap(c, receiver.user_id, p.currency, p.amount);
    const t = await postTransaction(c, {
      type: p.type ?? 'transfer_internal', category: p.category ?? 'transfer', currency: p.currency, amount: p.amount,
      narration: p.narration, senderWalletId: sender.id, receiverWalletId: receiver.id,
      senderUserId: p.user.id, receiverUserId: receiver.user_id,
      counterparty: { name: `${receiver.first_name} ${receiver.last_name}`, account_number: receiver.account_number, bank_name: 'PulsePay' },
      meta: p.meta,
      legs: [
        { walletId: sender.id, direction: 'debit', amount: p.amount },
        { walletId: receiver.id, direction: 'credit', amount: p.amount },
      ],
    });
    return { t, receiver };
  });
  const money = formatMoney(p.amount, p.currency);
  await notify(p.user.id, { type: 'transaction', title: 'Transfer successful', body: `You sent ${money} to ${result.receiver.first_name} ${result.receiver.last_name}.`, data: { transaction_id: result.t.id } });
  await notify(result.receiver.user_id, { type: 'transaction', title: 'Money received', body: `${p.user.firstName} ${p.user.lastName} sent you ${money}.${p.narration ? ' "' + p.narration + '"' : ''}`, data: { transaction_id: result.t.id } });
  return result.t;
}

export async function executeBankTransfer(p: {
  user: AuthUser; bankCode: string; accountNumber: string; amount: number; narration?: string;
}) {
  if (config.baseCurrency !== 'NGN') throw new Error('unsupported');
  const dest = await resolveBankAccount(p.bankCode, p.accountNumber);
  if (!dest) throw unprocessable('Could not verify the destination account', 'account_not_found');
  const fee = bankTransferFee(p.amount);

  // Phase 1: reserve funds (ledger posting, status=pending)
  const t = await tx(async (c) => {
    await lockUser(c, p.user.id);
    const sender = await userMainWallet(c, p.user.id, 'NGN');
    await checkOutgoingLimits(c, p.user.id, p.user.kycTier, 'NGN', p.amount);
    const settlement = await systemWallet(c, 'SETTLEMENT', 'NGN');
    const fees = await systemWallet(c, 'FEES', 'NGN');
    return postTransaction(c, {
      type: 'transfer_bank', category: 'transfer', status: 'pending', currency: 'NGN', amount: p.amount, fee,
      narration: p.narration, senderWalletId: sender.id, receiverWalletId: settlement.id, senderUserId: p.user.id,
      counterparty: { name: dest.account_name, account_number: dest.account_number, bank_code: dest.bank_code, bank_name: dest.bank_name },
      legs: [
        { walletId: sender.id, direction: 'debit', amount: p.amount + fee },
        { walletId: settlement.id, direction: 'credit', amount: p.amount },
        { walletId: fees.id, direction: 'credit', amount: fee, label: 'transfer fee' },
      ],
    });
  });

  // Phase 2: call the bank rail outside the DB transaction, then finalize.
  let res: ProviderResult;
  try {
    res = await sendBankTransfer({ bankCode: p.bankCode, accountNumber: p.accountNumber, amount: p.amount, reference: t.reference });
  } catch {
    res = { status: 'pending', reference: 'UNKNOWN' }; // never reverse on timeouts; wait for the webhook / reconciliation
  }
  return finalizeBankTransfer(t.id, res);
}

/** Applies a provider outcome to a pending bank transfer. Safe to call repeatedly (webhooks may be redelivered). */
export async function finalizeBankTransfer(txId: string, res: ProviderResult) {
  const out = await tx(async (c) => {
    const t = await one<any>('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [txId], c);
    if (!t) throw notFound('Transaction not found');
    if (t.status !== 'pending') return t;
    if (res.status === 'pending') {
      await c.query("UPDATE transactions SET meta = meta || $2::jsonb WHERE id=$1", [txId, JSON.stringify({ provider_reference: res.reference })]);
      return { ...t, meta: { ...t.meta, provider_reference: res.reference } };
    }
    if (res.status === 'success') {
      return one<any>(
        "UPDATE transactions SET status='success', completed_at=now(), meta = meta || $2::jsonb WHERE id=$1 RETURNING *",
        [txId, JSON.stringify({ provider_reference: res.reference })], c,
      );
    }
    await reverseTransaction(c, txId, res.message ?? 'Transfer failed', 'failed');
    await c.query("UPDATE transactions SET meta = meta || $2::jsonb WHERE id=$1", [txId, JSON.stringify({ provider_reference: res.reference, failure_reason: res.message })]);
    return one<any>('SELECT * FROM transactions WHERE id=$1', [txId], c);
  });
  if (out.sender_user_id && out.status !== 'pending') {
    const ok = out.status === 'success';
    await notify(out.sender_user_id, {
      type: 'transaction', title: ok ? 'Transfer successful' : 'Transfer failed',
      body: ok ? `${formatMoney(out.amount, out.currency)} sent to ${out.counterparty?.name}.` : `Your transfer of ${formatMoney(out.amount, out.currency)} failed and was refunded.`,
      data: { transaction_id: out.id },
    });
  }
  return out;
}

export { forbidden, AppError };
