import { z } from 'zod';
import { one, pool, query, tx } from '../db';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors';
import { amountSchema, currencySchema, offset, pageMeta, pageQuery, phoneSchema, pinSchema } from '../lib/util';
import { randomCode } from '../lib/crypto';
import { created, paged, route } from '../http/registry';
import { BANKS, resolveBankAccount } from '../services/providers';
import { authorizeSpend } from '../services/security';
import { bankTransferFee } from '../services/limits';
import { executeBankTransfer, executeInternalTransfer, resolveInternalWallet } from '../services/transfers';
import { config } from '../config';
import { formatMoney, notify } from '../services/notify';

const T = ['Transfers'];

const recipient = z.object({
  account_number: z.string().regex(/^\d{10}$/).optional(),
  paytag: z.string().min(3).max(21).optional(),
  phone: phoneSchema.optional(),
}).refine((r) => [r.account_number, r.paytag, r.phone].filter(Boolean).length === 1, 'Provide exactly one of account_number, paytag or phone');

route({ method: 'get', path: '/transfers/banks', tags: T, auth: 'user', summary: 'Supported destination banks', handler: () => BANKS });

route({
  method: 'get', path: '/transfers/fee', tags: T, auth: 'user', summary: 'Fee for a transfer',
  query: z.object({ amount: z.coerce.number().int().positive(), type: z.enum(['internal', 'bank']).default('bank') }),
  handler: ({ query: q }) => ({ amount: q.amount, fee: q.type === 'internal' ? 0 : bankTransferFee(q.amount), total: q.amount + (q.type === 'internal' ? 0 : bankTransferFee(q.amount)) }),
});

route({
  method: 'post', path: '/transfers/resolve', tags: T, auth: 'user', summary: 'Name enquiry for a bank account or PulsePay user',
  body: z.object({ bank_code: z.string().optional(), account_number: z.string().regex(/^\d{10}$/).optional(), paytag: z.string().optional(), phone: phoneSchema.optional() }),
  handler: async ({ body }) => {
    if (body.bank_code) {
      if (!body.account_number) throw unprocessable('account_number required');
      const r = await resolveBankAccount(body.bank_code, body.account_number);
      if (!r) throw notFound('Account not found', 'account_not_found');
      return r;
    }
    const w = await resolveInternalWallet(undefined, { account_number: body.account_number, paytag: body.paytag, phone: body.phone }, 'NGN');
    return { account_name: `${w.first_name} ${w.last_name}`, account_number: w.account_number, bank_name: 'PulsePay', bank_code: null };
  },
});

route({
  method: 'post', path: '/transfers/internal', tags: T, auth: 'user', idempotent: true,
  summary: 'Send money to another PulsePay user (free, instant)',
  body: z.object({
    to: recipient, amount: amountSchema, currency: currencySchema.default('NGN'),
    narration: z.string().max(140).optional(), pin: pinSchema, save_beneficiary: z.boolean().default(false),
  }),
  handler: async ({ body, user }) => {
    await authorizeSpend(user, body.pin);
    const t = await executeInternalTransfer({ user, recipient: body.to, currency: body.currency, amount: body.amount, narration: body.narration });
    if (body.save_beneficiary && t.counterparty?.account_number) {
      await pool.query(
        "INSERT INTO beneficiaries (user_id, type, name, account_number, bank_code, bank_name) VALUES ($1,'internal',$2,$3,'',$4) ON CONFLICT DO NOTHING",
        [user.id, t.counterparty.name, t.counterparty.account_number, 'PulsePay'],
      );
    }
    return created(t);
  },
});

route({
  method: 'post', path: '/transfers/bank', tags: T, auth: 'user', idempotent: true,
  summary: 'Send NGN to any Nigerian bank account',
  description: 'Fee applies. Sandbox: account numbers ending 0000 fail (auto-refund), ending 9999 stay pending until the webhook confirms.',
  body: z.object({
    bank_code: z.string(), account_number: z.string().regex(/^\d{10}$/), amount: amountSchema,
    narration: z.string().max(140).optional(), pin: pinSchema, save_beneficiary: z.boolean().default(false),
  }),
  handler: async ({ body, user }) => {
    await authorizeSpend(user, body.pin);
    const t = await executeBankTransfer({ user, bankCode: body.bank_code, accountNumber: body.account_number, amount: body.amount, narration: body.narration });
    if (body.save_beneficiary && t.status !== 'failed') {
      await pool.query(
        "INSERT INTO beneficiaries (user_id, type, name, account_number, bank_code, bank_name) VALUES ($1,'bank',$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [user.id, t.counterparty.name, body.account_number, body.bank_code, t.counterparty.bank_name],
      );
    }
    if (t.status === 'failed') throw new AppError(422, 'transfer_failed', 'Transfer failed. Your money has been refunded.', { transaction_id: t.id, reference: t.reference });
    return created(t);
  },
});

// ---- Beneficiaries ----
route({
  method: 'get', path: '/beneficiaries', tags: ['Beneficiaries'], auth: 'user', summary: 'Saved beneficiaries',
  handler: ({ user }) => query('SELECT * FROM beneficiaries WHERE user_id=$1 ORDER BY is_favorite DESC, created_at DESC', [user.id]),
});
route({
  method: 'post', path: '/beneficiaries', tags: ['Beneficiaries'], auth: 'user', summary: 'Save a beneficiary',
  body: z.object({ account_number: z.string().regex(/^\d{10}$/), bank_code: z.string().optional() }),
  handler: async ({ body, user }) => {
    let name: string, bankName: string;
    if (body.bank_code) {
      const r = await resolveBankAccount(body.bank_code, body.account_number);
      if (!r) throw notFound('Account not found', 'account_not_found');
      name = r.account_name; bankName = r.bank_name;
    } else {
      const w = await resolveInternalWallet(undefined, { account_number: body.account_number }, 'NGN');
      name = `${w.first_name} ${w.last_name}`; bankName = 'PulsePay';
    }
    const row = await one(
      `INSERT INTO beneficiaries (user_id, type, name, account_number, bank_code, bank_name) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, account_number, bank_code) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
      [user.id, body.bank_code ? 'bank' : 'internal', name, body.account_number, body.bank_code ?? '', bankName],
    );
    return created(row);
  },
});
route({
  method: 'patch', path: '/beneficiaries/:id', tags: ['Beneficiaries'], auth: 'user', summary: 'Favorite / rename a beneficiary',
  body: z.object({ is_favorite: z.boolean().optional(), name: z.string().min(1).max(100).optional() }),
  handler: async ({ body, params, user }) => {
    const row = await one('UPDATE beneficiaries SET is_favorite=COALESCE($3,is_favorite), name=COALESCE($4,name) WHERE id=$1 AND user_id=$2 RETURNING *', [params.id, user.id, body.is_favorite ?? null, body.name ?? null]);
    if (!row) throw notFound('Beneficiary not found');
    return row;
  },
});
route({
  method: 'delete', path: '/beneficiaries/:id', tags: ['Beneficiaries'], auth: 'user', summary: 'Delete a beneficiary',
  handler: async ({ params, user }) => {
    const r = await pool.query('DELETE FROM beneficiaries WHERE id=$1 AND user_id=$2', [params.id, user.id]);
    if (!r.rowCount) throw notFound('Beneficiary not found');
    return { message: 'Deleted' };
  },
});

// ---- Payment requests (request money / pay links) ----
const PR = ['Payment requests'];
route({
  method: 'post', path: '/payment-requests', tags: PR, auth: 'user', summary: 'Request money (from a PayTag/phone, or an open shareable code)',
  body: z.object({
    from: z.object({ paytag: z.string().optional(), phone: phoneSchema.optional() }).optional(),
    amount: amountSchema, currency: currencySchema.default('NGN'), note: z.string().max(140).optional(),
  }),
  handler: async ({ body, user }) => {
    let payerId: string | null = null;
    if (body.from?.paytag || body.from?.phone) {
      const w = await resolveInternalWallet(undefined, { paytag: body.from.paytag, phone: body.from.phone }, body.currency);
      payerId = w.user_id;
      if (payerId === user.id) throw unprocessable('You cannot request money from yourself');
    }
    const row = await one<any>(
      `INSERT INTO payment_requests (code, requester_id, payer_id, currency, amount, note, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval) RETURNING *`,
      [randomCode(10), user.id, payerId, body.currency, body.amount, body.note ?? null, String(config.paymentRequestTtlDays)],
    );
    if (payerId) await notify(payerId, { type: 'transaction', title: 'Payment request', body: `${user.firstName} ${user.lastName} requested ${formatMoney(body.amount, body.currency)}.`, data: { payment_request_id: row.id } });
    return created(row);
  },
});
route({
  method: 'get', path: '/payment-requests', tags: PR, auth: 'user', summary: 'My payment requests (sent or received)',
  query: pageQuery.extend({ role: z.enum(['sent', 'received']).default('sent'), status: z.enum(['pending', 'paid', 'declined', 'cancelled', 'expired']).optional() }),
  handler: async ({ user, query: q }) => {
    await pool.query("UPDATE payment_requests SET status='expired' WHERE status='pending' AND expires_at < now()");
    const col = q.role === 'sent' ? 'requester_id' : 'payer_id';
    const where = `${col}=$1 AND ($2::text IS NULL OR status=$2)`;
    const total = (await one<any>(`SELECT count(*)::int n FROM payment_requests WHERE ${where}`, [user.id, q.status ?? null]))!.n;
    const rows = await query(`SELECT * FROM payment_requests WHERE ${where} ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [user.id, q.status ?? null, q.limit, offset(q)]);
    return paged(rows, pageMeta(q, total));
  },
});
route({
  method: 'get', path: '/payment-requests/code/:code', tags: PR, auth: 'user', summary: 'View a payment request by its shareable code',
  handler: async ({ params }) => {
    const r = await one<any>(
      `SELECT p.id, p.code, p.amount, p.currency, p.note, p.status, p.expires_at, u.first_name, u.last_name, u.paytag
         FROM payment_requests p JOIN users u ON u.id=p.requester_id WHERE p.code=$1`, [params.code.toUpperCase()]);
    if (!r) throw notFound('Payment request not found');
    return r;
  },
});
route({
  method: 'post', path: '/payment-requests/:id/pay', tags: PR, auth: 'user', idempotent: true, summary: 'Pay a payment request',
  body: z.object({ pin: pinSchema }),
  handler: async ({ params, body, user }) => {
    await authorizeSpend(user, body.pin);
    const r = await one<any>('SELECT * FROM payment_requests WHERE id=$1', [params.id]);
    if (!r || (r.payer_id && r.payer_id !== user.id)) throw notFound('Payment request not found');
    if (r.status !== 'pending') throw conflict(`Request is ${r.status}`, 'request_not_pending');
    if (new Date(r.expires_at) < new Date()) throw conflict('Request expired', 'request_expired');
    if (r.requester_id === user.id) throw unprocessable('You cannot pay your own request');
    const w = await one<any>("SELECT account_number FROM wallets WHERE user_id=$1 AND kind='main' AND currency=$2", [r.requester_id, r.currency]);
    if (!w) throw unprocessable('Requester has no wallet for this currency');
    // claim first (atomic) so two payers of an open link can never both pay
    const claim = await pool.query("UPDATE payment_requests SET status='paid', payer_id=$2 WHERE id=$1 AND status='pending'", [r.id, user.id]);
    if (!claim.rowCount) throw conflict('Request is no longer pending', 'request_not_pending');
    let t;
    try {
      t = await executeInternalTransfer({
        user, recipient: { account_number: w.account_number }, currency: r.currency, amount: r.amount,
        narration: r.note ?? 'Payment request', type: 'payment_request', meta: { payment_request_id: r.id },
      });
    } catch (e) {
      await pool.query("UPDATE payment_requests SET status='pending', payer_id=$2 WHERE id=$1", [r.id, r.payer_id]);
      throw e;
    }
    await pool.query('UPDATE payment_requests SET transaction_id=$2 WHERE id=$1', [r.id, t.id]);
    return created(t);
  },
});
for (const [action, status, who] of [['decline', 'declined', 'payer_id'], ['cancel', 'cancelled', 'requester_id']] as const) {
  route({
    method: 'post', path: `/payment-requests/:id/${action}`, tags: PR, auth: 'user', summary: `${action[0].toUpperCase() + action.slice(1)} a payment request`,
    handler: async ({ params, user }) => {
      const r = await one(`UPDATE payment_requests SET status=$3 WHERE id=$1 AND ${who}=$2 AND status='pending' RETURNING *`, [params.id, user.id, status]);
      if (!r) throw notFound('Pending payment request not found');
      return r;
    },
  });
}

export { tx };
