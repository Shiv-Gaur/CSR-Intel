import 'dotenv/config';
import { runMigrations } from '../src/db/index.js';
import { logger } from '../src/utils/logger.js';

(async () => {
  logger.info('Running database migrations...');
  await runMigrations();
  logger.info('Migrations complete. Database is ready.');
  process.exit(0);
})().catch(err => {
  logger.error('Migration failed', { err });
  process.exit(1);
});
