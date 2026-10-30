import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { sha256 } from '../lib/crypto';
import { AppError, badRequest, conflict } from '../lib/errors';
import { AuthUser } from './auth';

/**
 * Money-moving endpoints require an `Idempotency-Key` header. The first request with a key is executed and
 * its response stored; replays with the same body return the stored response; a different body is rejected.
 */
export async function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.header('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 100) {
    throw badRequest('Idempotency-Key header (8-100 chars) is required for this endpoint', undefined, 'idempotency_key_required');
  }
  const user = (req as any).user as AuthUser;
  const hash = sha256(`${req.method}:${req.baseUrl}${req.path}:${JSON.stringify(req.body ?? {})}`);
  const ins = await pool.query(
    'INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [user.id, key, hash],
  );
  if (!ins.rowCount) {
    const { rows } = await pool.query('SELECT * FROM idempotency_keys WHERE user_id=$1 AND key=$2', [user.id, key]);
    const row = rows[0];
    if (row.request_hash !== hash) throw new AppError(422, 'idempotency_key_reuse', 'Idempotency-Key was already used with a different request');
    if (row.status_code == null) throw conflict('A request with this Idempotency-Key is still being processed', 'idempotency_in_progress');
    res.setHeader('Idempotent-Replay', 'true');
    res.status(row.status_code).json(row.response);
    return;
  }

  // capture the response
  const origJson = res.json.bind(res);
  res.json = ((body: any) => {
    const ok = res.statusCode < 400;
    const p = ok
      ? pool.query('UPDATE idempotency_keys SET status_code=$3, response=$4 WHERE user_id=$1 AND key=$2', [user.id, key, res.statusCode, JSON.stringify(body)])
      : pool.query('DELETE FROM idempotency_keys WHERE user_id=$1 AND key=$2', [user.id, key]); // failures can be retried with the same key
    // persist before answering so an immediate replay always finds the stored response
    p.catch(() => undefined).then(() => origJson(body));
    return res;
  }) as any;
  next();
}
