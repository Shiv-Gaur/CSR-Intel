import 'dotenv/config';
import { upsertEntity, getPool } from '../src/db/index.js';
import { logger } from '../src/utils/logger.js';

const SEED_ENTITIES = [
  { name: 'Tata Consultancy Services', category: 'company', priority: 1, status: 'stub' },
  { name: 'Reliance Foundation', category: 'foundation', priority: 1, status: 'stub' },
  { name: 'Infosys Foundation', category: 'foundation', priority: 1, status: 'stub' }
];

async function seed() {
  logger.info('Seeding initial stubs...');
  for (const entity of SEED_ENTITIES) {
    const id = await upsertEntity(entity);
    logger.info(`Seeded ${entity.name} with ID ${id}`);
  }
  logger.info('Seeding complete.');
  process.exit(0);
}

seed().catch(err => {
  logger.error('Seeding failed', err);
  process.exit(1);
});
