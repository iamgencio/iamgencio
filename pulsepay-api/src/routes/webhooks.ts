import { z } from 'zod';
import { one } from '../db';
import { hmac, safeEqual } from '../lib/crypto';
import { AppError, unauthorized } from '../lib/errors';
import { route, validationError } from '../http/registry';
import { creditDeposit } from '../services/wallets';
import { finalizeBankTransfer } from '../services/transfers';
import { postCardSpend } from '../services/cards';

const T = ['Webhooks'];

function verifySignature(req: any) {
  const sig = req.header('x-signature');
  const raw: Buffer | undefined = req.rawBody;
  if (!sig || !raw || !safeEqual(sig, hmac(raw))) throw unauthorized('Invalid webhook signature', 'invalid_signature');
}

const event = z.discriminatedUnion('event', [
  z.object({ event: z.literal('deposit.success'), data: z.object({
    reference: z.string().min(6), account_number: z.string(), amount: z.number().int().positive(), sender_name: z.string().optional(), sender_bank: z.string().optional(), narration: z.string().optional() }) }),
  z.object({ event: z.enum(['transfer.success', 'transfer.failed']), data: z.object({ reference: z.string(), provider_reference: z.string().optional(), message: z.string().optional() }) }),
  z.object({ event: z.literal('card.charge'), data: z.object({ card_id: z.uuid(), reference: z.string().min(6), amount: z.number().int().positive(), merchant: z.string() }) }),
]);

route({
  method: 'post', path: '/webhooks/psp', tags: T, auth: 'none',
  summary: 'Inbound provider events (HMAC-SHA256 of the raw body in the `x-signature` header, key = WEBHOOK_SECRET)',
  description: 'Handles `deposit.success`, `transfer.success|failed` and `card.charge`. Safe to redeliver: all handlers are idempotent.',
  handler: async ({ req }) => {
    verifySignature(req);
    const parsed = event.safeParse(req.body);
    if (!parsed.success) throw validationError(parsed.error);
    const ev = parsed.data;
    switch (ev.event) {
      case 'deposit.success': {
        const r = await creditDeposit({
          accountNumber: ev.data.account_number, amount: ev.data.amount, externalReference: ev.data.reference,
          senderName: ev.data.sender_name, senderBank: ev.data.sender_bank, narration: ev.data.narration,
        });
        return { processed: true, duplicate: r.duplicate };
      }
      case 'transfer.success':
      case 'transfer.failed': {
        const t = await one<any>("SELECT id FROM transactions WHERE reference=$1 AND type='transfer_bank'", [ev.data.reference]);
        if (!t) throw new AppError(404, 'not_found', 'Unknown transfer reference');
        const out = await finalizeBankTransfer(t.id, {
          status: ev.event === 'transfer.success' ? 'success' : 'failed', reference: ev.data.provider_reference ?? 'WEBHOOK', message: ev.data.message,
        });
        return { processed: true, status: out.status };
      }
      case 'card.charge': {
        const t = await postCardSpend({ cardId: ev.data.card_id, amount: ev.data.amount, merchant: ev.data.merchant, reference: ev.data.reference });
        return { processed: true, transaction_id: t.id };
      }
    }
  },
});
