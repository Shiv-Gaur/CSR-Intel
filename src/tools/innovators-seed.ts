// Curated seed innovators (Side B) to exercise the match engine end-to-end.
// Idempotent — insertInnovator upserts on name, safe to re-run.
// CLI: `npm run seed:innovators` (tsx src/tools/innovators-seed.ts)

import 'dotenv/config';
import { insertInnovator, type InnovatorInsert } from '../db/index.js';
import { logger } from '../utils/logger.js';

export const SEED_INNOVATORS: InnovatorInsert[] = [
  {
    name: 'Nepra Resource Management',
    type: 'startup',
    domain: 'plastic',
    description: 'Dry waste management company running the "Let\'s Recycle" platform — collects, segregates and channels plastic and other dry waste into recycling at commercial scale, integrating informal waste pickers into the formal chain.',
    website: 'https://nepra.in',
    contact_email: 'info@nepra.in',
    trl_current: 7,
    trl_target: 9,
    geography: ['Delhi'],
    usp: 'End-to-end dry-waste supply chain with waste-picker inclusion and traceable plastic credit generation.',
    circularity_indicators: { closed_loop: true, zero_waste: true, renewable_energy: false, circular_economy: true },
    ownership_transfer_open: false,
    mou_history: [{ partner: 'Ahmedabad Municipal Corporation', year: '2019', description: 'Dry waste collection and processing' }],
    innovation_stage: 'scale',
    funding_raised_cr: 100,
    team_size: 500,
    patents_filed: 0,
    status: 'active',
  },
  {
    name: 'Hasiru Dala Innovations',
    type: 'startup',
    domain: 'solid_waste',
    description: 'Social enterprise providing total waste management services for bulk generators — collection, segregation, composting and recycling — while creating predictable livelihoods for waste pickers.',
    website: 'https://hasirudalainnovations.com',
    contact_email: 'contact@hasirudalainnovations.com',
    trl_current: 6,
    trl_target: 8,
    geography: ['Karnataka'],
    usp: 'Waste-picker-owned service model: inclusive solid waste management with verified social impact.',
    circularity_indicators: { closed_loop: false, zero_waste: true, renewable_energy: false, circular_economy: true },
    ownership_transfer_open: true,
    mou_history: [{ partner: 'BBMP Bengaluru', year: '2018', description: 'Bulk-generator waste management' }],
    innovation_stage: 'pilot',
    funding_raised_cr: 10,
    team_size: 120,
    patents_filed: 0,
    status: 'active',
  },
  {
    name: 'Chakr Innovation',
    type: 'startup',
    domain: 'air_pollution',
    description: 'Deep-tech company capturing particulate emissions from diesel generators (Chakr Shield) and converting captured soot into inks and paints; also builds materials-based solutions for cleaner air.',
    website: 'https://chakr.in',
    contact_email: 'info@chakr.in',
    founder_name: 'Kushagra Srivastava',
    trl_current: 7,
    trl_target: 9,
    geography: ['Delhi'],
    usp: 'Retrofit emission-capture device that turns diesel soot into usable ink — pollution control with a circular output.',
    circularity_indicators: { closed_loop: true, zero_waste: false, renewable_energy: false, circular_economy: true },
    ownership_transfer_open: true,
    mou_history: [{ partner: 'Indian Oil Corporation', year: '2020', description: 'Pilot deployment of Chakr Shield on DG sets' }],
    innovation_stage: 'deployed',
    funding_raised_cr: 60,
    team_size: 150,
    patents_filed: 10,
    status: 'active',
  },
  {
    name: 'Log 9 Materials',
    type: 'startup',
    domain: 'green_hydrogen',
    description: 'Advanced battery and clean-energy company building rapid-charging LTO/LFP batteries for electric vehicles and graphene-based fuel-cell technology for clean stationary power.',
    website: 'https://log9materials.com',
    contact_email: 'contact@log9materials.com',
    founder_name: 'Akshay Singhal',
    trl_current: 6,
    trl_target: 9,
    geography: ['Karnataka'],
    usp: 'India-made rapid-charging EV batteries engineered for tropical climates plus graphene fuel-cell IP.',
    circularity_indicators: { closed_loop: false, zero_waste: false, renewable_energy: true, circular_economy: false },
    ownership_transfer_open: false,
    mou_history: [],
    innovation_stage: 'pilot',
    annual_revenue_cr: 40,
    funding_raised_cr: 300,
    team_size: 400,
    patents_filed: 25,
    status: 'active',
  },
  {
    name: 'Phool.co',
    type: 'startup',
    domain: 'circular_economy',
    description: 'Circular-economy biomaterials company upcycling temple floral waste into charcoal-free incense and "Fleather" — a leather alternative grown on flower waste — preventing river dumping of flowers.',
    website: 'https://phool.co',
    contact_email: 'care@phool.co',
    founder_name: 'Ankit Agarwal',
    trl_current: 7,
    trl_target: 9,
    geography: ['Uttar Pradesh'],
    usp: 'Flowercycling®: temple waste to premium biomaterials with women-led production workforce.',
    circularity_indicators: { closed_loop: true, zero_waste: true, renewable_energy: false, circular_economy: true },
    ownership_transfer_open: false,
    mou_history: [{ partner: 'IIT Kanpur', year: '2017', description: 'Incubation and materials research' }],
    innovation_stage: 'scale',
    annual_revenue_cr: 20,
    funding_raised_cr: 80,
    team_size: 200,
    patents_filed: 4,
    status: 'active',
  },
];

export async function seedInnovators(): Promise<{ seeded: number }> {
  let seeded = 0;
  for (const inn of SEED_INNOVATORS) {
    await insertInnovator(inn);
    seeded++;
  }
  logger.info('Innovators seeded', { seeded });
  return { seeded };
}

// CLI entry: `tsx src/tools/innovators-seed.ts`
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedInnovators()
    .then(r => { logger.info('Innovator seed complete', r); process.exit(0); })
    .catch(err => { logger.error({ err }, 'Innovator seed failed'); process.exit(1); });
}
