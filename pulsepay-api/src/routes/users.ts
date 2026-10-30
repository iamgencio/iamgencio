import { z } from 'zod';
import { one, pool, query } from '../db';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { pageMeta, pageQuery, offset } from '../lib/util';
import { paged, route } from '../http/registry';
import { publicUser } from '../services/auth';
import { tierOf } from '../services/limits';
import { toNgn } from '../services/ledger';
import { audit } from '../services/audit';
import { config } from '../config';
import { checkPassword } from '../services/auth';

const T = ['Users'];

route({ method: 'get', path: '/users/me', tags: T, auth: 'user', summary: 'Current user profile',
  handler: async ({ user }) => publicUser(await one('SELECT * FROM users WHERE id=$1', [user.id])) });

route({
  method: 'patch', path: '/users/me', tags: T, auth: 'user', summary: 'Update profile',
  body: z.object({
    first_name: z.string().trim().min(1).max(60).optional(),
    last_name: z.string().trim().min(1).max(60).optional(),
    date_of_birth: z.iso.date().optional(),
    avatar_url: z.url().optional(),
    address: z.object({
      line1: z.string().max(200), line2: z.string().max(200).optional(), city: z.string().max(100),
      state: z.string().max(100), country: z.string().length(2).default('NG'), postal_code: z.string().max(20).optional(),
    }).optional(),
    notification_prefs: z.object({ email: z.boolean(), sms: z.boolean(), push: z.boolean() }).optional(),
  }),
  handler: async ({ body, user }) => {
    const u = await one(
      `UPDATE users SET first_name=COALESCE($2,first_name), last_name=COALESCE($3,last_name), date_of_birth=COALESCE($4,date_of_birth),
         avatar_url=COALESCE($5,avatar_url), address=COALESCE($6,address), notification_prefs=COALESCE($7,notification_prefs), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [user.id, body.first_name ?? null, body.last_name ?? null, body.date_of_birth ?? null, body.avatar_url ?? null,
        body.address ? JSON.stringify(body.address) : null, body.notification_prefs ? JSON.stringify(body.notification_prefs) : null],
    );
    return publicUser(u);
  },
});

route({
  method: 'put', path: '/users/me/paytag', tags: T, auth: 'user', summary: 'Set or change your PayTag (@handle)',
  body: z.object({ paytag: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{2,19}$/) }),
  handler: async ({ body, user }) => {
    const taken = await one('SELECT 1 FROM users WHERE lower(paytag)=lower($1) AND id<>$2', [body.paytag, user.id]);
    if (taken) throw conflict('PayTag already taken', 'paytag_taken');
    return publicUser(await one('UPDATE users SET paytag=$2, updated_at=now() WHERE id=$1 RETURNING *', [user.id, body.paytag]));
  },
});

route({
  method: 'get', path: '/users/lookup', tags: T, auth: 'user', summary: 'Find a PulsePay user by PayTag, phone or email (public info only)',
  query: z.object({ q: z.string().min(3) }),
  handler: async ({ query: q }) => {
    const { normalizePhone } = await import('../lib/util');
    const term = q.q.replace(/^@/, '');
    const u = await one<any>('SELECT id, first_name, last_name, paytag, avatar_url FROM users WHERE status=\'active\' AND (lower(paytag)=lower($1) OR phone=$2 OR lower(email)=lower($1))', [term, normalizePhone(term)]);
    if (!u) throw notFound('User not found');
    return { id: u.id, name: `${u.first_name} ${u.last_name}`, paytag: u.paytag, avatar_url: u.avatar_url };
  },
});

route({
  method: 'get', path: '/users/me/limits', tags: T, auth: 'user', summary: 'KYC tier, limits and usage today',
  handler: async ({ user }) => {
    const t = tierOf(user.kycTier);
    const rows = await query<any>(
      `SELECT currency, SUM(amount)::bigint total FROM transactions WHERE sender_user_id=$1 AND (receiver_user_id IS NULL OR receiver_user_id<>$1)
        AND status IN ('success','pending') AND type NOT IN ('reversal','interest','adjustment') AND created_at >= date_trunc('day', now()) GROUP BY currency`, [user.id]);
    const used = rows.reduce((s, r) => s + toNgn(Number(r.total), r.currency), 0);
    return {
      tier: user.kycTier, tier_name: t.name, currency: 'NGN',
      single_transaction_limit: t.single, daily_limit: t.daily, max_balance: t.maxBalance === Number.MAX_SAFE_INTEGER ? null : t.maxBalance,
      used_today: used, remaining_today: Math.max(0, t.daily - used),
      next_tier: user.kycTier < 3 ? { tier: user.kycTier + 1, ...config.tiers[user.kycTier + 1] } : null,
    };
  },
});

route({
  method: 'get', path: '/users/me/referrals', tags: T, auth: 'user', summary: 'Referral code and referred users',
  query: pageQuery,
  handler: async ({ user, query: q }) => {
    const me = await one<any>('SELECT referral_code FROM users WHERE id=$1', [user.id]);
    const total = (await one<any>('SELECT count(*)::int n FROM users WHERE referred_by=$1', [user.id]))!.n;
    const rows = await query('SELECT first_name, created_at FROM users WHERE referred_by=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, q.limit, offset(q)]);
    return paged({ referral_code: me.referral_code, referrals: rows }, pageMeta(q, total));
  },
});

route({
  method: 'post', path: '/users/me/close', tags: T, auth: 'user', summary: 'Close your account (balances must be zero)',
  body: z.object({ password: z.string() }),
  handler: async ({ body, user, req }) => {
    if (!(await checkPassword(user.id, body.password))) throw unprocessable('Password is incorrect', 'invalid_password');
    const b = await one<any>("SELECT COALESCE(SUM(balance),0)::bigint n FROM wallets WHERE user_id=$1 AND status<>'closed'", [user.id]);
    if (b.n > 0) throw unprocessable('Withdraw or move all funds before closing your account', 'balance_not_zero');
    await pool.query("UPDATE users SET status='closed', updated_at=now() WHERE id=$1", [user.id]);
    await pool.query("UPDATE wallets SET status='closed' WHERE user_id=$1", [user.id]);
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
    await audit(user.id, 'user.closed', { req });
    return { message: 'Account closed' };
  },
});
