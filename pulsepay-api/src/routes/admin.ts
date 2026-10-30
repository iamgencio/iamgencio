import { z } from 'zod';
import { one, pool, query, tx } from '../db';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { amountSchema, currencySchema, offset, pageMeta, pageQuery } from '../lib/util';
import { created, paged, route } from '../http/registry';
import { publicUser } from '../services/auth';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { raiseTier } from '../services/kyc';
import { postTransaction, reverseTransaction, systemWallet } from '../services/ledger';
import { accrueDailyInterest } from '../services/interest';
import { toNgn } from '../services/ledger';

const T = ['Admin'];

route({
  method: 'get', path: '/admin/overview', tags: T, auth: 'staff', summary: 'Platform KPIs',
  handler: async () => {
    const users = await one<any>("SELECT count(*)::int total, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int new_24h, count(*) FILTER (WHERE status<>'active')::int restricted FROM users WHERE role='user'");
    const tx24 = await query<any>("SELECT currency, count(*)::int n, SUM(amount)::bigint volume, SUM(fee)::bigint fees FROM transactions WHERE created_at > now() - interval '24 hours' AND status='success' AND type NOT IN ('reversal') GROUP BY currency");
    const held = await query<any>("SELECT currency, SUM(balance)::bigint total FROM wallets WHERE kind<>'system' GROUP BY currency");
    const pendingKyc = (await one<any>("SELECT count(*)::int n FROM kyc_submissions WHERE status='pending'"))!.n;
    const pendingTx = (await one<any>("SELECT count(*)::int n FROM transactions WHERE status='pending'"))!.n;
    const open = (await one<any>("SELECT count(*)::int n FROM support_tickets WHERE status IN ('open','pending')"))!.n;
    return {
      users, transactions_24h: tx24, customer_funds: held,
      customer_funds_ngn: held.reduce((s, r) => s + toNgn(r.total, r.currency), 0),
      pending_kyc: pendingKyc, pending_transactions: pendingTx, open_tickets: open,
    };
  },
});

route({
  method: 'get', path: '/admin/ledger/integrity', tags: T, auth: 'staff', summary: 'Double-entry integrity check: balances vs ledger, and net position per currency',
  handler: async () => {
    const drift = await query<any>(
      `SELECT w.id, w.account_number, w.balance, COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE -e.amount END),0)::bigint AS ledger_balance
         FROM wallets w LEFT JOIN ledger_entries e ON e.wallet_id=w.id GROUP BY w.id HAVING w.balance <> COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE -e.amount END),0)`);
    const net = await query<any>('SELECT currency, SUM(balance)::bigint AS net FROM wallets GROUP BY currency');
    return { ok: drift.length === 0 && net.every((n) => n.net === 0), wallets_with_drift: drift, net_by_currency: net };
  },
});

route({
  method: 'get', path: '/admin/users', tags: T, auth: 'staff', summary: 'Search users',
  query: pageQuery.extend({ q: z.string().max(60).optional(), status: z.enum(['active', 'suspended', 'closed']).optional(), tier: z.coerce.number().int().min(0).max(3).optional(), role: z.enum(['user', 'support', 'admin']).optional() }),
  handler: async ({ query: q }) => {
    const where = `($1::text IS NULL OR email ILIKE '%'||$1||'%' OR phone ILIKE '%'||$1||'%' OR paytag ILIKE '%'||$1||'%' OR first_name||' '||last_name ILIKE '%'||$1||'%')
                   AND ($2::text IS NULL OR status=$2) AND ($3::int IS NULL OR kyc_tier=$3) AND ($4::text IS NULL OR role=$4)`;
    const args = [q.q ?? null, q.status ?? null, q.tier ?? null, q.role ?? null];
    const total = (await one<any>(`SELECT count(*)::int n FROM users WHERE ${where}`, args))!.n;
    const rows = await query(`SELECT * FROM users WHERE ${where} ORDER BY created_at DESC LIMIT $5 OFFSET $6`, [...args, q.limit, offset(q)]);
    return paged(rows.map(publicUser), pageMeta(q, total));
  },
});

route({
  method: 'get', path: '/admin/users/:id', tags: T, auth: 'staff', summary: 'User detail with wallets and recent activity',
  handler: async ({ params }) => {
    const u = await one<any>('SELECT * FROM users WHERE id=$1', [params.id]);
    if (!u) throw notFound('User not found');
    const wallets = await query('SELECT id, kind, currency, name, account_number, balance, status FROM wallets WHERE user_id=$1 ORDER BY kind', [u.id]);
    const recent = await query('SELECT id, reference, type, status, currency, amount, fee, created_at FROM transactions WHERE sender_user_id=$1 OR receiver_user_id=$1 ORDER BY created_at DESC LIMIT 20', [u.id]);
    const kyc = await query('SELECT id, kind, status, tier_target, created_at FROM kyc_submissions WHERE user_id=$1 ORDER BY created_at DESC', [u.id]);
    return { user: publicUser(u), wallets, recent_transactions: recent, kyc };
  },
});

route({
  method: 'patch', path: '/admin/users/:id/status', tags: T, auth: 'admin', summary: 'Suspend / reactivate a user',
  body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().min(3).max(300) }),
  handler: async ({ params, body, user, req }) => {
    if (params.id === user.id) throw unprocessable('You cannot change your own status');
    const u = await one<any>("UPDATE users SET status=$2, updated_at=now() WHERE id=$1 AND status<>'closed' RETURNING *", [params.id, body.status]);
    if (!u) throw notFound('User not found');
    if (body.status === 'suspended') await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [u.id]);
    await audit(user.id, `admin.user_${body.status}`, { entity: 'user', entityId: u.id, meta: { reason: body.reason }, req });
    return publicUser(u);
  },
});

route({
  method: 'patch', path: '/admin/users/:id/tier', tags: T, auth: 'admin', summary: 'Manually set a KYC tier',
  body: z.object({ tier: z.number().int().min(0).max(3), reason: z.string().min(3).max(300) }),
  handler: async ({ params, body, user, req }) => {
    const u = await one<any>('UPDATE users SET kyc_tier=$2, updated_at=now() WHERE id=$1 RETURNING *', [params.id, body.tier]);
    if (!u) throw notFound('User not found');
    await audit(user.id, 'admin.set_tier', { entity: 'user', entityId: u.id, meta: body, req });
    return publicUser(u);
  },
});

route({
  method: 'patch', path: '/admin/users/:id/role', tags: T, auth: 'admin', summary: 'Grant/revoke staff roles',
  body: z.object({ role: z.enum(['user', 'support', 'admin']) }),
  handler: async ({ params, body, user, req }) => {
    if (params.id === user.id) throw unprocessable('You cannot change your own role');
    const u = await one<any>('UPDATE users SET role=$2, updated_at=now() WHERE id=$1 RETURNING *', [params.id, body.role]);
    if (!u) throw notFound('User not found');
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [u.id]);
    await audit(user.id, 'admin.set_role', { entity: 'user', entityId: u.id, meta: body, req });
    return publicUser(u);
  },
});

route({
  method: 'get', path: '/admin/kyc', tags: T, auth: 'staff', summary: 'KYC submissions queue',
  query: pageQuery.extend({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }),
  handler: async ({ query: q }) => {
    const total = (await one<any>('SELECT count(*)::int n FROM kyc_submissions WHERE status=$1', [q.status]))!.n;
    const rows = await query(
      `SELECT k.*, u.first_name, u.last_name, u.email FROM kyc_submissions k JOIN users u ON u.id=k.user_id WHERE k.status=$1 ORDER BY k.created_at LIMIT $2 OFFSET $3`, [q.status, q.limit, offset(q)]);
    return paged(rows, pageMeta(q, total));
  },
});

route({
  method: 'post', path: '/admin/kyc/:id/review', tags: T, auth: 'admin', summary: 'Approve or reject a KYC submission',
  body: z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(300).optional() }).refine((b) => b.decision === 'approve' || !!b.reason, 'reason required when rejecting'),
  handler: async ({ params, body, user, req }) => {
    const k = await tx(async (c) => {
      const row = await one<any>('SELECT * FROM kyc_submissions WHERE id=$1 FOR UPDATE', [params.id], c);
      if (!row) throw notFound('Submission not found');
      if (row.status !== 'pending') throw conflict('Already reviewed', 'already_reviewed');
      const upd = await one<any>(
        'UPDATE kyc_submissions SET status=$2, reason=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1 RETURNING *',
        [row.id, body.decision === 'approve' ? 'approved' : 'rejected', body.reason ?? null, user.id], c);
      if (body.decision === 'approve') await raiseTier(row.user_id, row.tier_target, c);
      return upd;
    });
    await audit(user.id, `admin.kyc_${body.decision}`, { entity: 'kyc', entityId: k.id, meta: { reason: body.reason }, req });
    await notify(k.user_id, {
      type: 'system', title: body.decision === 'approve' ? 'Verification approved' : 'Verification rejected',
      body: body.decision === 'approve' ? `You are now on KYC Tier ${k.tier_target}.` : `We could not verify your ${k.kind.replace('_', ' ')}: ${body.reason}`,
    });
    return k;
  },
});

route({
  method: 'get', path: '/admin/transactions', tags: T, auth: 'staff', summary: 'Search all transactions',
  query: pageQuery.extend({ status: z.string().optional(), type: z.string().optional(), user_id: z.uuid().optional(), reference: z.string().optional() }),
  handler: async ({ query: q }) => {
    const where = `($1::text IS NULL OR t.status=$1) AND ($2::text IS NULL OR t.type=$2) AND ($3::uuid IS NULL OR t.sender_user_id=$3 OR t.receiver_user_id=$3) AND ($4::text IS NULL OR t.reference=$4)`;
    const args = [q.status ?? null, q.type ?? null, q.user_id ?? null, q.reference ?? null];
    const total = (await one<any>(`SELECT count(*)::int n FROM transactions t WHERE ${where}`, args))!.n;
    const rows = await query(`SELECT t.* FROM transactions t WHERE ${where} ORDER BY t.created_at DESC LIMIT $5 OFFSET $6`, [...args, q.limit, offset(q)]);
    return paged(rows, pageMeta(q, total));
  },
});

route({
  method: 'post', path: '/admin/transactions/:id/reverse', tags: T, auth: 'admin', summary: 'Reverse a successful transaction (mirror ledger entries)',
  body: z.object({ reason: z.string().min(3).max(300) }),
  handler: async ({ params, body, user, req }) => {
    const rev = await tx(async (c) => {
      const t = await one<any>('SELECT status FROM transactions WHERE id=$1', [params.id], c);
      if (!t) throw notFound('Transaction not found');
      if (t.status !== 'success') throw unprocessable('Only successful transactions can be reversed', 'not_reversible');
      return reverseTransaction(c, params.id, body.reason);
    });
    await audit(user.id, 'admin.reverse_transaction', { entity: 'transaction', entityId: params.id, meta: body, req });
    return created(rev);
  },
});

for (const [action, status] of [['freeze', 'frozen'], ['unfreeze', 'active']] as const) {
  route({
    method: 'post', path: `/admin/wallets/:id/${action}`, tags: T, auth: 'admin', summary: `${action[0].toUpperCase() + action.slice(1)} a wallet`,
    body: z.object({ reason: z.string().min(3).max(300) }),
    handler: async ({ params, body, user, req }) => {
      const w = await one<any>("UPDATE wallets SET status=$2, updated_at=now() WHERE id=$1 AND kind<>'system' AND status<>'closed' RETURNING *", [params.id, status]);
      if (!w) throw notFound('Wallet not found');
      await audit(user.id, `admin.wallet_${action}`, { entity: 'wallet', entityId: w.id, meta: body, req });
      if (w.user_id) await notify(w.user_id, { type: 'security', title: `Wallet ${status}`, body: `Your ${w.currency} wallet was ${status}.${action === 'freeze' ? ' Contact support.' : ''}` });
      return { id: w.id, status: w.status };
    },
  });
}

route({
  method: 'post', path: '/admin/wallets/:id/adjust', tags: T, auth: 'admin', summary: 'Manual ledger adjustment (credit/debit) against the adjustments account',
  body: z.object({ direction: z.enum(['credit', 'debit']), amount: amountSchema, reason: z.string().min(5).max(300) }),
  handler: async ({ params, body, user, req }) => {
    const t = await tx(async (c) => {
      const w = await one<any>("SELECT * FROM wallets WHERE id=$1 AND kind<>'system'", [params.id], c);
      if (!w) throw notFound('Wallet not found');
      const sys = await systemWallet(c, 'ADJUSTMENTS', w.currency);
      const credit = body.direction === 'credit';
      return postTransaction(c, {
        type: 'adjustment', category: 'adjustment', currency: w.currency, amount: body.amount, narration: body.reason,
        senderWalletId: credit ? sys.id : w.id, receiverWalletId: credit ? w.id : sys.id,
        senderUserId: credit ? null : w.user_id, receiverUserId: credit ? w.user_id : null, meta: { by: user.id },
        legs: [
          { walletId: w.id, direction: body.direction, amount: body.amount },
          { walletId: sys.id, direction: credit ? 'debit' : 'credit', amount: body.amount },
        ],
      });
    });
    await audit(user.id, 'admin.adjust_wallet', { entity: 'wallet', entityId: params.id, meta: body, req });
    return created(t);
  },
});

route({ method: 'post', path: '/admin/jobs/accrue-interest', tags: T, auth: 'admin', summary: 'Run the daily savings interest accrual (idempotent per day)',
  handler: () => accrueDailyInterest() });

route({
  method: 'get', path: '/admin/audit-logs', tags: T, auth: 'admin', summary: 'Audit trail',
  query: pageQuery.extend({ actor_id: z.uuid().optional(), action: z.string().optional() }),
  handler: async ({ query: q }) => {
    const where = '($1::uuid IS NULL OR actor_id=$1) AND ($2::text IS NULL OR action LIKE $2 || \'%\')';
    const total = (await one<any>(`SELECT count(*)::int n FROM audit_logs WHERE ${where}`, [q.actor_id ?? null, q.action ?? null]))!.n;
    const rows = await query(`SELECT * FROM audit_logs WHERE ${where} ORDER BY id DESC LIMIT $3 OFFSET $4`, [q.actor_id ?? null, q.action ?? null, q.limit, offset(q)]);
    return paged(rows, pageMeta(q, total));
  },
});

route({
  method: 'get', path: '/admin/support/tickets', tags: T, auth: 'staff', summary: 'All support tickets',
  query: pageQuery.extend({ status: z.enum(['open', 'pending', 'resolved', 'closed']).optional() }),
  handler: async ({ query: q }) => {
    const total = (await one<any>('SELECT count(*)::int n FROM support_tickets WHERE ($1::text IS NULL OR status=$1)', [q.status ?? null]))!.n;
    const rows = await query(
      `SELECT s.*, u.first_name, u.last_name, u.email FROM support_tickets s JOIN users u ON u.id=s.user_id WHERE ($1::text IS NULL OR s.status=$1) ORDER BY s.updated_at DESC LIMIT $2 OFFSET $3`, [q.status ?? null, q.limit, offset(q)]);
    return paged(rows, pageMeta(q, total));
  },
});
route({
  method: 'patch', path: '/admin/support/tickets/:id', tags: T, auth: 'staff', summary: 'Update ticket status',
  body: z.object({ status: z.enum(['open', 'pending', 'resolved', 'closed']) }),
  handler: async ({ params, body }) => {
    const t = await one('UPDATE support_tickets SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [params.id, body.status]);
    if (!t) throw notFound('Ticket not found');
    return t;
  },
});

export { currencySchema };
