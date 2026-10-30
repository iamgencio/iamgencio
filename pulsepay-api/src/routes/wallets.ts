import { z } from 'zod';
import { config } from '../config';
import { one, query, tx } from '../db';
import { AppError, forbidden, notFound, unprocessable } from '../lib/errors';
import { amountSchema, currencySchema, offset, pageMeta, pageQuery, pinSchema, newReference } from '../lib/util';
import { created, paged, route } from '../http/registry';
import { createWallet, postTransaction, systemWallet, toNgn, userMainWallet } from '../services/ledger';
import { authorizeSpend, assertWalletOwner, requireTier } from '../services/security';
import { creditDeposit, fxQuote, publicWallet } from '../services/wallets';
import { formatMoney, notify } from '../services/notify';
import { lockUser } from '../services/transfers';
import { randomDigits } from '../lib/crypto';

const T = ['Wallets'];

const withOwner = (rows: any[], name: string) => rows.map((w) => publicWallet({ ...w, owner_name: name }));

route({
  method: 'get', path: '/wallets', tags: T, auth: 'user', summary: 'List my wallets (main, savings, card)',
  query: z.object({ kind: z.enum(['main', 'savings', 'card']).optional() }),
  handler: async ({ user, query: q }) => {
    const rows = await query("SELECT * FROM wallets WHERE user_id=$1 AND status<>'closed' AND ($2::text IS NULL OR kind=$2) ORDER BY kind, created_at", [user.id, q.kind ?? null]);
    return withOwner(rows, `${user.firstName} ${user.lastName}`);
  },
});

route({
  method: 'post', path: '/wallets', tags: T, auth: 'user', summary: 'Open a new currency wallet (Tier 1+)',
  body: z.object({ currency: currencySchema }),
  handler: async ({ body, user }) => {
    requireTier(user, 1, 'Opening a foreign-currency wallet');
    const exists = await one("SELECT 1 FROM wallets WHERE user_id=$1 AND kind='main' AND currency=$2", [user.id, body.currency]);
    if (exists) throw new AppError(409, 'wallet_exists', `You already have a ${body.currency} wallet`);
    const w = await createWallet(await import('../db').then((m) => m.pool), { userId: user.id, currency: body.currency, name: `${body.currency} wallet` });
    return created(publicWallet({ ...w, owner_name: `${user.firstName} ${user.lastName}` }));
  },
});

route({
  method: 'get', path: '/wallets/summary', tags: T, auth: 'user', summary: 'Total net worth in NGN across wallets',
  handler: async ({ user }) => {
    const rows = await query<any>("SELECT kind, currency, SUM(balance)::bigint AS balance FROM wallets WHERE user_id=$1 AND status<>'closed' GROUP BY kind, currency", [user.id]);
    const total = rows.reduce((s, r) => s + toNgn(r.balance, r.currency), 0);
    const by = (k: string) => rows.filter((r) => r.kind === k).reduce((s, r) => s + toNgn(r.balance, r.currency), 0);
    return { currency: 'NGN', total_balance: total, available: by('main'), savings: by('savings'), cards: by('card'), breakdown: rows };
  },
});

route({
  method: 'get', path: '/wallets/:id', tags: T, auth: 'user', summary: 'Wallet details',
  handler: async ({ params, user }) => publicWallet({ ...(await assertWalletOwner(await import('../db').then((m) => m.pool), params.id, user.id)), owner_name: `${user.firstName} ${user.lastName}` }),
});

route({
  method: 'get', path: '/wallets/:id/statement', tags: T, auth: 'user', summary: 'Wallet statement with running balance (JSON or CSV)',
  query: pageQuery.extend({ from: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(), to: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(), format: z.enum(['json', 'csv']).default('json') }),
  handler: async ({ params, user, query: q, res }) => {
    const w = await assertWalletOwner(await import('../db').then((m) => m.pool), params.id, user.id);
    const where = 'e.wallet_id=$1 AND ($2::timestamptz IS NULL OR e.created_at >= $2) AND ($3::timestamptz IS NULL OR e.created_at < $3::timestamptz + interval \'1 day\')';
    const args = [w.id, q.from ?? null, q.to ?? null];
    const sel = `SELECT e.id, e.created_at, e.direction, e.amount, e.balance_after, e.label, t.reference, t.type, t.narration, t.status
                   FROM ledger_entries e JOIN transactions t ON t.id=e.transaction_id WHERE ${where} ORDER BY e.id DESC`;
    if (q.format === 'csv') {
      const rows = await query<any>(sel + ' LIMIT 10000', args);
      const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = ['date,reference,type,narration,debit,credit,balance']
        .concat(rows.map((r) => [r.created_at.toISOString?.() ?? r.created_at, r.reference, r.type, esc(r.narration), r.direction === 'debit' ? r.amount / 100 : '', r.direction === 'credit' ? r.amount / 100 : '', r.balance_after / 100].join(','))).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="statement-${w.account_number}.csv"`);
      res.send(csv);
      return;
    }
    const total = (await one<any>(`SELECT count(*)::int n FROM ledger_entries e WHERE ${where}`, args))!.n;
    const rows = await query(sel + ' LIMIT $4 OFFSET $5', [...args, q.limit, offset(q)]);
    return paged({ wallet: publicWallet({ ...w, owner_name: '' }), entries: rows }, pageMeta(q, total));
  },
});

route({
  method: 'post', path: '/wallets/:id/simulate-deposit', tags: T, auth: 'user',
  summary: '[Sandbox only] Simulate an inbound bank deposit into your wallet',
  body: z.object({ amount: amountSchema, sender_name: z.string().default('Sandbox Sender') }),
  handler: async ({ params, user, body }) => {
    if (config.isProd) throw forbidden('Not available in production', 'sandbox_only');
    const w = await assertWalletOwner(await import('../db').then((m) => m.pool), params.id, user.id);
    if (w.kind !== 'main') throw unprocessable('Only main wallets can receive deposits');
    const { transaction } = await creditDeposit({
      accountNumber: w.account_number, amount: body.amount, externalReference: 'SIM' + randomDigits(12), senderName: body.sender_name, senderBank: 'Sandbox Bank',
    });
    return created(transaction);
  },
});

route({
  method: 'get', path: '/exchange/quote', tags: ['Exchange'], auth: 'user', summary: 'Quote a currency exchange between your wallets',
  query: z.object({ from: currencySchema, to: currencySchema, amount: z.coerce.number().int().positive() }),
  handler: async ({ query: q }) => fxQuote(q.from, q.to, q.amount),
});

route({
  method: 'post', path: '/exchange', tags: ['Exchange'], auth: 'user', idempotent: true, summary: 'Convert money between your currency wallets',
  body: z.object({ from: currencySchema, to: currencySchema, amount: amountSchema, pin: pinSchema }),
  handler: async ({ body, user }) => {
    await authorizeSpend(user, body.pin);
    const q = fxQuote(body.from, body.to, body.amount);
    if (q.received <= 0) throw unprocessable('Amount too small to convert', 'amount_too_small');
    const t = await tx(async (c) => {
      await lockUser(c, user.id);
      const from = await userMainWallet(c, user.id, body.from);
      let to = await one<any>("SELECT * FROM wallets WHERE user_id=$1 AND kind='main' AND currency=$2", [user.id, body.to], c);
      if (!to) { requireTier(user, 1, 'Opening a foreign-currency wallet'); to = await createWallet(c, { userId: user.id, currency: body.to }); }
      const fxFrom = await systemWallet(c, 'FX', body.from);
      const fxTo = await systemWallet(c, 'FX', body.to);
      return postTransaction(c, {
        type: 'exchange', category: 'exchange', currency: body.from, amount: body.amount,
        narration: `${body.from} → ${body.to} @ ${q.rate.toFixed(4)}`, senderWalletId: from.id, receiverWalletId: to.id,
        senderUserId: user.id, receiverUserId: user.id,
        meta: { to_currency: body.to, received: q.received, rate: q.rate, mid_rate: q.mid_rate },
        legs: [
          { walletId: from.id, direction: 'debit', amount: body.amount },
          { walletId: fxFrom.id, direction: 'credit', amount: body.amount },
          { walletId: fxTo.id, direction: 'debit', amount: q.received },
          { walletId: to.id, direction: 'credit', amount: q.received },
        ],
      });
    });
    await notify(user.id, { type: 'transaction', title: 'Currency exchanged', body: `${formatMoney(body.amount, body.from)} → ${formatMoney(q.received, body.to)}`, data: { transaction_id: t.id } });
    return created({ transaction: t, quote: q });
  },
});

export { newReference, notFound };
