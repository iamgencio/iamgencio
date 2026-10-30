import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config';
import { one, pool, query, tx } from '../db';
import { decrypt, encrypt, luhnCheckDigit, randomDigits } from '../lib/crypto';
import { AppError, notFound, unprocessable } from '../lib/errors';
import { amountSchema, currencySchema, pinSchema } from '../lib/util';
import { created, route } from '../http/registry';
import { createWallet, postTransaction, systemWallet, userMainWallet } from '../services/ledger';
import { authorizeSpend, requireTier } from '../services/security';
import { lockUser } from '../services/transfers';
import { formatMoney, notify } from '../services/notify';
import { postCardSpend } from '../services/cards';

const T = ['Cards'];

const publicCard = (c: any) => ({
  id: c.id, label: c.label, brand: c.brand, currency: c.currency, masked_pan: `**** **** **** ${c.last4}`, last4: c.last4,
  exp_month: c.exp_month, exp_year: c.exp_year, holder_name: c.holder_name, status: c.status, spend_limit: c.spend_limit,
  wallet_id: c.wallet_id, balance: c.balance, created_at: c.created_at,
});

async function ownCard(id: string, userId: string) {
  const c = await one<any>('SELECT c.*, w.balance FROM cards c JOIN wallets w ON w.id=c.wallet_id WHERE c.id=$1 AND c.user_id=$2', [id, userId]);
  if (!c) throw notFound('Card not found');
  return c;
}

route({
  method: 'get', path: '/cards', tags: T, auth: 'user', summary: 'My virtual cards',
  handler: async ({ user }) => (await query("SELECT c.*, w.balance FROM cards c JOIN wallets w ON w.id=c.wallet_id WHERE c.user_id=$1 AND c.status<>'terminated' ORDER BY c.created_at DESC", [user.id])).map(publicCard),
});

route({
  method: 'post', path: '/cards', tags: T, auth: 'user', idempotent: true, summary: 'Create a virtual card (Tier 1+; creation fee charged to main wallet)',
  body: z.object({ label: z.string().min(1).max(40).default('Online shopping'), currency: z.enum(['NGN', 'USD']).default('NGN'), pin: pinSchema, spend_limit: amountSchema.optional() }),
  handler: async ({ body, user }) => {
    requireTier(user, 1, 'Creating a virtual card');
    await authorizeSpend(user, body.pin);
    const fee = config.cardCreationFee[body.currency] ?? 0;
    const card = await tx(async (c) => {
      await lockUser(c, user.id);
      const count = (await one<any>("SELECT count(*)::int n FROM cards WHERE user_id=$1 AND status<>'terminated'", [user.id], c))!.n;
      if (count >= 5) throw unprocessable('Maximum of 5 active cards', 'card_limit');
      const main = await userMainWallet(c, user.id, body.currency);
      const wallet = await createWallet(c, { userId: user.id, currency: body.currency, kind: 'card', name: `Card: ${body.label}` });
      if (fee > 0) {
        const fees = await systemWallet(c, 'FEES', body.currency);
        await postTransaction(c, {
          type: 'card_fee', category: 'fees', currency: body.currency, amount: fee, narration: 'Virtual card creation fee',
          senderWalletId: main.id, senderUserId: user.id, receiverWalletId: fees.id,
          legs: [{ walletId: main.id, direction: 'debit', amount: fee }, { walletId: fees.id, direction: 'credit', amount: fee }],
        });
      }
      const partial = (body.currency === 'USD' ? '4' : '5') + '39' + randomDigits(12);
      const pan = partial + luhnCheckDigit(partial);
      const exp = new Date(); exp.setFullYear(exp.getFullYear() + 4);
      const row = await one<any>(
        `INSERT INTO cards (user_id, wallet_id, label, brand, currency, last4, pan_enc, cvv_enc, exp_month, exp_year, holder_name, spend_limit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [user.id, wallet.id, body.label, body.currency === 'USD' ? 'visa' : 'mastercard', body.currency, pan.slice(-4), encrypt(pan), encrypt(randomDigits(3)),
          exp.getMonth() + 1, exp.getFullYear(), `${user.firstName} ${user.lastName}`.toUpperCase(), body.spend_limit ?? null], c);
      return { ...row, balance: 0 };
    });
    return created(publicCard(card));
  },
});

route({ method: 'get', path: '/cards/:id', tags: T, auth: 'user', summary: 'Card (masked)', handler: async ({ params, user }) => publicCard(await ownCard(params.id, user.id)) });

route({
  method: 'post', path: '/cards/:id/reveal', tags: T, auth: 'user', summary: 'Reveal full card number and CVV (requires PIN)',
  body: z.object({ pin: pinSchema }),
  handler: async ({ params, body, user, res }) => {
    await authorizeSpend(user, body.pin);
    const c = await ownCard(params.id, user.id);
    res.setHeader('Cache-Control', 'no-store');
    return { pan: decrypt(c.pan_enc), cvv: decrypt(c.cvv_enc), exp_month: c.exp_month, exp_year: c.exp_year, holder_name: c.holder_name };
  },
});

route({
  method: 'post', path: '/cards/:id/fund', tags: T, auth: 'user', idempotent: true, summary: 'Move money from your main wallet to the card',
  body: z.object({ amount: amountSchema, pin: pinSchema }),
  handler: async ({ params, body, user }) => {
    await authorizeSpend(user, body.pin);
    const card = await ownCard(params.id, user.id);
    if (card.status === 'terminated') throw unprocessable('Card terminated', 'card_terminated');
    const t = await tx(async (c) => {
      await lockUser(c, user.id);
      const main = await userMainWallet(c, user.id, card.currency);
      return postTransaction(c, {
        type: 'card_fund', category: 'card', currency: card.currency, amount: body.amount, narration: `Fund card •••• ${card.last4}`,
        senderWalletId: main.id, receiverWalletId: card.wallet_id, senderUserId: user.id, receiverUserId: user.id,
        legs: [{ walletId: main.id, direction: 'debit', amount: body.amount }, { walletId: card.wallet_id, direction: 'credit', amount: body.amount }],
      });
    });
    return created(t);
  },
});

route({
  method: 'post', path: '/cards/:id/withdraw', tags: T, auth: 'user', idempotent: true, summary: 'Move money from the card back to your main wallet',
  body: z.object({ amount: amountSchema, pin: pinSchema }),
  handler: async ({ params, body, user }) => {
    await authorizeSpend(user, body.pin);
    const card = await ownCard(params.id, user.id);
    const t = await tx(async (c) => {
      const main = await userMainWallet(c, user.id, card.currency);
      return postTransaction(c, {
        type: 'card_withdraw', category: 'card', currency: card.currency, amount: body.amount, narration: `Withdraw from card •••• ${card.last4}`,
        senderWalletId: card.wallet_id, receiverWalletId: main.id, senderUserId: user.id, receiverUserId: user.id,
        legs: [{ walletId: card.wallet_id, direction: 'debit', amount: body.amount }, { walletId: main.id, direction: 'credit', amount: body.amount }],
      });
    });
    return created(t);
  },
});

for (const [action, to, from] of [['freeze', 'frozen', 'active'], ['unfreeze', 'active', 'frozen']] as const) {
  route({
    method: 'post', path: `/cards/:id/${action}`, tags: T, auth: 'user', summary: `${action[0].toUpperCase() + action.slice(1)} a card`,
    handler: async ({ params, user }) => {
      const r = await one<any>('UPDATE cards SET status=$3 WHERE id=$1 AND user_id=$2 AND status=$4 RETURNING *', [params.id, user.id, to, from]);
      if (!r) throw new AppError(409, 'invalid_card_state', `Card must be ${from} to ${action}`);
      return publicCard({ ...r, balance: (await one<any>('SELECT balance FROM wallets WHERE id=$1', [r.wallet_id]))!.balance });
    },
  });
}

route({
  method: 'patch', path: '/cards/:id', tags: T, auth: 'user', summary: 'Rename card / change per-transaction limit',
  body: z.object({ label: z.string().min(1).max(40).optional(), spend_limit: amountSchema.nullable().optional() }),
  handler: async ({ params, body, user }) => {
    await ownCard(params.id, user.id);
    const r = await one<any>('UPDATE cards SET label=COALESCE($2,label), spend_limit=CASE WHEN $4 THEN $3 ELSE spend_limit END WHERE id=$1 RETURNING *',
      [params.id, body.label ?? null, body.spend_limit ?? null, body.spend_limit !== undefined]);
    return publicCard({ ...r, balance: (await one<any>('SELECT balance FROM wallets WHERE id=$1', [r.wallet_id]))!.balance });
  },
});

route({
  method: 'delete', path: '/cards/:id', tags: T, auth: 'user', summary: 'Terminate a card (remaining balance returns to main wallet)',
  handler: async ({ params, user }) => {
    const card = await ownCard(params.id, user.id);
    await tx(async (c) => {
      const w = await one<any>('SELECT balance FROM wallets WHERE id=$1 FOR UPDATE', [card.wallet_id], c);
      if (w.balance > 0) {
        const main = await userMainWallet(c, user.id, card.currency);
        await postTransaction(c, {
          type: 'card_withdraw', category: 'card', currency: card.currency, amount: w.balance, narration: `Card •••• ${card.last4} terminated`,
          senderWalletId: card.wallet_id, receiverWalletId: main.id, senderUserId: user.id, receiverUserId: user.id,
          legs: [{ walletId: card.wallet_id, direction: 'debit', amount: w.balance }, { walletId: main.id, direction: 'credit', amount: w.balance }],
        });
      }
      await c.query("UPDATE cards SET status='terminated' WHERE id=$1", [card.id]);
      await c.query("UPDATE wallets SET status='closed' WHERE id=$1", [card.wallet_id]);
    });
    return { message: 'Card terminated' };
  },
});

route({
  method: 'post', path: '/cards/:id/simulate-spend', tags: T, auth: 'user', summary: '[Sandbox only] Simulate a merchant charge on the card',
  body: z.object({ amount: amountSchema, merchant: z.string().default('Sandbox Store') }),
  handler: async ({ params, body, user }) => {
    if (config.isProd) throw new AppError(403, 'sandbox_only', 'Not available in production');
    const card = await ownCard(params.id, user.id);
    return created(await postCardSpend({ cardId: card.id, amount: body.amount, merchant: body.merchant, reference: 'SIM' + randomDigits(12) }));
  },
});

export { pool, currencySchema, formatMoney, notify, crypto };
