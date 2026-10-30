import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Api, client, fund, registerUser, setup, sign } from './helpers';

let ctx: Awaited<ReturnType<typeof setup>>;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.close(); });

const balance = async (api: Api, id: string) => (await api.get(`/wallets/${id}`)).body.data.balance as number;

describe('auth', () => {
  it('registers, rejects duplicates and weak passwords, verifies OTP', async () => {
    const anon = client(ctx.base);
    const weak = await anon.post('/auth/register', { first_name: 'A', last_name: 'B', email: 'a@b.co', phone: '08031234567', password: 'short' });
    assert.equal(weak.status, 422);
    assert.equal(weak.body.error.code, 'validation_error');

    const u = await registerUser(ctx.base, { verify: false });
    const dup = await anon.post('/auth/register', { first_name: 'A', last_name: 'B', email: u.email, phone: '08099999999', password: 'Passw0rd!x' });
    assert.equal(dup.status, 409);

    const bad = await u.api.post('/auth/verify-phone', { code: '000000' });
    assert.equal(bad.status, 400);
    assert.equal((await u.api.get('/users/me')).body.data.phone_verified, false);
  });

  it('logs in, rotates refresh tokens, detects reuse, logs out', async () => {
    const u = await registerUser(ctx.base);
    const anon = client(ctx.base);
    assert.equal((await anon.post('/auth/login', { identifier: u.email, password: 'wrong' })).status, 401);
    const login = await anon.post('/auth/login', { identifier: u.phone, password: 'Passw0rd!x', device_name: 'Chrome' });
    assert.equal(login.status, 200);
    const r1 = await anon.post('/auth/refresh', { refresh_token: login.body.data.refresh_token });
    assert.equal(r1.status, 200);
    const reuse = await anon.post('/auth/refresh', { refresh_token: login.body.data.refresh_token });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.error.code, 'refresh_reuse');
    // reuse detection revoked everything, including the new token
    assert.equal((await anon.post('/auth/refresh', { refresh_token: r1.body.data.refresh_token })).status, 401);
    assert.equal((await client(ctx.base, login.body.data.access_token).get('/users/me')).status, 401);
  });

  it('locks the account after repeated failures and supports password reset', async () => {
    const u = await registerUser(ctx.base);
    const anon = client(ctx.base);
    for (let i = 0; i < 5; i++) await anon.post('/auth/login', { identifier: u.email, password: 'nope' });
    const locked = await anon.post('/auth/login', { identifier: u.email, password: 'Passw0rd!x' });
    assert.equal(locked.status, 429);

    const v = await registerUser(ctx.base);
    const f = await anon.post('/auth/forgot-password', { identifier: v.email });
    const reset = await anon.post('/auth/reset-password', { identifier: v.email, code: f.body.data.dev_otp, new_password: 'NewPassw0rd!' });
    assert.equal(reset.status, 200);
    assert.equal((await anon.post('/auth/login', { identifier: v.email, password: 'NewPassw0rd!' })).status, 200);
    assert.equal((await v.api.get('/users/me')).status, 401, 'old sessions revoked');
  });

  it('locks the PIN after 3 wrong attempts', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    const b = await registerUser(ctx.base);
    await fund(a.api, a.wallet.id, 100_000);
    for (let i = 0; i < 3; i++) {
      const r = await a.api.pay('/transfers/internal', { to: { account_number: b.wallet.account_number }, amount: 1000, pin: '9999' });
      assert.equal(r.status, 403);
    }
    const r = await a.api.pay('/transfers/internal', { to: { account_number: b.wallet.account_number }, amount: 1000, pin: a.pin });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'pin_locked');
  });
});

describe('wallets & internal transfers', () => {
  it('funds a wallet via signed webhook, idempotently, and rejects bad signatures', async () => {
    const u = await registerUser(ctx.base);
    const payload = JSON.stringify({ event: 'deposit.success', data: { reference: 'BANKREF' + Date.now(), account_number: u.wallet.account_number, amount: 500_000, sender_name: 'Jane Doe' } });
    const raw = (path: string, sig: string) => fetch(ctx.base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: payload });
    assert.equal((await raw('/webhooks/psp', 'bad')).status, 401);
    assert.equal((await raw('/webhooks/psp', sign(payload))).status, 200);
    const again = await (await raw('/webhooks/psp', sign(payload))).json() as any;
    assert.equal(again.data.duplicate, true);
    assert.equal(await balance(u.api, u.wallet.id), 500_000);
  });

  it('sends money between users, enforces PIN, balance, idempotency and keeps the ledger balanced', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    const b = await registerUser(ctx.base);
    await fund(a.api, a.wallet.id, 1_000_000);

    const body = { to: { account_number: b.wallet.account_number }, amount: 250_000, pin: a.pin, narration: 'Lunch' };
    assert.equal((await a.api.post('/transfers/internal', body)).status, 400, 'Idempotency-Key required');
    assert.equal((await a.api.pay('/transfers/internal', { ...body, pin: '0000' })).status, 403);

    const key = randomUUID();
    const t1 = await a.api.pay('/transfers/internal', body, key);
    assert.equal(t1.status, 201);
    const t2 = await a.api.pay('/transfers/internal', body, key);
    assert.equal(t2.status, 201);
    assert.equal(t2.headers.get('idempotent-replay'), 'true');
    assert.equal(t2.body.data.id, t1.body.data.id);
    assert.equal((await a.api.pay('/transfers/internal', { ...body, amount: 1 }, key)).status, 422, 'key reuse w/ different body');

    assert.equal(await balance(a.api, a.wallet.id), 750_000);
    assert.equal(await balance(b.api, b.wallet.id), 250_000);

    const over = await a.api.pay('/transfers/internal', { ...body, amount: 9_000_000 });
    assert.equal(over.status, 422);
    const self = await a.api.pay('/transfers/internal', { ...body, to: { account_number: a.wallet.account_number } });
    assert.equal(self.body.error.code, 'self_transfer');

    // paytag & phone addressing
    const byTag = await a.api.pay('/transfers/internal', { to: { paytag: '@' + b.user.paytag }, amount: 1000, pin: a.pin });
    assert.equal(byTag.status, 201);

    const hist = await b.api.get('/transactions?direction=credit');
    assert.equal(hist.body.meta.total, 2);
    assert.equal(hist.body.data[0].direction, 'credit');
    const receipt = await a.api.get(`/transactions/${t1.body.data.reference}/receipt`);
    assert.equal(receipt.body.data.direction, 'debit');
  });

  it('never double-spends under concurrent transfers', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    const b = await registerUser(ctx.base);
    await fund(a.api, a.wallet.id, 1_000_000);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      a.api.pay('/transfers/internal', { to: { account_number: b.wallet.account_number }, amount: 300_000, pin: a.pin })));
    const ok = results.filter((r) => r.status === 201).length;
    assert.equal(ok, 3);
    assert.equal(await balance(a.api, a.wallet.id), 100_000);
    assert.equal(await balance(b.api, b.wallet.id), 900_000);
  });

  it('enforces KYC tier limits and unlocks with BVN', async () => {
    const a = await registerUser(ctx.base);
    const b = await registerUser(ctx.base);
    await fund(a.api, a.wallet.id, 5_000_000);
    const tooBig = await a.api.pay('/transfers/internal', { to: { account_number: b.wallet.account_number }, amount: 3_000_000, pin: a.pin });
    assert.equal(tooBig.body.error.code, 'tier_single_limit_exceeded');
    assert.equal((await a.api.post('/kyc/bvn', { bvn: '01234567890' })).status, 422);
    assert.equal((await a.api.post('/kyc/bvn', { bvn: '22345678901' })).status, 200);
    assert.equal((await a.api.get('/users/me')).body.data.kyc_tier, 1);
    assert.equal((await a.api.pay('/transfers/internal', { to: { account_number: b.wallet.account_number }, amount: 3_000_000, pin: a.pin })).status, 201);
    const lim = await a.api.get('/users/me/limits');
    assert.equal(lim.body.data.used_today, 3_000_000);
  });
});

describe('bank transfers', () => {
  it('charges a fee, succeeds, and refunds on provider failure', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    await fund(a.api, a.wallet.id, 1_000_000);
    const ok = await a.api.pay('/transfers/bank', { bank_code: '058', account_number: '0123456789', amount: 100_000, pin: a.pin, save_beneficiary: true });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.status, 'success');
    assert.equal(ok.body.data.fee, 1000);
    assert.equal(await balance(a.api, a.wallet.id), 1_000_000 - 100_000 - 1000);
    assert.equal((await a.api.get('/beneficiaries')).body.data.length, 1);

    const fail = await a.api.pay('/transfers/bank', { bank_code: '058', account_number: '1230000000'.slice(0, 6) + '0000', amount: 50_000, pin: a.pin });
    assert.equal(fail.status, 422);
    assert.equal(fail.body.error.code, 'transfer_failed');
    assert.equal(await balance(a.api, a.wallet.id), 1_000_000 - 100_000 - 1000, 'refunded in full');

    const unknown = await a.api.pay('/transfers/bank', { bank_code: '058', account_number: '0012345678', amount: 50_000, pin: a.pin });
    assert.equal(unknown.body.error.code, 'account_not_found');
  });

  it('keeps pending transfers pending until the webhook settles them', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    await fund(a.api, a.wallet.id, 500_000);
    const p = await a.api.pay('/transfers/bank', { bank_code: '044', account_number: '1234569999', amount: 100_000, pin: a.pin });
    assert.equal(p.body.data.status, 'pending');
    const payload = JSON.stringify({ event: 'transfer.failed', data: { reference: p.body.data.reference, message: 'timeout' } });
    const res = await fetch(ctx.base + '/webhooks/psp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sign(payload) }, body: payload });
    assert.equal(res.status, 200);
    assert.equal(await balance(a.api, a.wallet.id), 500_000);
    assert.equal((await a.api.get(`/transactions/${p.body.data.id}`)).body.data.status, 'failed');
  });
});

describe('bills, cards, savings, exchange, requests', () => {
  it('buys airtime, electricity token and data; refunds failures', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    await fund(a.api, a.wallet.id, 1_000_000);
    const air = await a.api.pay('/bills/pay', { provider_code: 'MTN-AIRTIME', customer_ref: '08031234567', amount: 50_000, pin: a.pin });
    assert.equal(air.status, 201);
    const elec = await a.api.pay('/bills/pay', { provider_code: 'IKEDC-PREPAID', customer_ref: '12345678901', amount: 200_000, pin: a.pin });
    assert.match(elec.body.data.token, /^\d{4}(-\d{4}){4}$/);
    const data = await a.api.pay('/bills/pay', { provider_code: 'GLO-DATA', customer_ref: '08051234567', plan_code: 'GLO-DATA-2GB-7D', pin: a.pin });
    assert.equal(data.body.data.transaction.amount, 50_000);
    const bad = await a.api.pay('/bills/pay', { provider_code: 'MTN-AIRTIME', customer_ref: '08030000000', amount: 10_000, pin: a.pin });
    assert.equal(bad.status, 422);
    assert.equal(await balance(a.api, a.wallet.id), 1_000_000 - 50_000 - 200_000 - 50_000);
    assert.equal((await a.api.get('/transactions/summary')).body.data.spending_by_category.length, 3);
  });

  it('creates a virtual card, funds it, reveals with PIN, spends, freezes', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    await fund(a.api, a.wallet.id, 1_000_000);
    const c = await a.api.pay('/cards', { label: 'Netflix', currency: 'NGN', pin: a.pin });
    assert.equal(c.status, 201);
    assert.ok(!('pan' in c.body.data));
    const id = c.body.data.id;
    assert.equal(await balance(a.api, a.wallet.id), 1_000_000 - 100_000, 'creation fee');
    assert.equal((await a.api.pay(`/cards/${id}/fund`, { amount: 300_000, pin: a.pin })).status, 201);
    const rev = await a.api.post(`/cards/${id}/reveal`, { pin: a.pin });
    assert.match(rev.body.data.pan, /^\d{16}$/);
    assert.equal(rev.body.data.pan.slice(-4), c.body.data.last4);
    assert.equal((await a.api.post(`/cards/${id}/simulate-spend`, { amount: 120_000, merchant: 'Netflix' })).status, 201);
    assert.equal((await a.api.get(`/cards/${id}`)).body.data.balance, 180_000);
    await a.api.post(`/cards/${id}/freeze`);
    assert.equal((await a.api.post(`/cards/${id}/simulate-spend`, { amount: 1000, merchant: 'X' })).status, 422);
    assert.equal((await a.api.del(`/cards/${id}`)).status, 200);
    assert.equal(await balance(a.api, a.wallet.id), 1_000_000 - 100_000 - 300_000 + 180_000);
  });

  it('manages savings pockets with locks and interest', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    await fund(a.api, a.wallet.id, 1_000_000);
    const flex = await a.api.post('/savings', { name: 'Rainy day', type: 'flexible' });
    const lock = await a.api.post('/savings', { name: 'Car', type: 'locked', locked_until: new Date(Date.now() + 86400_000 * 30).toISOString() });
    assert.equal((await a.api.pay(`/savings/${flex.body.data.id}/deposit`, { amount: 400_000, pin: a.pin })).status, 201);
    assert.equal((await a.api.pay(`/savings/${lock.body.data.id}/deposit`, { amount: 100_000, pin: a.pin })).status, 201);
    assert.equal((await a.api.pay(`/savings/${lock.body.data.id}/withdraw`, { amount: 1000, pin: a.pin })).body.error.code, 'pocket_locked');
    const adminLogin = await client(ctx.base).post('/auth/login', { identifier: 'admin@pulsepay.test', password: 'Admin#12345' });
    const admin = client(ctx.base, adminLogin.body.data.access_token);
    const job = await admin.post('/admin/jobs/accrue-interest');
    assert.ok(job.body.data.pockets_credited >= 2);
    assert.equal((await admin.post('/admin/jobs/accrue-interest')).body.data.pockets_credited, 0, 'idempotent per day');
    assert.ok((await a.api.get(`/savings/${flex.body.data.id}`)).body.data.balance > 400_000);
    assert.equal((await a.api.pay(`/savings/${flex.body.data.id}/withdraw`, { amount: 100_000, pin: a.pin })).status, 201);
  });

  it('converts currencies via the FX system wallets', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    await fund(a.api, a.wallet.id, 3_000_000);
    const q = await a.api.get('/exchange/quote?from=NGN&to=USD&amount=1500000');
    assert.equal(q.body.data.received, Math.floor(1_500_000 * (1 / 1500) * 0.99));
    const ex = await a.api.pay('/exchange', { from: 'NGN', to: 'USD', amount: 1_500_000, pin: a.pin });
    assert.equal(ex.status, 201);
    const wallets = (await a.api.get('/wallets')).body.data;
    assert.equal(wallets.find((w: any) => w.currency === 'USD').balance, q.body.data.received);
  });

  it('handles payment requests between users', async () => {
    const a = await registerUser(ctx.base, { tier1: true });
    const b = await registerUser(ctx.base, { tier1: true });
    await fund(b.api, b.wallet.id, 500_000);
    const r = await a.api.post('/payment-requests', { from: { paytag: b.user.paytag }, amount: 120_000, note: 'Dinner' });
    assert.equal(r.status, 201);
    assert.equal((await b.api.get('/payment-requests?role=received')).body.data.length, 1);
    assert.equal((await b.api.pay(`/payment-requests/${r.body.data.id}/pay`, { pin: b.pin })).status, 201);
    assert.equal(await balance(a.api, a.wallet.id), 120_000);
    assert.equal((await b.api.pay(`/payment-requests/${r.body.data.id}/pay`, { pin: b.pin })).status, 409);
  });
});

describe('admin & integrity', () => {
  it('guards admin routes, reviews KYC, reverses a transaction and the ledger stays balanced', async () => {
    const u = await registerUser(ctx.base, { tier1: true });
    const peer = await registerUser(ctx.base);
    assert.equal((await u.api.get('/admin/overview')).status, 403);

    await fund(u.api, u.wallet.id, 600_000);
    const t = await u.api.pay('/transfers/internal', { to: { account_number: peer.wallet.account_number }, amount: 200_000, pin: u.pin });

    const adminLogin = await client(ctx.base).post('/auth/login', { identifier: 'admin@pulsepay.test', password: 'Admin#12345' });
    const admin = client(ctx.base, adminLogin.body.data.access_token);

    const doc = await u.api.post('/kyc/id-document', { document_type: 'passport', document_number: 'A12345678', front_image_url: 'https://x.io/f.jpg', selfie_url: 'https://x.io/s.jpg' });
    assert.equal(doc.status, 201);
    const q = await admin.get('/admin/kyc?status=pending');
    const item = q.body.data.find((k: any) => k.id === doc.body.data.id);
    assert.ok(item);
    assert.equal((await admin.post(`/admin/kyc/${item.id}/review`, { decision: 'approve' })).status, 200);
    assert.equal((await u.api.get('/users/me')).body.data.kyc_tier, 2);

    const rev = await admin.post(`/admin/transactions/${t.body.data.id}/reverse`, { reason: 'customer dispute' });
    assert.equal(rev.status, 201);
    assert.equal(await balance(u.api, u.wallet.id), 600_000);
    assert.equal(await balance(peer.api, peer.wallet.id), 0);
    assert.equal((await admin.post(`/admin/transactions/${t.body.data.id}/reverse`, { reason: 'again' })).status, 422);

    const sus = await admin.patch(`/admin/users/${u.user.id}/status`, { status: 'suspended', reason: 'fraud review' });
    assert.equal(sus.status, 200);
    assert.equal((await u.api.get('/users/me')).status, 401, 'sessions revoked');

    const integrity = await admin.get('/admin/ledger/integrity');
    assert.equal(integrity.body.data.ok, true, JSON.stringify(integrity.body.data));
    assert.ok((await admin.get('/admin/audit-logs')).body.data.length > 0);
  });

  it('serves a valid OpenAPI document covering the whole API', async () => {
    const res = await fetch(ctx.base + '/openapi.json');
    const doc = await res.json() as any;
    assert.equal(doc.openapi, '3.0.3');
    assert.ok(Object.keys(doc.paths).length > 60);
    assert.ok(doc.paths['/transfers/bank'].post.requestBody);
  });
});
