import { pool } from '../db';
import { route } from '../http/registry';
import { buildOpenApi } from '../http/openapi';
import { config } from '../config';

route({ method: 'get', path: '/health', tags: ['System'], auth: 'none', summary: 'Liveness', handler: () => ({ status: 'ok', env: config.env, uptime_s: Math.round(process.uptime()) }) });
route({
  method: 'get', path: '/health/ready', tags: ['System'], auth: 'none', summary: 'Readiness (checks the database)',
  handler: async () => { await pool.query('SELECT 1'); return { status: 'ready' }; },
});
route({ method: 'get', path: '/meta/config', tags: ['System'], auth: 'none', summary: 'Public config for clients (currencies, tiers, fee schedule)',
  handler: () => ({ currencies: config.currencies, base_currency: config.baseCurrency, tiers: config.tiers, bank_transfer_fees: config.bankTransferFees, amounts_in: 'minor units' }) });
route({ method: 'get', path: '/openapi.json', tags: ['System'], auth: 'none', summary: 'OpenAPI 3 document', handler: ({ res }) => { res.json(buildOpenApi()); } });
