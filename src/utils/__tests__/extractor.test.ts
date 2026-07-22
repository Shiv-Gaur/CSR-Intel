import { describe, it, expect } from 'vitest';
import {
  extractSectors, extractGeographies, extractSpend, extractNotableDonations, generateSummary,
  scoreCompany, extractEmail, extractRegistrations, detectAcceptsProposals,
  attributeAcrossSources, sectorsAreRanked,
} from '../extractor.js';

describe('extractSectors', () => {
  it('matches canonical sectors case-insensitively', () => {
    const r = extractSectors('We invest in EDUCATION, rural development and women empowerment');
    expect(r).toContain('Education');
    expect(r).toContain('Rural Development');
    expect(r).toContain('Women Empowerment');
  });
  it('returns empty for no matches', () => {
    expect(extractSectors('quarterly revenue grew')).toEqual([]);
  });
});

describe('sectorsAreRanked', () => {
  it('is true when order breaks the canonical Education-first order (frequency-ranked)', () => {
    expect(sectorsAreRanked(['Environment', 'Education', 'Healthcare'])).toBe(true);
    expect(sectorsAreRanked(['Healthcare', 'Education'])).toBe(true);
  });
  it('trusts a single extracted sector as its own top', () => {
    expect(sectorsAreRanked(['Healthcare'])).toBe(true);
  });
  it('skips non-canonical names instead of treating them as order breaks', () => {
    // known positions Education(0), Environment(2) are still ascending ⇒ not ranked
    expect(sectorsAreRanked(['Education', 'Health', 'Nutrition', 'Environment'])).toBe(false);
    // no recognisable canonical sector ⇒ cannot be called ranked
    expect(sectorsAreRanked(['Health', 'Nutrition'])).toBe(false);
  });
  it('is false for stale canonical-order lists and empty/nullish input', () => {
    expect(sectorsAreRanked(['Education', 'Healthcare', 'Environment'])).toBe(false);
    expect(sectorsAreRanked([])).toBe(false);
    expect(sectorsAreRanked(null)).toBe(false);
  });
});

describe('extractGeographies', () => {
  it('matches states/UTs and pan-india variants', () => {
    const r = extractGeographies('Programs run in Maharashtra and Tamil Nadu, nationwide');
    expect(r).toContain('Maharashtra');
    expect(r).toContain('Tamil Nadu');
    expect(r).toContain('Pan-India');
  });
});

describe('extractSpend', () => {
  it('parses CSR-context Rs/INR/crore patterns into a number in crores', () => {
    expect(extractSpend('CSR spend of Rs. 45.2 crore in FY24')).toBe(45.2);
    expect(extractSpend('INR 120 Cr allocated')).toBe(120);
    expect(extractSpend('community investment of ₹12 crores')).toBe(12);
    expect(extractSpend('donated Rs 8 crore to the foundation')).toBe(8);
  });
  it('returns null when no spend present', () => {
    expect(extractSpend('no financial figures here')).toBeNull();
  });
  it('ignores crore figures in a revenue/profit context (not CSR spend)', () => {
    expect(extractSpend('Total revenue of Rs 90000 crore')).toBeNull();
    expect(extractSpend('Net profit was 12000 crore this year')).toBeNull();
    expect(extractSpend('₹45 crore')).toBeNull(); // bare figure, no CSR context
  });

  // Company-name proximity gate — regression for the 44.44-Cr incident, where a
  // figure from an unrelated article on an aggregator SEARCH page (IndiaCSR
  // "?s=<company>") leaked in as the researched company's CSR spend and the
  // exact same number appeared on four unrelated companies, including a brand
  // new one with no real data at all.
  describe('with entityName (aggregator boilerplate defense)', () => {
    it('accepts a figure when the company is mentioned nearby', () => {
      expect(extractSpend('Aarti Industries spent Rs 18.5 crore on CSR in FY24', 'Aarti Industries')).toBe(18.5);
    });
    it('accepts a figure near the company acronym', () => {
      expect(extractSpend('TCS allocated ₹750 crore to social responsibility programmes', 'Tata Consultancy Services')).toBe(750);
    });
    it('rejects a figure belonging to a different company on the same page', () => {
      const searchPage =
        'Search results for: Eiffil water Infra. No matching articles. Recent posts: ' +
        'XYZ Cement Ltd commits Rs 44.44 crore CSR spend on rural education initiative across three states.';
      expect(extractSpend(searchPage, 'Eiffil water Infra')).toBeNull();
    });
    it('still finds the right figure further down a mixed page', () => {
      const mixed =
        'ABC Corp donated Rs 44.44 crore to its foundation. '.padEnd(400, 'x ') +
        'Meanwhile Aarti Industries reported CSR expenditure of Rs 21 crore for the year.';
      expect(extractSpend(mixed, 'Aarti Industries')).toBe(21);
    });

    // Short names and acronyms must match as WHOLE WORDS. Substring matching
    // put "itc" inside "switch"/"pitch" and "gail" inside "prevailing", so an
    // unrelated company's figure sailed through the gate on any page containing
    // ordinary English prose.
    describe('short names match as whole words only', () => {
      it('rejects "ITC" hiding inside switch/pitch', () => {
        expect(extractSpend(
          'The board voted to switch suppliers. Vedanta Ltd committed Rs 60 crore to CSR programmes.',
          'ITC',
        )).toBeNull();
        expect(extractSpend(
          'Rivals pitch rival plans. Ambuja Cement allocated Rs 33 crore for community investment.',
          'ITC',
        )).toBeNull();
      });
      it('rejects "GAIL" hiding inside prevailing', () => {
        expect(extractSpend(
          'Under prevailing norms, Hindalco donated Rs 12 crore to its foundation.',
          'GAIL',
        )).toBeNull();
      });
      it('accepts "ITC" as a standalone word and with a possessive', () => {
        expect(extractSpend('ITC Limited spent Rs 400 crore on CSR in FY24', 'ITC')).toBe(400);
        expect(extractSpend("ITC's CSR outlay was Rs 355.9 crore for the year", 'ITC')).toBe(355.9);
      });
      it('accepts a short name adjacent to punctuation', () => {
        expect(extractSpend('(ITC) allocated Rs 88 crore to community investment', 'ITC')).toBe(88);
      });
    });

    // Revenue/market-cap leak. Every article on indiacsr.in is bylined "by
    // India CSR", and that literal "CSR" was the ONLY thing satisfying the
    // CSR-context gate — and the `csr` escape hatch on the revenue gate too.
    // Both checks were effectively disabled on that whole domain, storing a
    // bond issue, a state investment and a national borrowings statistic as
    // CSR spend. Exact figures and company pairs found in the DB 2026-07-19.
    describe('publisher byline must not establish CSR context', () => {
      it('rejects a green-infrastructure BOND (Bank of Baroda, 10000 Cr)', () => {
        expect(extractSpend(
          "Bank of Baroda Sets ESG Milestone with ₹10,000 Crore Green Infrastructure Bond by India CSR March 5, 2026",
          'Bank of Baroda',
        )).toBeNull();
      });
      it('rejects a state INVESTMENT (Godrej Properties, 10000 Cr)', () => {
        expect(extractSpend(
          'Godrej Industries Group to Invest Over INR 10,000 Cr in Telangana by India CSR December 10, 2025',
          'Godrej Properties',
        )).toBeNull();
      });
      it('rejects a national FOREIGN-BORROWINGS statistic (IndiGo/Siemens, 27556 Cr)', () => {
        const page = 'Indian Companies’ Foreign Borrowings Rise to ₹27,556 Crore in July 2025 by India CSR September 20, 2025';
        expect(extractSpend(page, 'InterGlobe Aviation (IndiGo)')).toBeNull();
        expect(extractSpend(page, 'Siemens India')).toBeNull();
      });
      it('rejects a government programme outlay (HAL/SAIL, 60000 Cr)', () => {
        const page = 'AM/NS India Becomes First Anchor Industry Partner to Lead ITI Transformation under ₹60,000 Cr – PM-SETU by India CSR May 30, 2026';
        expect(extractSpend(page, 'Hindustan Aeronautics')).toBeNull();
        expect(extractSpend(page, 'Steel Authority of India')).toBeNull();
      });
      it('still accepts a real CSR figure published on the same site', () => {
        expect(extractSpend(
          'NHPC spent Rs 28.67 crore on CSR activities during the year by India CSR June 1, 2025',
          'NHPC',
        )).toBe(28.67);
      });
    });

    // Plausibility ceiling — CSR is ~2% of net profit, so a five-figure crore
    // number is never CSR spend however well-attributed it looks.
    describe('plausibility ceiling', () => {
      it('rejects an implausibly large figure even with perfect CSR wording', () => {
        expect(extractSpend('Reliance Industries spent Rs 27,556 crore on CSR programmes', 'Reliance Industries')).toBeNull();
      });
      it('accepts the largest genuine CSR spends, which sit well under the ceiling', () => {
        expect(extractSpend('Reliance Industries spent Rs 1,223 crore on CSR programmes', 'Reliance Industries')).toBe(1223);
      });
      it('takes a later plausible figure instead of an earlier implausible one', () => {
        expect(extractSpend(
          'Tata Steel reported Rs 60,000 crore allocated to capacity expansion. Tata Steel spent Rs 480 crore on CSR.',
          'Tata Steel',
        )).toBe(480);
      });
    });

    // A one-off relief donation is real, correctly-attributed CSR activity that
    // says nothing about the annual budget. Storing it as csr_spend_cr put an
    // identical 1 Cr on Bank of Baroda, Canara Bank and Fortis Healthcare.
    describe('one-off donations are separated from annual spend', () => {
      const bob = 'CSR: Bank of Baroda Donates Rs 1 Crore to Uttarakhand CM Relief Fund by India CSR August 2, 2025';

      it('does not store a CM Relief Fund donation as annual spend', () => {
        expect(extractSpend(bob, 'Bank of Baroda')).toBeNull();
      });
      it('keeps that donation in notable_donations instead of discarding it', () => {
        const donations = extractNotableDonations(bob, 'Bank of Baroda');
        expect(donations).toHaveLength(1);
        expect(donations[0].amount_cr) .toBe(1);
        expect(donations[0].context).toMatch(/relief fund/i);
      });
      it('treats PM CARES and flood relief the same way', () => {
        expect(extractSpend('Infosys contributed Rs 5 crore to PM CARES Fund', 'Infosys')).toBeNull();
        expect(extractSpend('Havells India donated Rs 5 crore towards Kerala flood relief', 'Havells India')).toBeNull();
      });
      it('still stores an annual figure that merely uses the word "donated"', () => {
        // The verb alone must not demote a figure — a company funding its own
        // CSR foundation is programme spend, not a one-time cheque. Keying the
        // gate on the verb broke exactly this case.
        expect(extractSpend(
          'Bajaj Auto donated Rs 400 crore under its FY24 CSR budget',
          'Bajaj Auto',
        )).toBe(400);
        expect(extractSpend('donated Rs 8 crore to the foundation')).toBe(8);
      });
      it('treats a donation verb as one-off only with explicit one-time framing', () => {
        expect(extractSpend(
          'Tata Steel made a one-time donation of Rs 25 crore towards the victims',
          'Tata Steel',
        )).toBeNull();
      });
      it('IndiGo annual figure is unaffected by the donation gate', () => {
        expect(extractSpend(
          'IndiGo spent Rs 139.68 crores on CSR in FY 2025, exceeding its Rs 11 crore obligation.',
          'InterGlobe Aviation (IndiGo)',
        )).toBe(139.68);
      });
    });

    // When one page carries several figures for the same company, the one with
    // fuller context wins over a bare headline number.
    describe('prefers the fuller-context figure over a bare headline', () => {
      // Exact IndiGo page shape: headline and body run together with no
      // sentence break between them, which is why scoring uses a tight window.
      const indigoPage =
        'The data lists 130 entries under the automatic route, spanning sectors from manufacturing to finance. ' +
        'IndiGo Spends Rs 13.96 Crore on Corporate Social Responsibility (CSR) in FY 2025 by India CSR October 4, 2025 ' +
        'IndiGo spent Rs 139.68 crores on CSR in FY 2025, exceeding its Rs 11 crore obligation. ' +
        'CSR: IndiGoReach Empowering Rural Enterprise';

      it('selects the body figure with fiscal year + obligation over the headline', () => {
        expect(extractSpend(indigoPage, 'InterGlobe Aviation (IndiGo)')).toBe(139.68);
      });
      it('does not mistake the stated obligation itself for the spend', () => {
        expect(extractSpend(indigoPage, 'InterGlobe Aviation (IndiGo)')).not.toBe(11);
      });
      it('keeps first-match behaviour when context strength ties', () => {
        expect(extractSpend(
          'Wipro spent Rs 200 crore on CSR in FY24. Wipro spent Rs 300 crore on CSR in FY24.',
          'Wipro',
        )).toBe(200);
      });
    });
  });
});

describe('generateSummary', () => {
  it('returns at most 300 chars with collapsed whitespace', () => {
    const s = generateSummary('a\n\n b   c '.repeat(100));
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).not.toContain('\n');
  });
});

describe('scoreCompany', () => {
  it('scores deterministically out of 100', () => {
    expect(scoreCompany({
      sectors: ['Education', 'Healthcare'], geographies: ['Maharashtra'],
      spend: 45, hasDocument: true, hasContactInfo: true,
    })).toBe(66); // 4 + 2 + 25 + 20 + 15
  });
  it('scores zero with nothing found', () => {
    expect(scoreCompany({ sectors: [], geographies: [], spend: null, hasDocument: false, hasContactInfo: false })).toBe(0);
  });
  it('caps sector/geography contributions at 10 items', () => {
    const many = Array.from({ length: 20 }, (_, i) => `S${i}`);
    expect(scoreCompany({ sectors: many, geographies: many, spend: 1, hasDocument: true, hasContactInfo: true })).toBe(100);
  });
});

describe('attributeAcrossSources', () => {
  it('unions sectors and rates agreement by source count', () => {
    const r = attributeAcrossSources([
      { label: 'screener', text: 'focus on education and healthcare' },
      { label: 'indiacsr', text: 'education programs and sanitation drives' },
      { label: 'wikipedia', text: 'major education initiatives nationwide' },
    ]);
    expect(r.sectors).toEqual(expect.arrayContaining(['Education', 'Healthcare', 'Sanitation']));
    expect(r.sectorSources['Education']).toEqual(expect.arrayContaining(['screener', 'indiacsr', 'wikipedia']));
    expect(r.sectorConfidence['Education']).toBe('high');   // 3 sources
    expect(r.sectorConfidence['Healthcare']).toBe('low');   // 1 source
    expect(r.geographies).toContain('Pan-India');
  });
});

describe('supporting extractors', () => {
  it('extracts an email', () => {
    expect(extractEmail('reach us at csr@acmecorp.in today')).toBe('csr@acmecorp.in');
    expect(extractEmail('no email here')).toBeNull();
  });
  it('skips placeholder emails and returns the first real one', () => {
    expect(extractEmail('e.g. name@example.com — write to csr@acmecorp.in')).toBe('csr@acmecorp.in');
    expect(extractEmail('sample: user@company.com')).toBeNull();
  });
  it('detects NGO registrations', () => {
    const r = extractRegistrations('Registered under 12A, 80G, holds CSR-1 and FCRA');
    expect(r).toEqual(expect.arrayContaining(['12A', '80G', 'CSR-1', 'FCRA']));
  });
  it('detects proposal acceptance posture', () => {
    expect(detectAcceptsProposals('We invite proposals from NGOs')).toBe(true);
    expect(detectAcceptsProposals('We do not accept unsolicited proposals')).toBe(false);
    expect(detectAcceptsProposals('annual report summary')).toBeNull();
  });
});
