import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  parseInnovatorImport, buildImportTemplate, summariseImport, IMPORT_COLUMNS,
} from '../innovator-import.js';

function xlsxBuffer(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const HEADERS = [...IMPORT_COLUMNS];

describe('parseInnovatorImport', () => {
  it('parses a valid xlsx row with label-style type/domain', () => {
    const buf = xlsxBuffer([
      HEADERS,
      ['Acme Waste', 'Startup', 'Solid Waste', 5, 8, 'Sorts waste', 'a@acme.in', 'A Rao', 'Karnataka; Goa', 'https://acme.in'],
    ]);
    const { rows, errors } = parseInnovatorImport(buf, 'innovators.xlsx');
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Acme Waste', type: 'startup', domain: 'solid_waste',
      trl_current: 5, trl_target: 8, geography: ['Karnataka', 'Goa'],
      contact_email: 'a@acme.in', website: 'https://acme.in', row: 2,
    });
  });

  it('parses CSV and accepts raw domain keys', () => {
    const csv = [
      'Name,Type,Domain,TRL Current,TRL Target,Description,Contact Email,Founder Name,Geography,Website',
      'Hydro Labs,research_institute,green_hydrogen,3,,"Electrolyser R&D",,,Tamil Nadu,',
    ].join('\n');
    const { rows, errors } = parseInnovatorImport(Buffer.from(csv, 'utf8'), 'innovators.csv');
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      name: 'Hydro Labs', type: 'research_institute', domain: 'green_hydrogen',
      trl_current: 3, trl_target: null, geography: ['Tamil Nadu'], website: null,
    });
  });

  it('skips rows with missing name, bad domain, bad email or out-of-range TRL', () => {
    const buf = xlsxBuffer([
      HEADERS,
      ['', 'Startup', 'Plastic', '', '', '', '', '', '', ''],
      ['Bad Domain Co', 'Startup', 'Rocketry', '', '', '', '', '', '', ''],
      ['Bad Email Co', 'Startup', 'Plastic', '', '', '', 'not-an-email', '', '', ''],
      ['Bad TRL Co', 'Startup', 'Plastic', 12, '', '', '', '', '', ''],
      ['Good Co', 'Startup', 'Plastic', 4, 7, '', '', '', 'Delhi', ''],
    ]);
    const { rows, errors } = parseInnovatorImport(buf, 'mixed.xlsx');
    expect(rows.map(r => r.name)).toEqual(['Good Co']);
    expect(errors).toHaveLength(4);
    expect(errors[0].reason).toContain('missing name');
    expect(errors[1].reason).toContain('unknown domain');
    expect(errors[2].reason).toContain('email');
    expect(errors[3].reason).toContain('trl_current');
    expect(errors.map(e => e.row)).toEqual([2, 3, 4, 5]);
  });

  it('ignores blank lines and tolerates header case/spacing differences', () => {
    const csv = [
      'name,type,domain,trl current,trl target,description,contact email,founder name,geography,website',
      '',
      'Case Co,Individual,E-Waste,,,,,,,',
    ].join('\n');
    const { rows, errors } = parseInnovatorImport(Buffer.from(csv, 'utf8'), 'x.csv');
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ name: 'Case Co', type: 'individual', domain: 'e_waste' });
  });

  it('rejects a file without a Name column', () => {
    const csv = 'Company,Sector\nAcme,Waste';
    const { rows, errors } = parseInnovatorImport(Buffer.from(csv, 'utf8'), 'x.csv');
    expect(rows).toEqual([]);
    expect(errors[0].reason).toContain('missing "Name" column');
  });
});

describe('buildImportTemplate', () => {
  it('produces an xlsx whose header row matches the expected columns', () => {
    const buf = buildImportTemplate();
    const wb = XLSX.read(buf, { type: 'buffer' });
    const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    expect(grid[0]).toEqual(HEADERS);
    // template round-trips through the parser (example row is valid)
    const { rows, errors } = parseInnovatorImport(buf, 'template.xlsx');
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

describe('summariseImport', () => {
  it('formats the results line', () => {
    expect(summariseImport(12, [
      { row: 2, name: '', reason: 'missing name' },
      { row: 5, name: '', reason: 'missing name' },
    ], ['Chakr Innovation'])).toBe('12 imported, 2 skipped (see details), 1 duplicate (already exists)');
    expect(summariseImport(3, [], [])).toBe('3 imported');
  });
});
