import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config';
import { one, pool, tx } from '../db';
import { hashPassword, verifyHash } from '../lib/crypto';
import { AppError, conflict, notFound, unauthorized } from '../lib/errors';
import { passwordSchema, phoneSchema, pinSchema } from '../lib/util';
import { created, route } from '../http/registry';
import { createWallet } from '../services/ledger';
import {
  checkPassword, consumeOtp, createSession, findUserByIdentifier, issueOtp, listSessions, newReferralCode, publicUser,
  rotateSession, setPassword,
} from '../services/auth';
import { audit } from '../services/audit';
import { notify } from '../services/notify';

const T = ['Auth'];
const GENERIC_LOGIN_ERROR = 'Invalid credentials';
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

route({
  method: 'post', path: '/auth/register', tags: T, auth: 'none', summary: 'Create an account',
  description: 'Creates the user, their NGN wallet (with a virtual account number) and sends email + phone OTPs. Returns tokens so the app can continue onboarding.',
  body: z.object({
    first_name: z.string().trim().min(1).max(60),
    last_name: z.string().trim().min(1).max(60),
    email: z.email().transform((s) => s.toLowerCase()),
    phone: phoneSchema,
    password: passwordSchema,
    paytag: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{2,19}$/, '3-20 chars, letters/digits/underscore, starts with a letter').optional(),
    referral_code: z.string().optional(),
    device_name: z.string().max(100).optional(),
  }),
  handler: async ({ body, req }) => {
    const result = await tx(async (c) => {
      const dup = await one<any>(
        'SELECT email, phone, paytag FROM users WHERE lower(email)=$1 OR phone=$2 OR ($3::text IS NOT NULL AND lower(paytag)=lower($3))',
        [body.email, body.phone, body.paytag ?? null], c,
      );
      if (dup) {
        const field = dup.email === body.email ? 'email' : dup.phone === body.phone ? 'phone' : 'paytag';
        throw conflict(`This ${field} is already registered`, `${field}_taken`);
      }
      const ref = body.referral_code ? await one<any>('SELECT id FROM users WHERE referral_code=$1', [body.referral_code.toUpperCase()], c) : null;
      const user = await one<any>(
        `INSERT INTO users (email, phone, first_name, last_name, paytag, password_hash, referral_code, referred_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [body.email, body.phone, body.first_name, body.last_name, body.paytag ?? null, await hashPassword(body.password), await newReferralCode(), ref?.id ?? null], c,
      );
      const wallet = await createWallet(c, { userId: user.id, currency: config.baseCurrency, name: 'Main wallet' });
      const emailOtp = await issueOtp(user.id, user.email, 'email', 'verify_email', c);
      const phoneOtp = await issueOtp(user.id, user.phone, 'sms', 'verify_phone', c);
      return { user, wallet, emailOtp, phoneOtp };
    });
    const tokens = await createSession(result.user.id, result.user.role, req, body.device_name);
    await audit(result.user.id, 'auth.register', { req });
    await notify(result.user.id, { type: 'system', title: 'Welcome to PulsePay', body: 'Verify your phone and set your PIN to start sending money.' });
    return created({
      user: publicUser(result.user),
      wallet: { id: result.wallet.id, account_number: result.wallet.account_number, currency: result.wallet.currency },
      ...tokens,
      ...(config.exposeDevOtp ? { dev_otps: { email: result.emailOtp, phone: result.phoneOtp } } : {}),
    });
  },
});

route({
  method: 'post', path: '/auth/login', tags: T, auth: 'none', summary: 'Log in with email/phone/paytag and password',
  body: z.object({ identifier: z.string().min(3), password: z.string().min(1), device_name: z.string().max(100).optional() }),
  handler: async ({ body, req }) => {
    const user = await findUserByIdentifier(body.identifier);
    if (!user) { await verifyHash(body.password, DUMMY_HASH); throw unauthorized(GENERIC_LOGIN_ERROR, 'invalid_credentials'); }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new AppError(429, 'account_locked', `Too many failed attempts. Try again after ${new Date(user.locked_until).toISOString()}`);
    }
    if (!(await verifyHash(body.password, user.password_hash))) {
      const attempts = user.failed_login_attempts + 1;
      const lock = attempts >= config.maxLoginAttempts;
      await pool.query(
        `UPDATE users SET failed_login_attempts=$2, locked_until=${lock ? `now() + interval '${config.loginLockMin} minutes'` : 'NULL'} WHERE id=$1`,
        [user.id, lock ? 0 : attempts],
      );
      await audit(user.id, 'auth.login_failed', { req });
      throw unauthorized(GENERIC_LOGIN_ERROR, 'invalid_credentials');
    }
    if (user.status !== 'active') throw new AppError(403, 'account_' + user.status, 'Account is ' + user.status);
    await pool.query('UPDATE users SET failed_login_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [user.id]);
    const tokens = await createSession(user.id, user.role, req, body.device_name);
    await audit(user.id, 'auth.login', { req });
    await notify(user.id, { type: 'security', title: 'New login', body: `New login to your PulsePay account${body.device_name ? ' from ' + body.device_name : ''}.` });
    return { user: publicUser(user), ...tokens };
  },
});

route({
  method: 'post', path: '/auth/refresh', tags: T, auth: 'none', summary: 'Exchange a refresh token for a new token pair',
  body: z.object({ refresh_token: z.string().min(10) }),
  handler: ({ body, req }) => rotateSession(body.refresh_token, req),
});

route({
  method: 'post', path: '/auth/logout', tags: T, auth: 'user', summary: 'Revoke the current session',
  handler: async ({ user }) => {
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [user.sessionId]);
    return { message: 'Logged out' };
  },
});

route({
  method: 'post', path: '/auth/logout-all', tags: T, auth: 'user', summary: 'Revoke all sessions',
  handler: async ({ user }) => {
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
    return { message: 'All sessions revoked' };
  },
});

route({ method: 'get', path: '/auth/sessions', tags: T, auth: 'user', summary: 'List active sessions/devices',
  handler: async ({ user }) => (await listSessions(user.id)).map((s: any) => ({ ...s, current: s.id === user.sessionId })) });

route({
  method: 'delete', path: '/auth/sessions/:id', tags: T, auth: 'user', summary: 'Revoke a session by id',
  handler: async ({ user, req }) => {
    const r = await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [req.params.id, user.id]);
    if (!r.rowCount) throw notFound('Session not found');
    return { message: 'Session revoked' };
  },
});

route({
  method: 'post', path: '/auth/otp/resend', tags: T, auth: 'user', summary: 'Resend email or phone verification OTP',
  body: z.object({ channel: z.enum(['email', 'phone']) }),
  handler: async ({ body, user }) => {
    const u = await one<any>('SELECT * FROM users WHERE id=$1', [user.id]);
    if (body.channel === 'email') {
      if (u.email_verified_at) throw conflict('Email already verified', 'already_verified');
      return { dev_otp: await issueOtp(u.id, u.email, 'email', 'verify_email') };
    }
    if (u.phone_verified_at) throw conflict('Phone already verified', 'already_verified');
    return { dev_otp: await issueOtp(u.id, u.phone, 'sms', 'verify_phone') };
  },
});

route({
  method: 'post', path: '/auth/verify-email', tags: T, auth: 'user', summary: 'Verify email with OTP',
  body: z.object({ code: z.string().length(6) }),
  handler: async ({ body, user }) => {
    await consumeOtp(user.email, 'verify_email', body.code);
    await pool.query('UPDATE users SET email_verified_at=now(), updated_at=now() WHERE id=$1', [user.id]);
    return { email_verified: true };
  },
});

route({
  method: 'post', path: '/auth/verify-phone', tags: T, auth: 'user', summary: 'Verify phone with OTP',
  body: z.object({ code: z.string().length(6) }),
  handler: async ({ body, user }) => {
    const u = await one<any>('SELECT phone FROM users WHERE id=$1', [user.id]);
    await consumeOtp(u.phone, 'verify_phone', body.code);
    await pool.query('UPDATE users SET phone_verified_at=now(), updated_at=now() WHERE id=$1', [user.id]);
    return { phone_verified: true };
  },
});

route({
  method: 'post', path: '/auth/forgot-password', tags: T, auth: 'none', summary: 'Request a password reset code',
  description: 'Always answers 200 to avoid revealing which accounts exist.',
  body: z.object({ identifier: z.string().min(3) }),
  handler: async ({ body }) => {
    const u = await findUserByIdentifier(body.identifier);
    let dev: string | undefined;
    if (u) dev = await issueOtp(u.id, u.email, 'email', 'reset_password');
    return { message: 'If the account exists, a reset code has been sent.', ...(dev ? { dev_otp: dev } : {}) };
  },
});

route({
  method: 'post', path: '/auth/reset-password', tags: T, auth: 'none', summary: 'Reset password with code',
  body: z.object({ identifier: z.string().min(3), code: z.string().length(6), new_password: passwordSchema }),
  handler: async ({ body, req }) => {
    const u = await findUserByIdentifier(body.identifier);
    if (!u) throw new AppError(400, 'otp_invalid', 'Invalid code');
    await consumeOtp(u.email, 'reset_password', body.code);
    await setPassword(u.id, body.new_password);
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [u.id]);
    await audit(u.id, 'auth.password_reset', { req });
    await notify(u.id, { type: 'security', title: 'Password changed', body: 'Your PulsePay password was reset. If this was not you, contact support immediately.' });
    return { message: 'Password updated. Please log in again.' };
  },
});

route({
  method: 'post', path: '/auth/change-password', tags: T, auth: 'user', summary: 'Change password',
  body: z.object({ current_password: z.string(), new_password: passwordSchema }),
  handler: async ({ body, user, req }) => {
    if (!(await checkPassword(user.id, body.current_password))) throw new AppError(403, 'invalid_password', 'Current password is incorrect');
    await setPassword(user.id, body.new_password);
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id <> $2 AND revoked_at IS NULL', [user.id, user.sessionId]);
    await audit(user.id, 'auth.password_changed', { req });
    await notify(user.id, { type: 'security', title: 'Password changed', body: 'Your password was changed. Other devices were signed out.' });
    return { message: 'Password changed' };
  },
});

route({
  method: 'post', path: '/auth/pin', tags: T, auth: 'user', summary: 'Set the 4-digit transaction PIN (first time)',
  body: z.object({ pin: pinSchema, password: z.string() }),
  handler: async ({ body, user, req }) => {
    if (user.hasPin) throw conflict('PIN already set. Use /auth/pin/change.', 'pin_already_set');
    if (!(await checkPassword(user.id, body.password))) throw new AppError(403, 'invalid_password', 'Password is incorrect');
    await pool.query('UPDATE users SET pin_hash=$2, updated_at=now() WHERE id=$1', [user.id, await hashPassword(body.pin)]);
    await audit(user.id, 'auth.pin_set', { req });
    return { message: 'PIN set' };
  },
});

route({
  method: 'post', path: '/auth/pin/change', tags: T, auth: 'user', summary: 'Change the transaction PIN',
  body: z.object({ old_pin: pinSchema, new_pin: pinSchema }),
  handler: async ({ body, user, req }) => {
    const { verifyPin } = await import('../services/security');
    await verifyPin(user.id, body.old_pin);
    await pool.query('UPDATE users SET pin_hash=$2, updated_at=now() WHERE id=$1', [user.id, await hashPassword(body.new_pin)]);
    await audit(user.id, 'auth.pin_changed', { req });
    await notify(user.id, { type: 'security', title: 'PIN changed', body: 'Your transaction PIN was changed.' });
    return { message: 'PIN changed' };
  },
});

route({
  method: 'post', path: '/auth/pin/reset', tags: T, auth: 'user', summary: 'Reset a forgotten PIN using the account password',
  body: z.object({ password: z.string(), new_pin: pinSchema }),
  handler: async ({ body, user, req }) => {
    if (!(await checkPassword(user.id, body.password))) throw new AppError(403, 'invalid_password', 'Password is incorrect');
    await pool.query('UPDATE users SET pin_hash=$2, pin_attempts=0, pin_locked_until=NULL, updated_at=now() WHERE id=$1', [user.id, await hashPassword(body.new_pin)]);
    await audit(user.id, 'auth.pin_reset', { req });
    return { message: 'PIN reset' };
  },
});
