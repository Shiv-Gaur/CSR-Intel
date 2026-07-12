// Curated central-government welfare schemes relevant to CSR sectors.
//
// myscheme.gov.in is a JS-rendered SPA with no server-side HTML and no public
// keyless API, so it cannot be scraped deterministically here (search-free mode,
// see config.ts). Instead we seed a curated set of real, well-known central
// schemes — each tagged with the same canonical sectors/geographies the rest of
// the pipeline uses, so the dashboard's sector/geography filters work uniformly.
//
// A daily cron re-seeds (idempotent upsert) so the list stays present.

import { upsertEntity, updateEntityData } from '../db/index.js';
import { inferTRL } from '../utils/trl.js';
import { logger } from '../utils/logger.js';

export interface SeedScheme {
  name: string;
  ministry: string;
  description: string;
  eligibility: string;
  funding: string;
  deadline: string;
  states: string[];          // 'Pan-India' or specific states
  sectors: string[];         // canonical CSR sectors
  beneficiaries: string[];
  url: string;
}

export const WELFARE_SCHEMES: SeedScheme[] = [
  {
    name: 'PM POSHAN (Mid-Day Meal Scheme)',
    ministry: 'Ministry of Education',
    description: 'Provides hot cooked meals to children in government and aided schools to improve nutritional levels and school attendance.',
    eligibility: 'All children studying in Classes I-VIII in government, local body and government-aided schools.',
    funding: '₹10,000+ Cr annual outlay',
    deadline: 'Rolling (state implementation)',
    states: ['Pan-India'], sectors: ['Education', 'Healthcare'],
    beneficiaries: ['School Children', 'Low Income Families'],
    url: 'https://pmposhan.education.gov.in/',
  },
  {
    name: 'Ayushman Bharat - PM-JAY',
    ministry: 'Ministry of Health and Family Welfare',
    description: 'Health assurance scheme providing cover of ₹5 lakh per family per year for secondary and tertiary care hospitalisation. Supports demonstration and scale-up of health implementation across districts.',
    eligibility: 'Economically vulnerable families as per SECC 2011 deprivation criteria.',
    funding: '₹5,00,000 cover per family/year',
    deadline: 'Always open (enrolment)',
    states: ['Pan-India'], sectors: ['Healthcare', 'Poverty Alleviation'],
    beneficiaries: ['Low Income Families', 'Rural Citizens'],
    url: 'https://pmjay.gov.in/',
  },
  {
    name: 'Swachh Bharat Mission (Grameen)',
    ministry: 'Ministry of Jal Shakti',
    description: 'Sanitation programme to make rural India open-defecation free through implementation and scale-up of toilet construction and solid waste management.',
    eligibility: 'Rural households without access to individual household latrines.',
    funding: '₹12,000 incentive per IHHL',
    deadline: 'Rolling',
    states: ['Pan-India'], sectors: ['Sanitation', 'Rural Development'],
    beneficiaries: ['Rural Citizens'],
    url: 'https://swachhbharatmission.gov.in/',
  },
  {
    name: 'Jal Jeevan Mission',
    ministry: 'Ministry of Jal Shakti',
    description: 'Provides functional household tap connections to every rural household. Large-scale deployment and implementation of piped drinking water infrastructure.',
    eligibility: 'Rural households without functional tap water connections.',
    funding: 'Cost-shared centre/state',
    deadline: 'Ongoing',
    states: ['Pan-India'], sectors: ['Drinking Water', 'Rural Development'],
    beneficiaries: ['Rural Citizens'],
    url: 'https://jaljeevanmission.gov.in/',
  },
  {
    name: 'Beti Bachao Beti Padhao',
    ministry: 'Ministry of Women and Child Development',
    description: 'Addresses declining child sex ratio and promotes education and empowerment of the girl child.',
    eligibility: 'Targeted districts; girl children and their families.',
    funding: 'Scheme-based grants',
    deadline: 'Rolling',
    states: ['Pan-India'], sectors: ['Women Empowerment', 'Education'],
    beneficiaries: ['Girl Children', 'Women'],
    url: 'https://wcd.nic.in/bbbp-schemes',
  },
  {
    name: 'Skill India - PMKVY',
    ministry: 'Ministry of Skill Development and Entrepreneurship',
    description: 'Pradhan Mantri Kaushal Vikas Yojana provides short-term skill training and certification. Pilot to scale model for industry-aligned skilling.',
    eligibility: 'Indian youth (15-45) seeking skill certification.',
    funding: 'Training cost fully funded',
    deadline: 'Batch-based enrolment',
    states: ['Pan-India'], sectors: ['Skill Development', 'Education'],
    beneficiaries: ['Youth', 'Unemployed'],
    url: 'https://www.pmkvyofficial.org/',
  },
  {
    name: 'National Rural Livelihood Mission (DAY-NRLM)',
    ministry: 'Ministry of Rural Development',
    description: 'Promotes self-employment and organisation of rural poor into self-help groups for sustainable livelihoods at scale.',
    eligibility: 'Rural poor households, especially women SHGs.',
    funding: 'Revolving fund + credit linkage',
    deadline: 'Rolling',
    states: ['Pan-India'], sectors: ['Rural Development', 'Women Empowerment', 'Poverty Alleviation'],
    beneficiaries: ['Rural Women', 'Low Income Families'],
    url: 'https://aajeevika.gov.in/',
  },
  {
    name: 'PM-KUSUM (Solar for Farmers)',
    ministry: 'Ministry of New and Renewable Energy',
    description: 'Supports installation of solar pumps and grid-connected solar power plants. Demonstration and deployment of decentralised renewable energy.',
    eligibility: 'Individual farmers, cooperatives, panchayats.',
    funding: 'Up to 60% subsidy',
    deadline: 'State-window based',
    states: ['Pan-India'], sectors: ['Environment', 'Rural Development'],
    beneficiaries: ['Farmers'],
    url: 'https://pmkusum.mnre.gov.in/',
  },
  {
    name: 'Khelo India',
    ministry: 'Ministry of Youth Affairs and Sports',
    description: 'Develops sports infrastructure and identifies talent through pilot academies scaling to national programmes.',
    eligibility: 'Young athletes and sports institutions.',
    funding: 'Annual athlete stipend + grants',
    deadline: 'Annual talent identification',
    states: ['Pan-India'], sectors: ['Sports', 'Skill Development'],
    beneficiaries: ['Youth', 'Athletes'],
    url: 'https://kheloindia.gov.in/',
  },
  {
    name: 'National Mission for Clean Ganga',
    ministry: 'Ministry of Jal Shakti',
    description: 'Implementation and large-scale deployment of river rejuvenation, sewage treatment and afforestation along the Ganga basin.',
    eligibility: 'ULBs, NGOs and research institutions in Ganga basin states.',
    funding: 'Project-based grants',
    deadline: 'Proposal-based',
    states: ['Uttar Pradesh', 'Bihar', 'West Bengal', 'Uttarakhand', 'Jharkhand'],
    sectors: ['Environment', 'Drinking Water'],
    beneficiaries: ['River-basin Communities'],
    url: 'https://nmcg.nic.in/',
  },
  {
    name: 'Atal Innovation Mission - ATL',
    ministry: 'NITI Aayog',
    description: 'Establishes Atal Tinkering Labs to foster research, prototype and proof of concept innovation among school students.',
    eligibility: 'Schools (Grade VI-XII) across India.',
    funding: '₹20 lakh grant per lab',
    deadline: 'Periodic call for applications',
    states: ['Pan-India'], sectors: ['Technology', 'Education', 'Skill Development'],
    beneficiaries: ['School Children', 'Young Innovators'],
    url: 'https://aim.gov.in/',
  },
  {
    name: 'National Disaster Management - SDRF',
    ministry: 'Ministry of Home Affairs',
    description: 'State Disaster Response Fund supports relief, rehabilitation and deployment of resources during notified disasters.',
    eligibility: 'Disaster-affected populations via state governments.',
    funding: 'Centre-state shared corpus',
    deadline: 'As-needed (disaster events)',
    states: ['Pan-India'], sectors: ['Disaster Relief'],
    beneficiaries: ['Disaster-affected Families'],
    url: 'https://ndma.gov.in/',
  },
  {
    name: 'National Scheme for Welfare of Animals',
    ministry: 'Ministry of Fisheries, Animal Husbandry and Dairying',
    description: 'Provides grants-in-aid to animal welfare organisations for shelter, ambulance services and rehabilitation.',
    eligibility: 'Registered animal welfare organisations (AWBI recognised).',
    funding: 'Grant-in-aid',
    deadline: 'Annual application window',
    states: ['Pan-India'], sectors: ['Animal Welfare', 'Environment'],
    beneficiaries: ['Animal Welfare NGOs'],
    url: 'https://awbi.gov.in/',
  },
  {
    name: 'National Programme for Persons with Disabilities (DDRS)',
    ministry: 'Ministry of Social Justice and Empowerment',
    description: 'Deenadayal Disabled Rehabilitation Scheme funds NGOs running rehabilitation and inclusive education projects.',
    eligibility: 'Registered NGOs working with persons with disabilities.',
    funding: 'Recurring grant-in-aid',
    deadline: 'Annual proposal window',
    states: ['Pan-India'], sectors: ['Healthcare', 'Education', 'Poverty Alleviation'],
    beneficiaries: ['Persons with Disabilities'],
    url: 'https://disabilityaffairs.gov.in/',
  },
  {
    name: 'Ek Bharat Shreshtha Bharat',
    ministry: 'Ministry of Culture',
    description: 'Promotes cultural exchange, arts and heritage through pairing of states and pilot cultural programmes.',
    eligibility: 'Cultural institutions, schools and state bodies.',
    funding: 'Activity-based grants',
    deadline: 'Rolling',
    states: ['Pan-India'], sectors: ['Arts & Culture', 'Education'],
    beneficiaries: ['Students', 'Artists'],
    url: 'https://ekbharat.gov.in/',
  },
  {
    name: 'Armed Forces Flag Day Fund',
    ministry: 'Ministry of Defence',
    description: 'Supports welfare and rehabilitation of ex-servicemen, war widows and their dependents.',
    eligibility: 'Ex-servicemen, war widows and dependents.',
    funding: 'Welfare grants',
    deadline: 'Always open',
    states: ['Pan-India'], sectors: ['Armed Forces Veterans', 'Healthcare'],
    beneficiaries: ['Ex-servicemen', 'War Widows'],
    url: 'https://ksb.gov.in/',
  },
];

/** Idempotently upsert the curated welfare schemes as govt_scheme entities. */
export async function seedWelfareSchemes(): Promise<{ seeded: number }> {
  let seeded = 0;
  for (const s of WELFARE_SCHEMES) {
    const trl = inferTRL(`${s.description} ${s.eligibility}`);
    const id = await upsertEntity({
      name: s.name,
      category: 'govt_scheme',
      status: 'active' as any,
      priority: 3,
      source_urls: [s.url],
    } as any);
    await updateEntityData(id, {
      description: s.description,
      ministry: s.ministry,
      status: 'active',
      funding_amount: s.funding,
      application_deadline: s.deadline,
      eligibility_text: s.eligibility,
      sector_focus: { value: s.sectors },
      geography_focus: { value: s.states },
      beneficiary_types: { value: s.beneficiaries },
      trl: { band: trl.band, min: trl.min, max: trl.max, label: trl.label, basis: trl.basis },
    });
    seeded++;
  }
  logger.info('Welfare schemes seeded', { seeded });
  return { seeded };
}

// CLI entry: `tsx src/tools/schemes-seed.ts`
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedWelfareSchemes()
    .then(r => { logger.info('Scheme seed complete', r); process.exit(0); })
    .catch(err => { logger.error({ err }, 'Scheme seed failed'); process.exit(1); });
}
