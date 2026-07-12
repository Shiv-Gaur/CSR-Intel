import { describe, it, expect } from 'vitest';
import {
  DOMAIN_SECTOR_MAP, scoreFunderInnovatorPair, rankFunders, rankInnovators,
  type FunderMatchInput, type InnovatorMatchInput,
} from '../innovator-match.js';

const funder = (over: Partial<FunderMatchInput> = {}): FunderMatchInput => ({
  id: 'f1', kind: 'company', name: 'Acme CSR',
  sectors: [], geographies: [], trl: { min: 0, max: 0 }, text: '', contact_email: null,
  ...over,
});

const innovator = (over: Partial<InnovatorMatchInput> = {}): InnovatorMatchInput => ({
  domain: 'plastic', trl_current: 7, geography: ['Delhi'], text: '',
  ...over,
});

describe('DOMAIN_SECTOR_MAP', () => {
  it('maps waste domains to Environment', () => {
    expect(DOMAIN_SECTOR_MAP.solid_waste).toEqual(['Environment']);
    expect(DOMAIN_SECTOR_MAP.plastic).toEqual(['Environment']);
    expect(DOMAIN_SECTOR_MAP.e_waste).toEqual(['Environment']);
    expect(DOMAIN_SECTOR_MAP.air_pollution).toEqual(['Environment']);
  });
  it('maps water domains to Environment + Sanitation + Drinking Water', () => {
    expect(DOMAIN_SECTOR_MAP.wastewater).toEqual(['Environment', 'Sanitation', 'Drinking Water']);
    expect(DOMAIN_SECTOR_MAP.water_body).toEqual(['Environment', 'Sanitation', 'Drinking Water']);
  });
  it('maps tech-heavy domains to include Technology / Healthcare', () => {
    expect(DOMAIN_SECTOR_MAP.green_hydrogen).toEqual(['Environment', 'Technology']);
    expect(DOMAIN_SECTOR_MAP.ai_medtech).toEqual(['Healthcare', 'Technology']);
    expect(DOMAIN_SECTOR_MAP.circular_economy).toEqual(['Environment', 'Rural Development']);
  });
});

describe('scoreFunderInnovatorPair', () => {
  it('gives +40 for a sector match via domain mapping', () => {
    const { score, reasons } = scoreFunderInnovatorPair(innovator(), funder({ sectors: ['Environment'] }));
    expect(score).toBe(40);
    expect(reasons[0]).toContain('+40');
  });

  it('gives +30 for a same-state geography match', () => {
    const { score, reasons } = scoreFunderInnovatorPair(
      innovator({ geography: ['Karnataka'] }),
      funder({ geographies: ['Karnataka', 'Kerala'] }));
    expect(score).toBe(30);
    expect(reasons[0]).toContain('Karnataka');
  });

  it('treats Delhi/NCR variants as the same geography', () => {
    const { score } = scoreFunderInnovatorPair(
      innovator({ geography: ['Delhi'] }),
      funder({ geographies: ['Delhi NCR'] }));
    expect(score).toBe(30);
  });

  it('gives partial +15 credit for Pan-India funders', () => {
    const { score, reasons } = scoreFunderInnovatorPair(
      innovator({ geography: ['Odisha'] }),
      funder({ geographies: ['Pan-India'] }));
    expect(score).toBe(15);
    expect(reasons[0]).toContain('Pan-India');
  });

  it('gives +20 when the funder TRL range includes the innovator TRL', () => {
    const inRange = scoreFunderInnovatorPair(innovator({ trl_current: 7 }), funder({ trl: { min: 7, max: 9 } }));
    expect(inRange.score).toBe(20);
    const outOfRange = scoreFunderInnovatorPair(innovator({ trl_current: 5 }), funder({ trl: { min: 7, max: 9 } }));
    expect(outOfRange.score).toBe(0);
    const unknown = scoreFunderInnovatorPair(innovator({ trl_current: 5 }), funder({ trl: { min: 0, max: 0 } }));
    expect(unknown.score).toBe(0);
  });

  it('gives +10 when the funder text mentions the innovator domain keywords', () => {
    const { score, reasons } = scoreFunderInnovatorPair(
      innovator({ domain: 'plastic' }),
      funder({ text: 'Our CSR programme funds plastic collection drives.' }));
    expect(score).toBe(10);
    expect(reasons[0]).toContain('Keywords');
  });

  it('caps a full alignment at 100 and lists every reason', () => {
    const { score, reasons } = scoreFunderInnovatorPair(
      innovator({ domain: 'wastewater', trl_current: 6, geography: ['Delhi'] }),
      funder({
        sectors: ['Sanitation', 'Environment'], geographies: ['Delhi'],
        trl: { min: 4, max: 6 }, text: 'sewage and water treatment projects',
      }));
    expect(score).toBe(100);
    expect(reasons).toHaveLength(4);
  });

  it('scores 0 with no overlap at all', () => {
    const { score, reasons } = scoreFunderInnovatorPair(
      innovator({ domain: 'ai_medtech', geography: ['Kerala'], trl_current: 4 }),
      funder({ sectors: ['Sports'], geographies: ['Punjab'], trl: { min: 7, max: 9 }, text: 'sports scholarships' }));
    expect(score).toBe(0);
    expect(reasons).toHaveLength(0);
  });
});

describe('rankFunders', () => {
  const funders: FunderMatchInput[] = [
    funder({ id: 'low', name: 'Low Fit', sectors: ['Sports'], geographies: ['Punjab'] }),
    funder({ id: 'best', name: 'Best Fit', sectors: ['Environment'], geographies: ['Delhi'], trl: { min: 7, max: 9 }, text: 'plastic waste programmes', contact_email: 'csr@best.example' }),
    funder({ id: 'mid', name: 'Mid Fit', sectors: ['Environment'], geographies: ['Kerala'] }),
  ];

  it('ranks best matches first and drops zero scores', () => {
    const ranked = rankFunders(innovator(), funders);
    expect(ranked.map(r => r.funderId)).toEqual(['best', 'mid']);
    expect(ranked[0].score).toBe(100);
    expect(ranked[0].contact_email).toBe('csr@best.example');
  });

  it('honours the limit (top N)', () => {
    const ranked = rankFunders(innovator(), funders, 1);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].funderId).toBe('best');
  });
});

describe('rankInnovators (reverse direction)', () => {
  it('ranks innovators for a funder with the same algorithm', () => {
    const f = funder({ sectors: ['Environment'], geographies: ['Karnataka'], trl: { min: 4, max: 6 } });
    const innovators = [
      { ...innovator({ domain: 'solid_waste', geography: ['Karnataka'], trl_current: 6 }), id: 'i1', name: 'Waste Co', contact_email: 'a@b.c' },
      { ...innovator({ domain: 'ai_medtech', geography: ['Punjab'], trl_current: 3 }), id: 'i2', name: 'Med Co', contact_email: null },
    ];
    const ranked = rankInnovators(f, innovators);
    expect(ranked).toHaveLength(1); // Med Co scores 0 and is dropped
    expect(ranked[0].innovatorId).toBe('i1');
    expect(ranked[0].score).toBe(90); // 40 sector + 30 geo + 20 TRL
  });
});
