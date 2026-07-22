// Stage 2: live curated trusted-source search. HTTP is fully mocked — these
// tests pin extraction, dedupe, source labelling and fail-soft behaviour, never
// the network.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios');
import axios from 'axios';
import { curatedWebSearch, dedupeLeads, normName, type SearchLead } from '../curated-search.js';

const wikiPayload = {
  data: ['hydrogen', ['Hydrogen fuel cell', 'Green hydrogen'], ['an electrochemical cell', 'clean fuel'], ['http://w/1', 'http://w/2']],
};
const screenerPayload = { data: [{ name: 'NTPC Green Energy', url: '/company/NTPC/' }] };
const indiacsrHtml = { data: '<html><body><h2 class="entry-title"><a href="http://i/1">Reliance announces hydrogen push</a></h2></body></html>' };
const yourstoryHtml = { data: '<html><body><h3><a href="http://y/1">Ohmium raises funds for hydrogen</a></h3></body></html>' };
const inc42Html = { data: '<html><body><article><h2 class="entry-title"><a href="http://in/1">h2 mobility startup scales</a></h2></article></body></html>' };

function wire(overrides: Record<string, any> = {}) {
  (axios.get as any).mockImplementation((url: string) => {
    if ('wiki' in overrides && url.includes('wikipedia.org')) return overrides.wiki;
    if ('screener' in overrides && url.includes('screener.in')) return overrides.screener;
    if (url.includes('wikipedia.org')) return Promise.resolve(wikiPayload);
    if (url.includes('screener.in')) return Promise.resolve(screenerPayload);
    if (url.includes('indiacsr.in')) return Promise.resolve(indiacsrHtml);
    if (url.includes('yourstory.com')) return Promise.resolve(yourstoryHtml);
    if (url.includes('inc42.com')) return Promise.resolve(inc42Html);
    return Promise.reject(new Error('unexpected url'));
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('curatedWebSearch', () => {
  it('aggregates leads across trusted sources with source labels', async () => {
    wire();
    const leads = await curatedWebSearch('hydrogen fuel cells');
    expect(leads.length).toBeGreaterThan(0);
    const names = leads.map(l => l.name);
    expect(names).toContain('Hydrogen fuel cell');
    expect(names).toContain('NTPC Green Energy');
    const sources = new Set(leads.map(l => l.source));
    expect(sources.has('Wikipedia')).toBe(true);
    expect(sources.has('Screener')).toBe(true);
  });

  it('labels Screener rows as company leads', async () => {
    wire();
    const leads = await curatedWebSearch('ntpc');
    const ntpc = leads.find(l => l.name === 'NTPC Green Energy');
    expect(ntpc!.suggestedType).toBe('company');
    expect(ntpc!.url).toContain('screener.in');
  });

  it('is fail-soft: a rejected source does not sink the others', async () => {
    wire({ screener: Promise.reject(new Error('429 blocked')) });
    const leads = await curatedWebSearch('hydrogen');
    expect(leads.map(l => l.name)).toContain('Hydrogen fuel cell');
    expect(leads.map(l => l.name)).not.toContain('NTPC Green Energy');
  });

  it('returns nothing for a too-short query without hitting the network', async () => {
    wire();
    const leads = await curatedWebSearch('h');
    expect(leads).toHaveLength(0);
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('dedupeLeads', () => {
  it('drops case/spacing duplicates, keeping the first', () => {
    const input: SearchLead[] = [
      { name: 'Ohmium International', snippet: '', source: 'Wikipedia', url: 'a', suggestedType: 'unknown' },
      { name: 'ohmium  international', snippet: '', source: 'Inc42', url: 'b', suggestedType: 'innovator' },
      { name: 'NTPC', snippet: '', source: 'Screener', url: 'c', suggestedType: 'company' },
    ];
    const out = dedupeLeads(input);
    expect(out).toHaveLength(2);
    expect(out[0].source).toBe('Wikipedia');
  });
});

describe('normName', () => {
  it('normalizes punctuation and case', () => {
    expect(normName('Phool.co  (India)')).toBe('phool co india');
  });
});
