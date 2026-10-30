import { createApp } from './app';
import { config } from './config';
import { migrate } from './migrate';
import { pool } from './db';
import { logger } from './logger';
import { ensureAdmin } from './services/bootstrap';

async function main() {
  const applied = await migrate();
  if (applied.length) logger.info({ applied }, 'migrations applied');
  await ensureAdmin();
  const app = createApp();
  const server = app.listen(config.port, () => logger.info(`PulsePay API listening on :${config.port} (docs: /docs)`));
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
main().catch((e) => { logger.error(e); process.exit(1); });
