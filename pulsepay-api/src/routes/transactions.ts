import { z } from 'zod';
import { one, query } from '../db';
import { notFound } from '../lib/errors';
import { offset, pageMeta, pageQuery } from '../lib/util';
import { created, paged, route } from '../http/registry';

const T = ['Transactions'];

export function viewTx(t: any, userId: string) {
  const sender = t.sender_user_id === userId, receiver = t.receiver_user_id === userId;
  const direction = sender && receiver ? 'internal' : sender ? 'debit' : 'credit';
  return {
    id: t.id, reference: t.reference, type: t.type, category: t.category, status: t.status, direction,
    currency: t.currency, amount: t.amount, fee: direction === 'debit' ? t.fee : 0,
    total: direction === 'debit' ? t.amount + t.fee : t.amount,
    narration: t.narration, counterparty: direction === 'credit' && t.type !== 'deposit' ? { name: t.sender_name ?? t.counterparty?.name } : t.counterparty,
    meta: t.meta, created_at: t.created_at, completed_at: t.completed_at,
  };
}

const filters = z.object({
  type: z.string().optional(), status: z.enum(['pending', 'success', 'failed', 'reversed']).optional(),
  category: z.string().optional(), direction: z.enum(['debit', 'credit']).optional(), currency: z.string().length(3).optional(),
  from: z.string().optional(), to: z.string().optional(), q: z.string().max(50).optional(),
  min_amount: z.coerce.number().int().optional(), max_amount: z.coerce.number().int().optional(),
});

function buildWhere(userId: string, f: z.infer<typeof filters>) {
  const args: any[] = [userId];
  const w = ['(t.sender_user_id=$1 OR t.receiver_user_id=$1)'];
  const add = (sql: string, v: any) => { args.push(v); w.push(sql.replace('?', '$' + args.length)); };
  if (f.type) add('t.type = ?', f.type);
  if (f.status) add('t.status = ?', f.status);
  if (f.category) add('t.category = ?', f.category);
  if (f.currency) add('t.currency = ?', f.currency.toUpperCase());
  if (f.from) add('t.created_at >= ?::timestamptz', f.from);
  if (f.to) add("t.created_at < ?::timestamptz + interval '1 day'", f.to);
  if (f.min_amount != null) add('t.amount >= ?', f.min_amount);
  if (f.max_amount != null) add('t.amount <= ?', f.max_amount);
  if (f.q) {
    args.push(f.q.replace(/[%_\\]/g, '\\$&'));
    const n = '$' + args.length;
    w.push(`(t.narration ILIKE '%' || ${n} || '%' OR t.counterparty->>'name' ILIKE '%' || ${n} || '%' OR t.reference ILIKE ${n} || '%')`);
  }
  if (f.direction === 'debit') w.push('(t.sender_user_id=$1 AND (t.receiver_user_id IS NULL OR t.receiver_user_id<>$1))');
  if (f.direction === 'credit') w.push('(t.receiver_user_id=$1 AND (t.sender_user_id IS NULL OR t.sender_user_id<>$1))');
  return { where: w.join(' AND '), args };
}

route({
  method: 'get', path: '/transactions', tags: T, auth: 'user', summary: 'Transaction history with filters',
  query: pageQuery.extend(filters.shape),
  handler: async ({ user, query: q }) => {
    const { where, args } = buildWhere(user.id, q);
    const total = (await one<any>(`SELECT count(*)::int n FROM transactions t WHERE ${where}`, args))!.n;
    const rows = await query(
      `SELECT t.*, su.first_name || ' ' || su.last_name AS sender_name FROM transactions t LEFT JOIN users su ON su.id=t.sender_user_id
        WHERE ${where} ORDER BY t.created_at DESC, t.id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, q.limit, offset(q)],
    );
    return paged(rows.map((r) => viewTx(r, user.id)), pageMeta(q, total));
  },
});

route({
  method: 'get', path: '/transactions/summary', tags: T, auth: 'user', summary: 'Money in/out and spending by category (insights)',
  query: z.object({ from: z.string().optional(), to: z.string().optional(), currency: z.string().length(3).default('NGN') }),
  handler: async ({ user, query: q }) => {
    const rows = await query<any>(
      `SELECT category, 
              CASE WHEN sender_user_id=$1 AND (receiver_user_id IS NULL OR receiver_user_id<>$1) THEN 'out'
                   WHEN receiver_user_id=$1 AND (sender_user_id IS NULL OR sender_user_id<>$1) THEN 'in' ELSE 'internal' END AS flow,
              SUM(amount + CASE WHEN sender_user_id=$1 THEN fee ELSE 0 END)::bigint AS total, count(*)::int AS count
         FROM transactions
        WHERE (sender_user_id=$1 OR receiver_user_id=$1) AND status IN ('success','pending') AND currency=$4
          AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz + interval '1 day')
        GROUP BY 1,2`,
      [user.id, q.from ?? null, q.to ?? null, q.currency.toUpperCase()],
    );
    const sum = (f: string) => rows.filter((r) => r.flow === f).reduce((s, r) => s + r.total, 0);
    return {
      currency: q.currency.toUpperCase(), money_in: sum('in'), money_out: sum('out'),
      spending_by_category: rows.filter((r) => r.flow === 'out').map((r) => ({ category: r.category, total: r.total, count: r.count })).sort((a, b) => b.total - a.total),
      income_by_category: rows.filter((r) => r.flow === 'in').map((r) => ({ category: r.category, total: r.total, count: r.count })),
    };
  },
});

async function loadOwnTx(id: string, userId: string) {
  const t = await one<any>(
    `SELECT t.*, su.first_name || ' ' || su.last_name AS sender_name FROM transactions t LEFT JOIN users su ON su.id=t.sender_user_id
      WHERE (t.id::text=$1 OR t.reference=$1) AND (t.sender_user_id=$2 OR t.receiver_user_id=$2)`, [id, userId]);
  if (!t) throw notFound('Transaction not found');
  return t;
}

route({ method: 'get', path: '/transactions/:id', tags: T, auth: 'user', summary: 'Transaction by id or reference',
  handler: async ({ params, user }) => viewTx(await loadOwnTx(params.id, user.id), user.id) });

route({
  method: 'get', path: '/transactions/:id/receipt', tags: T, auth: 'user', summary: 'Shareable receipt data',
  handler: async ({ params, user }) => {
    const t = await loadOwnTx(params.id, user.id);
    const v = viewTx(t, user.id);
    const bill = await one<any>('SELECT category, provider_code, plan_code, customer_ref, customer_name, token FROM bill_payments WHERE transaction_id=$1', [t.id]);
    const me = await one<any>('SELECT first_name, last_name FROM users WHERE id=$1', [user.id]);
    return { receipt_no: t.reference, issued_to: `${me.first_name} ${me.last_name}`, ...v, bill: bill ?? undefined, merchant: 'PulsePay' };
  },
});

route({
  method: 'post', path: '/transactions/:id/report', tags: T, auth: 'user', summary: 'Report a problem with a transaction (opens a support ticket)',
  body: z.object({ message: z.string().min(5).max(2000) }),
  handler: async ({ params, body, user }) => {
    const t = await loadOwnTx(params.id, user.id);
    const ticket = await one<any>(
      "INSERT INTO support_tickets (user_id, subject, category, transaction_id) VALUES ($1,$2,'transaction',$3) RETURNING *",
      [user.id, `Issue with transaction ${t.reference}`, t.id]);
    await query('INSERT INTO support_messages (ticket_id, author_id, body) VALUES ($1,$2,$3)', [ticket.id, user.id, body.message]);
    return created(ticket);
  },
});
