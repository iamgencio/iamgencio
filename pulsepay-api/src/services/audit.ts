import { Request } from 'express';
import { Db, pool } from '../db';

export async function audit(
  actorId: string | null,
  action: string,
  p: { entity?: string; entityId?: string; meta?: Record<string, unknown>; req?: Request } = {},
  db: Db = pool,
) {
  await db.query('INSERT INTO audit_logs (actor_id, action, entity, entity_id, ip, meta) VALUES ($1,$2,$3,$4,$5,$6)', [
    actorId, action, p.entity ?? null, p.entityId ?? null, p.req?.ip ?? null, JSON.stringify(p.meta ?? {}),
  ]);
}
