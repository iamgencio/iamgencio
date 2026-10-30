import { z } from 'zod';
import { config } from '../config';
import { one, query, tx } from '../db';
import { AppError, notFound, unprocessable } from '../lib/errors';
import { amountSchema, pinSchema } from '../lib/util';
import { created, route } from '../http/registry';
import { createWallet, postTransaction, userMainWallet } from '../services/ledger';
import { authorizeSpend, requireTier } from '../services/security';
import { lockUser } from '../services/transfers';

const T = ['Savings'];
const view = (p: any) => ({
  id: p.id, name: p.name, type: p.type, balance: p.balance, currency: p.currency, target_amount: p.target_amount,
  progress: p.target_amount ? Math.min(1, p.balance / p.target_amount) : null, locked_until: p.locked_until,
  interest_rate_bps: p.interest_rate_bps, interest_earned: p.interest_earned, status: p.status, wallet_id: p.wallet_id, created_at: p.created_at,
});
const SEL = 'SELECT p.*, w.balance, w.currency FROM savings_pockets p JOIN wallets w ON w.id=p.wallet_id';
async function own(id: string, userId: string) {
  const p = await one<any>(`${SEL} WHERE p.id=$1 AND p.user_id=$2`, [id, userId]);
  if (!p) throw notFound('Savings pocket not found');
  return p;
}

route({ method: 'get', path: '/savings', tags: T, auth: 'user', summary: 'My savings pockets',
  handler: async ({ user }) => (await query(`${SEL} WHERE p.user_id=$1 AND p.status='active' ORDER BY p.created_at DESC`, [user.id])).map(view) });

route({
  method: 'post', path: '/savings', tags: T, auth: 'user', summary: 'Create a savings pocket (flexible, locked until a date, or target-based)',
  body: z.object({
    name: z.string().min(1).max(60), type: z.enum(['flexible', 'locked', 'target']),
    target_amount: amountSchema.optional(), locked_until: z.iso.datetime({ offset: true }).optional(),
  }).superRefine((v, ctx) => {
    if (v.type === 'target' && !v.target_amount) ctx.addIssue({ code: 'custom', path: ['target_amount'], message: 'Required for target pockets' });
    if (v.type === 'locked' && (!v.locked_until || new Date(v.locked_until) <= new Date())) ctx.addIssue({ code: 'custom', path: ['locked_until'], message: 'Must be a future date for locked pockets' });
  }),
  handler: async ({ body, user }) => {
    requireTier(user, 1, 'Savings');
    const p = await tx(async (c) => {
      const w = await createWallet(c, { userId: user.id, currency: 'NGN', kind: 'savings', name: `Savings: ${body.name}` });
      return one<any>(
        `INSERT INTO savings_pockets (user_id, wallet_id, name, type, target_amount, locked_until, interest_rate_bps) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [user.id, w.id, body.name, body.type, body.target_amount ?? null, body.locked_until ?? null, config.savingsRatesBps[body.type]], c);
    });
    return created(view({ ...p, balance: 0, currency: 'NGN' }));
  },
});

route({ method: 'get', path: '/savings/:id', tags: T, auth: 'user', summary: 'Savings pocket', handler: async ({ params, user }) => view(await own(params.id, user.id)) });

route({
  method: 'post', path: '/savings/:id/deposit', tags: T, auth: 'user', idempotent: true, summary: 'Move money from main wallet into the pocket',
  body: z.object({ amount: amountSchema, pin: pinSchema }),
  handler: async ({ params, body, user }) => {
    await authorizeSpend(user, body.pin);
    const p = await own(params.id, user.id);
    const t = await tx(async (c) => {
      await lockUser(c, user.id);
      const main = await userMainWallet(c, user.id, 'NGN');
      return postTransaction(c, {
        type: 'savings_deposit', category: 'savings', currency: 'NGN', amount: body.amount, narration: `Saved to ${p.name}`,
        senderWalletId: main.id, receiverWalletId: p.wallet_id, senderUserId: user.id, receiverUserId: user.id,
        legs: [{ walletId: main.id, direction: 'debit', amount: body.amount }, { walletId: p.wallet_id, direction: 'credit', amount: body.amount }],
      });
    });
    return created(t);
  },
});

route({
  method: 'post', path: '/savings/:id/withdraw', tags: T, auth: 'user', idempotent: true, summary: 'Withdraw to main wallet (locked pockets only after the lock date)',
  body: z.object({ amount: amountSchema, pin: pinSchema }),
  handler: async ({ params, body, user }) => {
    await authorizeSpend(user, body.pin);
    const p = await own(params.id, user.id);
    if (p.type === 'locked' && p.locked_until && new Date(p.locked_until) > new Date()) {
      throw new AppError(422, 'pocket_locked', `This pocket is locked until ${new Date(p.locked_until).toISOString()}`);
    }
    const t = await tx(async (c) => {
      const main = await userMainWallet(c, user.id, 'NGN');
      return postTransaction(c, {
        type: 'savings_withdraw', category: 'savings', currency: 'NGN', amount: body.amount, narration: `Withdrawn from ${p.name}`,
        senderWalletId: p.wallet_id, receiverWalletId: main.id, senderUserId: user.id, receiverUserId: user.id,
        legs: [{ walletId: p.wallet_id, direction: 'debit', amount: body.amount }, { walletId: main.id, direction: 'credit', amount: body.amount }],
      });
    });
    return created(t);
  },
});

route({
  method: 'delete', path: '/savings/:id', tags: T, auth: 'user', summary: 'Close a pocket (balance returns to main wallet; locked pockets must have matured)',
  handler: async ({ params, user }) => {
    const p = await own(params.id, user.id);
    if (p.type === 'locked' && p.locked_until && new Date(p.locked_until) > new Date()) throw new AppError(422, 'pocket_locked', 'Pocket is still locked');
    await tx(async (c) => {
      const w = await one<any>('SELECT balance FROM wallets WHERE id=$1 FOR UPDATE', [p.wallet_id], c);
      if (w.balance > 0) {
        const main = await userMainWallet(c, user.id, 'NGN');
        await postTransaction(c, {
          type: 'savings_withdraw', category: 'savings', currency: 'NGN', amount: w.balance, narration: `Closed ${p.name}`,
          senderWalletId: p.wallet_id, receiverWalletId: main.id, senderUserId: user.id, receiverUserId: user.id,
          legs: [{ walletId: p.wallet_id, direction: 'debit', amount: w.balance }, { walletId: main.id, direction: 'credit', amount: w.balance }],
        });
      }
      await c.query("UPDATE savings_pockets SET status='closed' WHERE id=$1", [p.id]);
      await c.query("UPDATE wallets SET status='closed' WHERE id=$1", [p.wallet_id]);
    });
    return { message: 'Pocket closed' };
  },
});

export { unprocessable };
