import { z } from 'zod';
import { config } from '../config';
import { one, query } from '../db';
import { sha256 } from '../lib/crypto';
import { conflict, unprocessable } from '../lib/errors';
import { created, route } from '../http/registry';
import { verifyBvn, verifyNin } from '../services/providers';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { raiseTier } from '../services/kyc';

const T = ['KYC'];
const REQUIREMENTS: string[][] = [
  ['Phone & email registered'],
  ['Phone number verified', 'BVN or NIN verified'],
  ['Tier 1', 'Government ID + selfie approved'],
  ['Tier 2', 'Proof of address approved'],
];

route({
  method: 'get', path: '/kyc', tags: T, auth: 'user', summary: 'KYC status, tiers and submissions',
  handler: async ({ user }) => ({
    current_tier: user.kycTier,
    tiers: Object.entries(config.tiers).map(([tier, t]) => ({
      tier: Number(tier), name: t.name, single_transaction_limit: t.single, daily_limit: t.daily,
      max_balance: t.maxBalance === Number.MAX_SAFE_INTEGER ? null : t.maxBalance,
      requirements: REQUIREMENTS[Number(tier)],
    })),
    submissions: await query('SELECT id, kind, tier_target, status, reason, created_at, reviewed_at FROM kyc_submissions WHERE user_id=$1 ORDER BY created_at DESC', [user.id]),
  }),
});

async function submitIdentity(user: any, kind: 'bvn' | 'nin', value: string, req: any) {
  if (!user.phoneVerified) throw unprocessable('Verify your phone number first', 'phone_not_verified');
  const existing = await one('SELECT 1 FROM kyc_submissions WHERE user_id=$1 AND kind=$2 AND status=\'approved\'', [user.id, kind]);
  if (existing) throw conflict(`${kind.toUpperCase()} already verified`, 'already_verified');
  const dup = await one(`SELECT 1 FROM kyc_submissions WHERE kind=$1 AND status='approved' AND data->>'hash'=$2`, [kind, sha256(value)]);
  if (dup) throw conflict(`This ${kind.toUpperCase()} is linked to another account`, 'identity_in_use');
  const res = kind === 'bvn' ? await verifyBvn(value, user.firstName, user.lastName) : await verifyNin(value);
  const row = await one<any>(
    `INSERT INTO kyc_submissions (user_id, kind, tier_target, data, status, reason) VALUES ($1,$2,1,$3,$4,$5) RETURNING id, kind, status, reason`,
    [user.id, kind, JSON.stringify({ hash: sha256(value), masked: '*******' + value.slice(-4) }), res.verified ? 'approved' : 'rejected', res.reason ?? null],
  );
  await audit(user.id, `kyc.${kind}`, { entity: 'kyc', entityId: row.id, meta: { status: row.status }, req });
  if (res.verified) {
    const tier = await raiseTier(user.id, 1);
    await notify(user.id, { type: 'system', title: 'Identity verified', body: `You are now on KYC Tier ${tier}. Higher limits unlocked.` });
    return { ...row, kyc_tier: tier };
  }
  throw unprocessable(res.reason ?? 'Verification failed', 'kyc_verification_failed');
}

route({ method: 'post', path: '/kyc/bvn', tags: T, auth: 'user', summary: 'Verify BVN (instant) → Tier 1',
  body: z.object({ bvn: z.string().regex(/^\d{11}$/) }), handler: ({ body, user, req }) => submitIdentity(user, 'bvn', body.bvn, req) });
route({ method: 'post', path: '/kyc/nin', tags: T, auth: 'user', summary: 'Verify NIN (instant) → Tier 1',
  body: z.object({ nin: z.string().regex(/^\d{11}$/) }), handler: ({ body, user, req }) => submitIdentity(user, 'nin', body.nin, req) });

route({
  method: 'post', path: '/kyc/id-document', tags: T, auth: 'user', summary: 'Submit a government ID for manual review → Tier 2',
  body: z.object({
    document_type: z.enum(['passport', 'drivers_license', 'voters_card', 'national_id']),
    document_number: z.string().min(5).max(30),
    front_image_url: z.url(),
    back_image_url: z.url().optional(),
    selfie_url: z.url(),
  }),
  handler: async ({ body, user, req }) => {
    if (user.kycTier < 1) throw unprocessable('Complete Tier 1 (BVN/NIN) first', 'kyc_tier_required');
    if (await one("SELECT 1 FROM kyc_submissions WHERE user_id=$1 AND kind='id_document' AND status='pending'", [user.id])) throw conflict('A document is already under review', 'review_pending');
    const row = await one<any>(
      `INSERT INTO kyc_submissions (user_id, kind, tier_target, data) VALUES ($1,'id_document',2,$2) RETURNING id, kind, status`,
      [user.id, JSON.stringify({ document_type: body.document_type, document_number_masked: '***' + body.document_number.slice(-3), front: body.front_image_url, back: body.back_image_url, selfie: body.selfie_url })],
    );
    await audit(user.id, 'kyc.id_document', { entity: 'kyc', entityId: row.id, req });
    return created(row);
  },
});

route({
  method: 'post', path: '/kyc/address', tags: T, auth: 'user', summary: 'Submit proof of address for manual review → Tier 3',
  body: z.object({
    address: z.object({ line1: z.string().max(200), city: z.string().max(100), state: z.string().max(100), country: z.string().length(2).default('NG') }),
    proof_url: z.url(),
  }),
  handler: async ({ body, user, req }) => {
    if (user.kycTier < 2) throw unprocessable('Complete Tier 2 first', 'kyc_tier_required');
    if (await one("SELECT 1 FROM kyc_submissions WHERE user_id=$1 AND kind='address_proof' AND status='pending'", [user.id])) throw conflict('Proof of address already under review', 'review_pending');
    const row = await one<any>(
      `INSERT INTO kyc_submissions (user_id, kind, tier_target, data) VALUES ($1,'address_proof',3,$2) RETURNING id, kind, status`,
      [user.id, JSON.stringify({ address: body.address, proof: body.proof_url })],
    );
    await audit(user.id, 'kyc.address', { entity: 'kyc', entityId: row.id, req });
    return created(row);
  },
});
