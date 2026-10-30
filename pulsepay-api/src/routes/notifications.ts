import { z } from 'zod';
import { one, pool, query } from '../db';
import { notFound } from '../lib/errors';
import { offset, pageMeta, pageQuery } from '../lib/util';
import { paged, route } from '../http/registry';

const T = ['Notifications'];

route({
  method: 'get', path: '/notifications', tags: T, auth: 'user', summary: 'In-app notifications',
  query: pageQuery.extend({ unread: z.enum(['true', 'false']).optional() }),
  handler: async ({ user, query: q }) => {
    const only = q.unread === 'true';
    const total = (await one<any>(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 ${only ? 'AND read_at IS NULL' : ''}`, [user.id]))!.n;
    const unread = (await one<any>('SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id]))!.n;
    const rows = await query(`SELECT * FROM notifications WHERE user_id=$1 ${only ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [user.id, q.limit, offset(q)]);
    return paged(rows, { ...pageMeta(q, total), unread });
  },
});
route({
  method: 'post', path: '/notifications/read-all', tags: T, auth: 'user', summary: 'Mark all as read',
  handler: async ({ user }) => ({ updated: (await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [user.id])).rowCount }),
});
route({
  method: 'post', path: '/notifications/:id/read', tags: T, auth: 'user', summary: 'Mark one as read',
  handler: async ({ params, user }) => {
    const r = await one('UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING *', [params.id, user.id]);
    if (!r) throw notFound('Notification not found');
    return r;
  },
});
