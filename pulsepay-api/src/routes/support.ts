import { z } from 'zod';
import { one, query } from '../db';
import { forbidden, notFound } from '../lib/errors';
import { offset, pageMeta, pageQuery } from '../lib/util';
import { created, paged, route } from '../http/registry';

const T = ['Support'];

route({
  method: 'post', path: '/support/tickets', tags: T, auth: 'user', summary: 'Open a support ticket',
  body: z.object({ subject: z.string().min(3).max(150), category: z.enum(['general', 'transaction', 'account', 'card', 'kyc']).default('general'), message: z.string().min(5).max(4000) }),
  handler: async ({ body, user }) => {
    const t = await one<any>('INSERT INTO support_tickets (user_id, subject, category) VALUES ($1,$2,$3) RETURNING *', [user.id, body.subject, body.category]);
    await query('INSERT INTO support_messages (ticket_id, author_id, body) VALUES ($1,$2,$3)', [t.id, user.id, body.message]);
    return created(t);
  },
});
route({
  method: 'get', path: '/support/tickets', tags: T, auth: 'user', summary: 'My tickets', query: pageQuery,
  handler: async ({ user, query: q }) => {
    const total = (await one<any>('SELECT count(*)::int n FROM support_tickets WHERE user_id=$1', [user.id]))!.n;
    return paged(await query('SELECT * FROM support_tickets WHERE user_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3', [user.id, q.limit, offset(q)]), pageMeta(q, total));
  },
});

async function ticketFor(id: string, user: { id: string; role: string }) {
  const t = await one<any>('SELECT * FROM support_tickets WHERE id=$1', [id]);
  if (!t) throw notFound('Ticket not found');
  if (t.user_id !== user.id && user.role === 'user') throw forbidden();
  return t;
}
route({
  method: 'get', path: '/support/tickets/:id', tags: T, auth: 'user', summary: 'Ticket with messages',
  handler: async ({ params, user }) => {
    const t = await ticketFor(params.id, user);
    const messages = await query(
      `SELECT m.id, m.body, m.created_at, m.author_id, (u.role <> 'user') AS from_staff FROM support_messages m JOIN users u ON u.id=m.author_id WHERE ticket_id=$1 ORDER BY m.created_at`, [t.id]);
    return { ...t, messages };
  },
});
route({
  method: 'post', path: '/support/tickets/:id/messages', tags: T, auth: 'user', summary: 'Reply on a ticket',
  body: z.object({ body: z.string().min(1).max(4000) }),
  handler: async ({ params, body, user }) => {
    const t = await ticketFor(params.id, user);
    await query('INSERT INTO support_messages (ticket_id, author_id, body) VALUES ($1,$2,$3)', [t.id, user.id, body.body]);
    const staff = user.role !== 'user';
    await query("UPDATE support_tickets SET updated_at=now(), status=CASE WHEN $2 THEN 'pending' ELSE 'open' END WHERE id=$1", [t.id, staff]);
    return created({ ok: true });
  },
});
