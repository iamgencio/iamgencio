process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5432/pulsepay_test';
process.env.EXPOSE_DEV_OTP = 'true';

import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function setup() {
  const { pool } = await import('../src/db');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { migrate } = await import('../src/migrate');
  await migrate();
  const { ensureAdmin } = await import('../src/services/bootstrap');
  await ensureAdmin();
  const { createApp } = await import('../src/app');
  const server: Server = await new Promise((res) => { const s = createApp().listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return {
    pool, base,
    async close() { server.close(); await pool.end(); },
  };
}

export type Api = ReturnType<typeof client>;
export function client(base: string, token?: string) {
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown, h?: Record<string, string>) => call('POST', p, b ?? {}, h),
    // money-moving POST with a fresh idempotency key
    pay: (p: string, b?: unknown, key = randomUUID()) => call('POST', p, b ?? {}, { 'Idempotency-Key': key }),
    patch: (p: string, b?: unknown) => call('PATCH', p, b ?? {}),
    del: (p: string) => call('DELETE', p),
    token,
  };
}

let n = 0;
export async function registerUser(base: string, opts: { verify?: boolean; pin?: string; tier1?: boolean } = {}) {
  n++;
  const anon = client(base);
  const r = await anon.post('/auth/register', {
    first_name: 'Test', last_name: `User${n}`, email: `user${n}_${Date.now()}@example.com`,
    phone: `0803${String(1000000 + n).slice(-7)}`, password: 'Passw0rd!x', paytag: `tester${n}x${Date.now() % 10000}`,
  });
  if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r.body));
  const d = r.body.data;
  const api = client(base, d.access_token);
  if (opts.verify !== false) {
    const v = await api.post('/auth/verify-phone', { code: d.dev_otps.phone });
    if (v.status !== 200) throw new Error('verify failed ' + JSON.stringify(v.body));
    await api.post('/auth/verify-email', { code: d.dev_otps.email });
  }
  const pin = opts.pin ?? '1234';
  if (opts.verify !== false) {
    const p = await api.post('/auth/pin', { pin, password: 'Passw0rd!x' });
    if (p.status !== 200) throw new Error('pin failed ' + JSON.stringify(p.body));
  }
  if (opts.tier1) {
    const k = await api.post('/kyc/bvn', { bvn: '1' + String(Date.now() * 100 + n).slice(-10) });
    if (k.status !== 200) throw new Error('kyc failed ' + JSON.stringify(k.body));
  }
  const wallet = (await api.get('/wallets')).body.data[0];
  return { api, user: d.user, wallet, pin, refresh: d.refresh_token, email: r.body.data.user.email, phone: r.body.data.user.phone };
}

export async function fund(api: Api, walletId: string, amount: number) {
  const r = await api.post(`/wallets/${walletId}/simulate-deposit`, { amount });
  if (r.status !== 201) throw new Error('fund failed ' + JSON.stringify(r.body));
  return r.body.data;
}

export const sign = (raw: string) => createHmac('sha256', process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret').update(raw).digest('hex');
