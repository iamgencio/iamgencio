import { Pool, PoolClient, types } from 'pg';
import { config } from './config';

// BIGINT -> number (all amounts fit in Number.MAX_SAFE_INTEGER by construction).
types.setTypeParser(20, (v) => parseInt(v, 10));
// DATE -> plain string
types.setTypeParser(1082, (v) => v);

export const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });

export type Db = Pick<PoolClient, 'query'>;

export async function query<T = any>(text: string, params: any[] = [], db: Db = pool): Promise<T[]> {
  const res = await db.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: any[] = [], db: Db = pool): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
