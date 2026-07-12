/**
 * Known URL Seeds — curated, verified URLs for priority Indian CSR entities.
 *
 * These bypass search entirely, giving us guaranteed starting points for
 * enrichment even when all web scrapers are rate-limited or blocked.
 *
 * Sources: company CSR pages, BSE/NSE filings, CSR.gov.in, foundation sites.
 * Last curated: June 2026.
 */

export interface KnownEntitySeed {
  /** Canonical entity name (must match PRIORITY_ENTITIES in discovery.agent.ts) */
  name: string;
  /** Direct URLs to fetch — CSR pages, annual reports, foundation sites */
  urls: string[];
  /** Official website root (for context) */
  website?: string;
  /** NSE/BSE ticker if publicly listed */
  ticker?: string;
  /** CIN if known */
  cin?: string;
}

export const KNOWN_URLS: KnownEntitySeed[] = [
  // ──────────────────────────────────────── P1 — Large Private & Foundations
  {
    name: 'Tata Consultancy Services',
    urls: [
      'https://www.tcs.com/who-we-are/corporate-social-responsibility',
      'https://www.tcs.com/who-we-are/newsroom/csr-annual-report',
      'https://www.csr.gov.in/content/csr/global/master/home/ExploreCsrData/company-wise.html',
    ],
    website: 'https://www.tcs.com',
    ticker: 'TCS',
    cin: 'L22210MH2004PLC148028',
  },
  {
    name: 'Tata Trusts',
    urls: [
      'https://www.tatatrusts.org/our-work',
      'https://www.tatatrusts.org/our-work/livelihood-generation',
      'https://www.tatatrusts.org/about-us',
    ],
    website: 'https://www.tatatrusts.org',
  },
  {
    name: 'Mahindra & Mahindra',
    urls: [
      'https://www.mahindra.com/sustainability/csr',
      'https://www.mahindrarise.com/csr',
      'https://www.mahindra.com/investors/annual-reports',
    ],
    website: 'https://www.mahindra.com',
    ticker: 'M&M',
    cin: 'L65990MH1945PLC004558',
  },
  {
    name: 'Reliance Foundation',
    urls: [
      'https://www.reliancefoundation.org/',
      'https://www.reliancefoundation.org/what-we-do',
      'https://www.ril.com/sustainability/corporate-social-responsibility',
    ],
    website: 'https://www.reliancefoundation.org',
  },
  {
    name: 'Infosys Foundation',
    urls: [
      'https://www.infosys.com/infosys-foundation.html',
      'https://www.infosys.com/about/corporate-responsibility.html',
      'https://www.infosys.com/investors/reports-filings/annual-report.html',
    ],
    website: 'https://www.infosys.com',
    ticker: 'INFY',
    cin: 'L85110KA1981PLC013115',
  },
  {
    name: 'HUL - Hindustan Unilever',
    urls: [
      'https://www.hul.co.in/planet-and-society/',
      'https://www.hul.co.in/planet-and-society/responsible-business/',
      'https://www.hul.co.in/investors/annual-reports/',
    ],
    website: 'https://www.hul.co.in',
    ticker: 'HINDUNILVR',
    cin: 'L15140MH1933PLC002030',
  },
  {
    name: 'HDFC Bank',
    urls: [
      'https://www.hdfcbank.com/personal/about-us/csr',
      'https://www.hdfcbank.com/personal/about-us/csr/parivartan',
      'https://www.hdfcbank.com/personal/about-us/investor-relations/annual-reports',
    ],
    website: 'https://www.hdfcbank.com',
    ticker: 'HDFCBANK',
    cin: 'L65920MH1994PLC080618',
  },
  {
    name: 'Wipro',
    urls: [
      'https://www.wipro.com/about-us/sustainability/',
      'https://www.wipro.com/about-us/sustainability/social/',
      'https://www.wipro.com/investors/annual-reports/',
    ],
    website: 'https://www.wipro.com',
    ticker: 'WIPRO',
    cin: 'L32102KA1945PLC020800',
  },
  {
    name: 'Bajaj Auto',
    urls: [
      'https://www.bajajauto.com/csr',
      'https://www.bajajauto.com/investors/annual-reports',
    ],
    website: 'https://www.bajajauto.com',
    ticker: 'BAJAJ-AUTO',
    cin: 'L65993PN2007PLC130076',
  },
  {
    name: 'Cipla',
    urls: [
      'https://www.cipla.com/csr',
      'https://www.ciplafoundation.org/',
      'https://www.cipla.com/investors/annual-reports',
    ],
    website: 'https://www.cipla.com',
    ticker: 'CIPLA',
    cin: 'L24239MH1935PLC002380',
  },
  {
    name: 'Larsen & Toubro',
    urls: [
      'https://www.larsentoubro.com/corporate/corporate-social-responsibility/',
      'https://www.larsentoubro.com/corporate/investors/annual-reports/',
    ],
    website: 'https://www.larsentoubro.com',
    ticker: 'LT',
    cin: 'L99999MH1946PLC004768',
  },
  {
    name: 'Kotak Mahindra Bank',
    urls: [
      'https://www.kotak.com/en/about-us/corporate-social-responsibility.html',
      'https://www.kotak.com/en/investor-relations/financial-results/annual-reports.html',
    ],
    website: 'https://www.kotak.com',
    ticker: 'KOTAKBANK',
    cin: 'L65110MH1985PLC038137',
  },
  {
    name: 'Asian Paints',
    urls: [
      'https://www.asianpaints.com/about-us/corporate-social-responsibility.html',
      'https://www.asianpaints.com/more/investors/annual-reports.html',
    ],
    website: 'https://www.asianpaints.com',
    ticker: 'ASIANPAINT',
    cin: 'L24220MH1945PLC004598',
  },
  {
    name: 'Godrej Group',
    urls: [
      'https://www.godrejindustries.com/sustainability/community-development',
      'https://godrejgoodandgreen.com/',
      'https://www.godrejindustries.com/investors/annual-reports',
    ],
    website: 'https://www.godrejindustries.com',
    ticker: 'GODREJIND',
  },
  {
    name: 'ITC Limited',
    urls: [
      'https://www.itcportal.com/sustainability/corporate-social-responsibility.aspx',
      'https://www.itcportal.com/about-itc/shareholder-value/annual-reports.aspx',
    ],
    website: 'https://www.itcportal.com',
    ticker: 'ITC',
    cin: 'L16005WB1910PLC001985',
  },
  {
    name: 'Azim Premji Philanthropic Initiatives',
    urls: [
      'https://azimpremjiphilanthropicinitiatives.org/',
      'https://azimpremjifoundation.org/',
      'https://azimpremjifoundation.org/about-us',
    ],
    website: 'https://azimpremjiphilanthropicinitiatives.org',
  },

  // ──────────────────────────────────────── P2 — PSUs and Large Banks
  {
    name: 'State Bank of India',
    urls: [
      'https://sbi.co.in/web/corporate-social-responsibility',
      'https://sbi.co.in/web/corporate-governance/annual-report',
      'https://www.sbifoundation.in/',
    ],
    website: 'https://sbi.co.in',
    ticker: 'SBIN',
    cin: 'L65191MH1955GOI089726',
  },
  {
    name: 'ONGC',
    urls: [
      'https://ongcindia.com/web/eng/csr',
      'https://ongcindia.com/web/eng/investors/reports/annualreport',
    ],
    website: 'https://ongcindia.com',
    ticker: 'ONGC',
    cin: 'L11101MH1993GOI073392',
  },
  {
    name: 'NTPC',
    urls: [
      'https://www.ntpc.co.in/en/corporate-social-responsibility',
      'https://www.ntpc.co.in/en/investors/annual-report',
    ],
    website: 'https://www.ntpc.co.in',
    ticker: 'NTPC',
    cin: 'L40101DL1975GOI007966',
  },
  {
    name: 'BHEL',
    urls: [
      'https://www.bhel.com/csr',
      'https://www.bhel.com/annual-reports',
    ],
    website: 'https://www.bhel.com',
    ticker: 'BHEL',
    cin: 'L74210DL1964GOI004281',
  },
  {
    name: 'Punjab National Bank',
    urls: [
      'https://www.pnbindia.in/csr.html',
      'https://www.pnbindia.in/annual-report.html',
    ],
    website: 'https://www.pnbindia.in',
    ticker: 'PNB',
    cin: 'L65110DL1895GOI001249',
  },
  {
    name: 'Bank of Baroda',
    urls: [
      'https://www.bankofbaroda.in/corporate-social-responsibility',
      'https://www.bankofbaroda.in/annual-report',
    ],
    website: 'https://www.bankofbaroda.com',
    ticker: 'BANKBARODA',
    cin: 'L65110GJ1908GOI000101',
  },
  {
    name: 'Indian Oil Corporation',
    urls: [
      'https://iocl.com/corporate-social-responsibility',
      'https://iocl.com/annual-report',
    ],
    website: 'https://iocl.com',
    ticker: 'IOC',
    cin: 'L23201DL1959GOI002959',
  },

  // ──────────────────────────────────────── P3 — International Funders
  {
    name: 'Ford Foundation India',
    urls: [
      'https://www.fordfoundation.org/regions/india-nepal-and-sri-lanka/',
      'https://www.fordfoundation.org/work/our-grants/',
    ],
    website: 'https://www.fordfoundation.org',
  },
  {
    name: 'Bill & Melinda Gates Foundation India',
    urls: [
      'https://www.gatesfoundation.org/our-work/places/india',
      'https://www.gatesfoundation.org/about/how-we-work',
    ],
    website: 'https://www.gatesfoundation.org',
  },
  {
    name: 'Omidyar Network India',
    urls: [
      'https://www.omidyarnetwork.in/',
      'https://www.omidyarnetwork.in/our-portfolio',
    ],
    website: 'https://www.omidyarnetwork.in',
  },
  {
    name: 'MacArthur Foundation India',
    urls: [
      'https://www.macfound.org/regions/india/',
      'https://www.macfound.org/info-grantseekers/',
    ],
    website: 'https://www.macfound.org',
  },
  {
    name: 'Skoll Foundation',
    urls: [
      'https://skoll.org/',
      'https://skoll.org/about/approach/',
    ],
    website: 'https://skoll.org',
  },
  {
    name: 'USAID India',
    urls: [
      'https://www.usaid.gov/india',
      'https://www.usaid.gov/india/our-work',
    ],
    website: 'https://www.usaid.gov/india',
  },
];

/**
 * Lookup known URLs by entity name (case-insensitive match).
 * Returns the seed if found, otherwise null.
 */
export function getKnownUrls(entityName: string): KnownEntitySeed | null {
  return KNOWN_URLS.find(
    e => e.name.toLowerCase() === entityName.toLowerCase()
  ) ?? null;
}

/**
 * Get just the URL list for an entity, or empty array if not known.
 */
export function getKnownUrlList(entityName: string): string[] {
  return getKnownUrls(entityName)?.urls ?? [];
}
