import { one, tx } from '../db';
import { AppError, notFound } from '../lib/errors';
import { postTransaction, systemWallet } from './ledger';
import { formatMoney, notify } from './notify';

/** Authorizes + settles a card purchase against the card wallet. Used by the issuer webhook and the sandbox simulator. */
export async function postCardSpend(p: { cardId: string; amount: number; merchant: string; reference: string }) {
  const existing = await one<any>('SELECT * FROM transactions WHERE external_reference=$1', [p.reference]);
  if (existing) return existing;
  const t = await tx(async (c) => {
    const card = await one<any>('SELECT * FROM cards WHERE id=$1', [p.cardId], c);
    if (!card) throw notFound('Card not found');
    if (card.status !== 'active') throw new AppError(422, 'card_not_active', `Card is ${card.status}`);
    if (card.spend_limit && p.amount > card.spend_limit) throw new AppError(422, 'card_limit_exceeded', 'Amount exceeds the card spend limit');
    const sys = await systemWallet(c, 'CARDS', card.currency);
    return postTransaction(c, {
      type: 'card_spend', category: 'shopping', currency: card.currency, amount: p.amount, externalReference: p.reference,
      narration: `Card •••• ${card.last4} at ${p.merchant}`, senderWalletId: card.wallet_id, receiverWalletId: sys.id, senderUserId: card.user_id,
      counterparty: { name: p.merchant }, meta: { card_id: card.id },
      legs: [{ walletId: card.wallet_id, direction: 'debit', amount: p.amount }, { walletId: sys.id, direction: 'credit', amount: p.amount }],
    });
  });
  await notify(t.sender_user_id!, { type: 'transaction', title: 'Card payment', body: `${formatMoney(p.amount, t.currency)} spent at ${p.merchant}.`, data: { transaction_id: t.id } });
  return t;
}
