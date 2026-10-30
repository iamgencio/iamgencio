import { z } from 'zod';
import { one, pool, query, tx } from '../db';
import { AppError, notFound, unprocessable } from '../lib/errors';
import { amountSchema, offset, pageMeta, pageQuery, pinSchema } from '../lib/util';
import { created, paged, route } from '../http/registry';
import { BILL_CATEGORIES, BILL_PROVIDERS, payBill, validateCustomer } from '../services/providers';
import { authorizeSpend } from '../services/security';
import { checkOutgoingLimits } from '../services/limits';
import { postTransaction, reverseTransaction, systemWallet, userMainWallet } from '../services/ledger';
import { lockUser } from '../services/transfers';
import { formatMoney, notify } from '../services/notify';

const T = ['Bills'];
const provider = (code: string) => {
  const p = BILL_PROVIDERS.find((x) => x.code === code);
  if (!p) throw notFound('Unknown biller', 'provider_not_found');
  return p;
};

route({ method: 'get', path: '/bills/categories', tags: T, auth: 'user', summary: 'Bill categories', handler: () => BILL_CATEGORIES });
route({
  method: 'get', path: '/bills/providers', tags: T, auth: 'user', summary: 'Billers (optionally by category)',
  query: z.object({ category: z.enum(['airtime', 'data', 'electricity', 'tv', 'internet']).optional() }),
  handler: ({ query: q }) => BILL_PROVIDERS.filter((p) => !q.category || p.category === q.category).map(({ plans, ...p }) => ({ ...p, has_plans: !!plans })),
});
route({ method: 'get', path: '/bills/providers/:code/plans', tags: T, auth: 'user', summary: 'Plans/bundles of a biller',
  handler: ({ params }) => provider(params.code).plans ?? [] });

route({
  method: 'post', path: '/bills/validate', tags: T, auth: 'user', summary: 'Validate a meter number / smartcard / account',
  body: z.object({ provider_code: z.string(), customer_ref: z.string().min(6).max(20) }),
  handler: async ({ body }) => {
    const p = provider(body.provider_code);
    const r = await validateCustomer(p, body.customer_ref);
    if (!r) throw unprocessable('Customer not found', 'customer_not_found');
    return r;
  },
});

route({
  method: 'post', path: '/bills/pay', tags: T, auth: 'user', idempotent: true,
  summary: 'Pay a bill / buy airtime or data',
  description: 'For airtime & electricity send `amount`. For data/tv/internet send `plan_code` (amount comes from the plan). Sandbox: customer refs ending 0000 fail and are refunded.',
  body: z.object({
    provider_code: z.string(), customer_ref: z.string().regex(/^\+?\d{6,15}$/), plan_code: z.string().optional(),
    amount: amountSchema.optional(), pin: pinSchema,
  }),
  handler: async ({ body, user }) => {
    const p = provider(body.provider_code);
    let amount = body.amount;
    if (p.plans) {
      const plan = p.plans.find((x) => x.code === body.plan_code);
      if (!plan) throw unprocessable('A valid plan_code is required for this biller', 'plan_required');
      amount = plan.amount;
    }
    if (!amount) throw unprocessable('amount is required', 'amount_required');
    if (p.category === 'airtime' && (amount < 5_000 || amount > 5_000_000)) throw unprocessable('Airtime must be between 50 and 50,000', 'invalid_amount');
    if (p.category === 'electricity' && amount < 100_000) throw unprocessable('Minimum electricity purchase is 1,000', 'invalid_amount');
    await authorizeSpend(user, body.pin);
    let customerName: string | undefined;
    if (p.validate) {
      const v = await validateCustomer(p, body.customer_ref);
      if (!v) throw unprocessable('Customer not found', 'customer_not_found');
      customerName = v.customer_name;
    }

    // Phase 1: debit wallet, record pending bill
    const { t, bill } = await tx(async (c) => {
      await lockUser(c, user.id);
      const w = await userMainWallet(c, user.id, 'NGN');
      await checkOutgoingLimits(c, user.id, user.kycTier, 'NGN', amount!);
      const sys = await systemWallet(c, 'BILLS', 'NGN');
      const t = await postTransaction(c, {
        type: 'bill', category: p.category, status: 'pending', currency: 'NGN', amount: amount!,
        narration: `${p.name}${body.plan_code ? ' - ' + p.plans!.find((x) => x.code === body.plan_code)!.name : ''} for ${body.customer_ref}`,
        senderWalletId: w.id, receiverWalletId: sys.id, senderUserId: user.id,
        counterparty: { name: p.name, account_number: body.customer_ref },
        legs: [{ walletId: w.id, direction: 'debit', amount: amount! }, { walletId: sys.id, direction: 'credit', amount: amount! }],
      });
      const bill = await one<any>(
        `INSERT INTO bill_payments (user_id, transaction_id, category, provider_code, plan_code, customer_ref, customer_name, amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
        [user.id, t.id, p.category, p.code, body.plan_code ?? null, body.customer_ref, customerName ?? null, amount], c);
      return { t, bill };
    });

    // Phase 2: call biller, finalize
    let res;
    try { res = await payBill(p, body.customer_ref, amount); } catch { res = { status: 'pending' as const, reference: 'UNKNOWN' }; }
    const final = await tx(async (c) => {
      if (res.status === 'pending') return { ...t };
      if (res.status === 'success') {
        await c.query("UPDATE bill_payments SET status='success', token=$2, provider_reference=$3 WHERE id=$1", [bill.id, res.token ?? null, res.reference]);
        return one<any>("UPDATE transactions SET status='success', completed_at=now(), meta = meta || $2::jsonb WHERE id=$1 RETURNING *", [t.id, JSON.stringify({ provider_reference: res.reference, token: res.token })], c);
      }
      await reverseTransaction(c, t.id, res.message ?? 'Biller failed', 'failed');
      await c.query("UPDATE bill_payments SET status='failed', provider_reference=$2 WHERE id=$1", [bill.id, res.reference]);
      return one<any>('SELECT * FROM transactions WHERE id=$1', [t.id], c);
    });
    if (final.status === 'failed') {
      await notify(user.id, { type: 'transaction', title: 'Bill payment failed', body: `${p.name} purchase of ${formatMoney(amount, 'NGN')} failed and was refunded.`, data: { transaction_id: t.id } });
      throw new AppError(422, 'bill_failed', 'Payment failed. Your money has been refunded.', { transaction_id: t.id });
    }
    await notify(user.id, { type: 'transaction', title: 'Bill payment successful', body: `${p.name} ${formatMoney(amount, 'NGN')} for ${body.customer_ref}.${res.token ? ' Token: ' + res.token : ''}`, data: { transaction_id: t.id } });
    return created({ transaction: final, token: res.token ?? null, customer_name: customerName ?? null });
  },
});

route({
  method: 'get', path: '/bills/history', tags: T, auth: 'user', summary: 'My bill payments', query: pageQuery,
  handler: async ({ user, query: q }) => {
    const total = (await one<any>('SELECT count(*)::int n FROM bill_payments WHERE user_id=$1', [user.id]))!.n;
    const rows = await query('SELECT * FROM bill_payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, q.limit, offset(q)]);
    return paged(rows, pageMeta(q, total));
  },
});

export { pool };
