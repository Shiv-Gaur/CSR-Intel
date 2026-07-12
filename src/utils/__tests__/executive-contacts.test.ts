import { describe, it, expect } from 'vitest';
import {
  extractExecutiveContacts, mergeExecutiveContacts,
  pickOfficialContact, extractSourceDate,
  detectDomainFocus, extractMoUHistory, detectOwnershipTransfer,
} from '../extractor.js';

describe('extractExecutiveContacts', () => {
  it('finds "Name, Title" patterns', () => {
    const r = extractExecutiveContacts('Kushagra Srivastava, CEO of Chakr Innovation, said the device cuts emissions.');
    expect(r).toContainEqual(expect.objectContaining({ name: 'Kushagra Srivastava', title: 'CEO' }));
  });

  it('finds "Title Name" patterns with honorifics', () => {
    const r = extractExecutiveContacts('The Managing Director Mr. Anil Kumar Sharma addressed shareholders.');
    expect(r).toContainEqual(expect.objectContaining({ name: 'Anil Kumar Sharma', title: 'Managing Director' }));
  });

  it('parses Wikipedia-style "Key people" infobox lines with initials', () => {
    const r = extractExecutiveContacts('Key people: N. Chandrasekaran (Chairman) K. Krithivasan (CEO)');
    expect(r).toContainEqual(expect.objectContaining({ name: 'N. Chandrasekaran', title: 'Chairman' }));
    expect(r).toContainEqual(expect.objectContaining({ name: 'K. Krithivasan', title: 'CEO' }));
  });

  it('attaches firstname.lastname emails to the matching name with high confidence', () => {
    const r = extractExecutiveContacts('Ravi Verma, CSR Head. Contact: ravi.verma@acme.com');
    const ravi = r.find(c => c.name === 'Ravi Verma');
    expect(ravi?.email).toBe('ravi.verma@acme.com');
    expect(ravi?.confidence).toBe('high');
  });

  it('collects generic purpose mailboxes as standalone low-confidence contacts', () => {
    const r = extractExecutiveContacts('Write to csr@acme.com or foundation@acme.org or investor.relations@acme.com');
    expect(r).toContainEqual(expect.objectContaining({ title: 'CSR Contact', email: 'csr@acme.com', confidence: 'low' }));
    expect(r).toContainEqual(expect.objectContaining({ title: 'Foundation Contact', email: 'foundation@acme.org' }));
    expect(r).toContainEqual(expect.objectContaining({ title: 'Investor Relations', email: 'investor.relations@acme.com' }));
  });

  it('rejects boilerplate that only looks like a name', () => {
    const r = extractExecutiveContacts('Corporate Social Responsibility, CEO message and Annual Report, Chairman statement');
    expect(r.filter(c => c.name)).toEqual([]);
  });

  it('matches uppercase MD but not lowercase "md" prose', () => {
    expect(extractExecutiveContacts('Sunita Rao, MD, leads the business.'))
      .toContainEqual(expect.objectContaining({ name: 'Sunita Rao', title: 'Managing Director' }));
    expect(extractExecutiveContacts('the md format file was updated').filter(c => c.name)).toEqual([]);
  });

  it('returns empty for empty text', () => {
    expect(extractExecutiveContacts('')).toEqual([]);
  });

  it('detects Company Secretary mailboxes as medium-confidence official contacts', () => {
    const r = extractExecutiveContacts('Grievances: cosec@acme.com. Investor queries: ir@acme.com');
    expect(r).toContainEqual(expect.objectContaining({ title: 'Company Secretary (official contact)', email: 'cosec@acme.com', confidence: 'medium' }));
    expect(r).toContainEqual(expect.objectContaining({ title: 'Investor Relations', email: 'ir@acme.com', confidence: 'medium' }));
  });

  it('attaches an email that appears near a titled name (SEBI filing layout)', () => {
    const r = extractExecutiveContacts('Company Secretary: Pradeep Manohar, e-mail: secretarial@acme.com');
    const cs = r.find(c => c.name === 'Pradeep Manohar');
    expect(cs?.email).toBe('secretarial@acme.com');
    expect(cs?.confidence).toBe('high');
  });

  it('ignores placeholder/junk emails like name@example.com', () => {
    const r = extractExecutiveContacts('Enter your email: name@example.com or contact info@test.org');
    expect(r.filter(c => c.email)).toEqual([]);
  });

  it('ignores aggregator-portal staff emails (a NASSCOM address is not the company)', () => {
    const r = extractExecutiveContacts('For queries contact anjali@nasscom.in or press@linkedin.com');
    expect(r.filter(c => c.email)).toEqual([]);
  });
});

describe('pickOfficialContact', () => {
  const cs = { name: null, title: 'Company Secretary (official contact)', email: 'cosec@acme.com', source: 'ir-page', confidence: 'medium' as const };
  const csr = { name: null, title: 'CSR Contact', email: 'csr@acme.com', source: 'contact-page', confidence: 'low' as const };
  const namedNoEmail = { name: 'A. Sharma', title: 'CEO', email: null, source: 'wikipedia', confidence: 'medium' as const };
  const namedWithEmail = { name: 'R. Verma', title: 'CSR Head', email: 'r.verma@acme.com', source: 'indiacsr', confidence: 'high' as const };
  const guess = { name: null, title: 'CSR Contact (inferred, unverified)', email: 'csr@guess.com', source: 'pattern-guess', confidence: 'low' as const };

  it('prefers a named person with an email over official channels', () => {
    expect(pickOfficialContact([cs, namedWithEmail])?.email).toBe('r.verma@acme.com');
  });
  it('falls back Company Secretary → CSR by priority (names without emails skipped)', () => {
    expect(pickOfficialContact([namedNoEmail, csr, cs])?.email).toBe('cosec@acme.com');
    expect(pickOfficialContact([namedNoEmail, csr])?.email).toBe('csr@acme.com');
  });
  it('never returns a pattern-guess and handles empty input', () => {
    expect(pickOfficialContact([guess, namedNoEmail])).toBeNull();
    expect(pickOfficialContact([])).toBeNull();
    expect(pickOfficialContact(null)).toBeNull();
  });
});

describe('aggregator proximity gate', () => {
  it('drops another company\'s exec on a shared aggregator page', () => {
    const text = 'People also viewed: Stuart Machin, CEO of Marks and Spencer. ' + 'x'.repeat(400) +
      ' Tata Consultancy Services appointed K. Krithivasan, CEO, in 2023.';
    const r = extractExecutiveContacts(text, 'linkedin', 'Tata Consultancy Services');
    expect(r.map(c => c.name)).toContain('K. Krithivasan');
    expect(r.map(c => c.name)).not.toContain('Stuart Machin');
  });
  it('accepts a match near the company acronym (TCS)', () => {
    const text = 'x'.repeat(400) + ' TCS chief K. Krithivasan, CEO, said the program grew.';
    const r = extractExecutiveContacts(text, 'nasscom', 'Tata Consultancy Services');
    expect(r.map(c => c.name)).toContain('K. Krithivasan');
  });
  it('does not gate non-aggregator sources (own site, wikipedia)', () => {
    const r = extractExecutiveContacts('Kushagra Srivastava, CEO, leads the company.', 'contact-page', 'Chakr Innovation');
    expect(r.map(c => c.name)).toContain('Kushagra Srivastava');
  });
  it('rejects "Name, Title, OtherOrg" trailing attribution on aggregator pages', () => {
    // Real-world pattern from an IndiaCSR search page mixing many companies.
    const text = 'TCS CSR programs expand. CSR: Purpose Gives You a Legacy: Dr. Vikas Garg, Chairman, Ebix Group by India CSR';
    const names = extractExecutiveContacts(text, 'indiacsr', 'Tata Consultancy Services').map(c => c.name);
    expect(names).not.toContain('Dr. Vikas Garg');
  });
  it('rejects execs attributed to ANOTHER org even when the entity is mentioned nearby', () => {
    // Real-world pattern from TCS's LinkedIn page: an M&S deal announcement.
    const text = 'Key attendees from M&S included Stuart Machin, Chief Executive Officer, ' +
      'Sacha Berendji, Operations Director, and from Tata Consultancy Services, ' +
      'Rajesh Gopinathan, Chief Executive Officer, participated to mark this milestone.';
    const names = extractExecutiveContacts(text, 'linkedin', 'Tata Consultancy Services').map(c => c.name);
    expect(names).not.toContain('Stuart Machin');
    expect(names).toContain('Rajesh Gopinathan');
  });
});

describe('email integrity — no construction', () => {
  it('every extracted email is a literal substring of the source text', () => {
    const text = 'Ravi Verma, CSR Head. Contact: ravi.verma@acme.com. Grievances: cosec@acme.com.';
    for (const c of extractExecutiveContacts(text)) {
      if (c.email) expect(text.toLowerCase()).toContain(c.email);
    }
  });
  it('yields NO email when the text contains none — never a domain-based guess', () => {
    const r = extractExecutiveContacts(
      'K. Krithivasan (CEO) leads Tata Consultancy Services. Visit https://www.tcs.com for details.');
    expect(r.filter(c => c.email)).toEqual([]);
  });
});

describe('extractSourceDate', () => {
  it('parses the Wikipedia footer form', () => {
    expect(extractSourceDate('This page was last edited on 1 March 2026, at 12:04 (UTC).')).toBe('2026-03-01');
  });
  it('parses "last updated" with Month D, YYYY and ISO forms', () => {
    expect(extractSourceDate('Last updated: March 1, 2026')).toBe('2026-03-01');
    expect(extractSourceDate('last modified on 2025-11-30')).toBe('2025-11-30');
  });
  it('returns null when the page has no recency marker', () => {
    expect(extractSourceDate('Quarterly results and dividends.')).toBeNull();
    expect(extractSourceDate('')).toBeNull();
  });
});

describe('contact provenance stamps', () => {
  it('stamps extracted_at and as_of from the page last-edited date', () => {
    const r = extractExecutiveContacts(
      'Key people: K. Krithivasan (CEO). This page was last edited on 1 March 2026, at 12:04 (UTC).', 'wikipedia');
    const ceo = r.find(c => c.title === 'CEO');
    expect(ceo?.as_of).toBe('2026-03-01');
    expect(typeof ceo?.extracted_at).toBe('string');
  });
  it('stamps as_of null when the page carries no date (age unknown, not current)', () => {
    const r = extractExecutiveContacts('Sunita Rao, MD, leads the business.');
    expect(r[0]?.as_of).toBeNull();
  });
});

describe('mergeExecutiveContacts', () => {
  it('dedupes by name+title, preferring entries with an email', () => {
    const merged = mergeExecutiveContacts([
      [{ name: 'Ravi Verma', title: 'CEO', email: null, source: 'wikipedia', confidence: 'medium' }],
      [{ name: 'Ravi Verma', title: 'CEO', email: 'ravi.verma@acme.com', source: 'indiacsr', confidence: 'high' }],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].email).toBe('ravi.verma@acme.com');
  });
});

describe('detectDomainFocus', () => {
  it('detects platform domains from text, most-evidenced first', () => {
    const r = detectDomainFocus('Our air quality programs tackle emission and particulate pollution; we also fund plastic collection.');
    expect(r[0]).toBe('air_pollution');
    expect(r).toContain('plastic');
  });
  it('returns empty when nothing matches', () => {
    expect(detectDomainFocus('quarterly results and dividends')).toEqual([]);
    expect(detectDomainFocus('')).toEqual([]);
  });
});

describe('extractMoUHistory', () => {
  it('extracts partner and year from MoU sentences', () => {
    const r = extractMoUHistory('The company signed an MoU with Indian Oil Corporation in 2020 for pilot deployment.');
    expect(r).toContainEqual(expect.objectContaining({ partner: 'Indian Oil Corporation', year: '2020' }));
  });
  it('handles "memorandum of understanding" spelled out, without a year', () => {
    const r = extractMoUHistory('It entered into a memorandum of understanding with IIT Kanpur.');
    expect(r[0]?.partner).toBe('IIT Kanpur');
    expect(r[0]?.year).toBeUndefined();
  });
  it('returns empty when no MoU mentioned', () => {
    expect(extractMoUHistory('no partnerships to report')).toEqual([]);
  });
});

describe('detectOwnershipTransfer', () => {
  it('detects explicit transfer/licensing language', () => {
    expect(detectOwnershipTransfer('We are open to licensing our technology to partners')).toBe(true);
    expect(detectOwnershipTransfer('The institute supports technology transfer to industry')).toBe(true);
  });
  it('returns null (unknown) when there is no signal', () => {
    expect(detectOwnershipTransfer('We build waste management plants')).toBeNull();
    expect(detectOwnershipTransfer('')).toBeNull();
  });
});

describe('mergeExecutiveContacts — source-trust priority', () => {
  const c = (over: any) => ({ name: null, title: 'CEO', email: null, source: 'wikipedia', confidence: 'medium', ...over });

  it('drops an aggregator name that contradicts the official site for the same title', () => {
    const merged = mergeExecutiveContacts([
      [c({ name: 'Wrong Person', source: 'wikipedia' })],
      [c({ name: 'Real Person', source: 'official-site' })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Real Person');
    expect(merged[0].verification).toBeUndefined();
  });

  it('labels aggregator-only names as unverified', () => {
    const merged = mergeExecutiveContacts([[c({ name: 'Some Person', source: 'linkedin' })]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].verification).toMatch(/not confirmed on company/i);
  });

  it('does not label an aggregator name confirmed by a regulatory source', () => {
    const merged = mergeExecutiveContacts([
      [c({ name: 'Filed Person', source: 'wikipedia' })],
      [c({ name: 'Filed Person', title: 'Managing Director', source: 'zauba-directors' })],
    ]);
    const wiki = merged.find(x => x.title === 'CEO');
    expect(wiki).toBeDefined();
    expect(wiki!.verification).toBeUndefined();
  });

  it('orders official-site contacts before aggregator contacts', () => {
    const merged = mergeExecutiveContacts([
      [c({ name: 'Agg Person', title: 'Chairman', source: 'nasscom' })],
      [c({ name: 'Site Person', title: 'CEO', source: 'official-site' })],
    ]);
    expect(merged[0].source).toBe('official-site');
  });

  it('still prefers email-bearing duplicates regardless of tier', () => {
    const merged = mergeExecutiveContacts([
      [c({ name: 'Jane Doe', source: 'official-site' })],
      [c({ name: 'Jane Doe', source: 'screener', email: 'jane.doe@acme.com' })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].email).toBe('jane.doe@acme.com');
  });
});

describe('mergeExecutiveContacts — name-drift tolerance', () => {
  const c = (over: any) => ({ name: null, title: 'CEO', email: null, source: 'wikipedia', confidence: 'medium', ...over });

  it('a noisy superset capture neither contradicts nor un-verifies the clean form', () => {
    const merged = mergeExecutiveContacts([
      [c({ name: 'Srini Pallia', source: 'wikipedia' })],
      [c({ name: 'Srini Pallia Message', source: 'official-site' })],
    ]);
    const wiki = merged.find(x => x.source === 'wikipedia');
    expect(wiki).toBeDefined();
    expect(wiki!.verification).toBeUndefined();
  });

  it('rejects headline-verb fragments as names at extraction time', () => {
    const r = extractExecutiveContacts('Srini Pallia Speaks, CEO of Wipro, at the townhall.', 'investors-page', 'Wipro');
    expect(r.find(x => x.name === 'Srini Pallia Speaks')).toBeUndefined();
  });
});

describe('extractExecutiveContacts — official-page noise hardening', () => {
  it('rejects org-glued captures with a mid-string honorific', () => {
    const r = extractExecutiveContacts('Mahindra Logistics Mr. Lakshmanan, CEO, leads the unit.');
    expect(r.filter(x => x.name && /Logistics/.test(x.name))).toHaveLength(0);
  });

  it('keeps a leading honorific capture but stores the bare name', () => {
    const r = extractExecutiveContacts('CEO: Dr. Anish Kumar Shah oversees operations.');
    expect(r).toContainEqual(expect.objectContaining({ name: 'Anish Kumar Shah', title: 'CEO' }));
  });

  it('rejects UI-chrome fragments like "View Profile" and "Non Executive"', () => {
    const r = extractExecutiveContacts('View Profile, Chairman. Non Executive, Managing Director.');
    expect(r.filter(x => x.name)).toHaveLength(0);
  });
});
