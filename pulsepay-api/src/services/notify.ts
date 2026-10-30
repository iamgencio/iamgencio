import { Db, one, pool } from '../db';
import { sendEmail, sendSms } from './providers';

export async function notify(
  userId: string,
  n: { type: string; title: string; body: string; data?: Record<string, unknown> },
  db: Db = pool,
) {
  await db.query('INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)', [
    userId, n.type, n.title, n.body, JSON.stringify(n.data ?? {}),
  ]);
  // Fire-and-forget external channels (outside DB transaction semantics on purpose).
  one<any>('SELECT email, phone, notification_prefs FROM users WHERE id=$1', [userId], pool)
    .then((u) => {
      if (!u) return;
      if (u.notification_prefs?.email && ['transaction', 'security'].includes(n.type)) sendEmail(u.email, n.title, n.body);
      if (u.notification_prefs?.sms && n.type === 'security') sendSms(u.phone, n.body);
    })
    .catch(() => undefined);
}

export const formatMoney = (minor: number, currency: string) =>
  `${currency} ${(minor / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
