// Bulk innovator import from Excel (.xlsx) / CSV. Pure parsing + validation
// here (unit-testable, no DB/HTTP); the dashboard route does the inserting.
//
// Expected columns (header row, case/spacing-insensitive):
//   Name, Type, Domain, TRL Current, TRL Target, Description, Contact Email,
//   Founder Name, Geography, Website
// Geography accepts a ";" or "," separated list of states.

import * as XLSX from 'xlsx';
import { z } from 'zod';
import { DOMAIN_LABELS } from '../utils/innovator-match.js';
import type { InnovatorDomain, InnovatorType } from '../types/index.js';

export const IMPORT_COLUMNS = [
  'Name', 'Type', 'Domain', 'TRL Current', 'TRL Target', 'Description',
  'Contact Email', 'Founder Name', 'Geography', 'Website',
] as const;

// Header lookup key: lowercase, alphanumeric only ("TRL Current" → "trlcurrent").
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const TYPE_ALIASES: Record<string, InnovatorType> = {
  startup: 'startup',
  individual: 'individual', individualinnovator: 'individual',
  researchinstitute: 'research_institute', research: 'research_institute',
};

// Accept both raw keys ("solid_waste") and display labels ("Solid Waste").
const DOMAIN_ALIASES: Record<string, InnovatorDomain> = {};
for (const [key, label] of Object.entries(DOMAIN_LABELS)) {
  DOMAIN_ALIASES[norm(key)] = key as InnovatorDomain;
  DOMAIN_ALIASES[norm(label)] = key as InnovatorDomain;
}

const importRowSchema = z.object({
  name: z.string().trim().min(2, 'name too short').max(200),
  type: z.enum(['startup', 'individual', 'research_institute']),
  domain: z.enum(['solid_waste', 'plastic', 'wastewater', 'air_pollution', 'e_waste',
    'green_hydrogen', 'circular_economy', 'ai_medtech', 'water_body']),
  trl_current: z.number().int().min(1).max(9).nullable(),
  trl_target: z.number().int().min(1).max(9).nullable(),
  description: z.string().trim().max(5000).nullable(),
  contact_email: z.string().trim().email('invalid email').nullable(),
  founder_name: z.string().trim().max(200).nullable(),
  geography: z.array(z.string().trim().min(1)).max(40),
  website: z.string().trim().url('invalid website URL').nullable(),
});

export type ImportRow = z.infer<typeof importRowSchema>;

export interface RowError { row: number; name: string; reason: string }

export interface ParsedImport {
  rows: Array<ImportRow & { row: number }>;
  errors: RowError[];
}

function cellStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function cellNum(v: unknown): number | null {
  const s = cellStr(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN; // NaN → caught by Zod as invalid
}

/** Parse an uploaded .xlsx or .csv buffer into validated import rows. */
export function parseInnovatorImport(buf: Buffer, filename: string): ParsedImport {
  const isCsv = /\.csv$/i.test(filename);
  const wb = XLSX.read(buf, { type: 'buffer', raw: isCsv });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { rows: [], errors: [{ row: 0, name: '', reason: 'file has no sheets' }] };
  // Raw array-of-arrays so we control header normalisation ourselves.
  const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  if (!grid.length) return { rows: [], errors: [{ row: 0, name: '', reason: 'file is empty' }] };

  const headers = (grid[0] as unknown[]).map(h => norm(cellStr(h)));
  const col = (label: string) => headers.indexOf(norm(label));
  const iName = col('Name');
  if (iName === -1) {
    return { rows: [], errors: [{ row: 1, name: '', reason: 'missing "Name" column — download the template for the expected headers' }] };
  }
  const idx = {
    type: col('Type'), domain: col('Domain'), trlCur: col('TRL Current'), trlTgt: col('TRL Target'),
    desc: col('Description'), email: col('Contact Email'), founder: col('Founder Name'),
    geo: col('Geography'), web: col('Website'),
  };
  const cell = (r: unknown[], i: number) => (i === -1 ? '' : cellStr(r[i]));

  const rows: Array<ImportRow & { row: number }> = [];
  const errors: RowError[] = [];

  for (let r = 1; r < grid.length; r++) {
    const raw = grid[r] as unknown[];
    const rowNo = r + 1; // 1-based, matching what the user sees in Excel
    if (raw.every(v => !cellStr(v))) continue; // blank line

    const name = cell(raw, iName);
    if (!name) { errors.push({ row: rowNo, name: '', reason: 'missing name' }); continue; }

    const typeRaw = cell(raw, idx.type);
    const type = typeRaw ? TYPE_ALIASES[norm(typeRaw)] : 'startup';
    if (!type) { errors.push({ row: rowNo, name, reason: `unknown type "${typeRaw}" (use Startup, Individual or Research Institute)` }); continue; }

    const domainRaw = cell(raw, idx.domain);
    const domain = domainRaw ? DOMAIN_ALIASES[norm(domainRaw)] : undefined;
    if (!domain) {
      const reason = domainRaw
        ? `unknown domain "${domainRaw}" (valid: ${Object.values(DOMAIN_LABELS).join(', ')})`
        : 'missing domain';
      errors.push({ row: rowNo, name, reason });
      continue;
    }

    const candidate = {
      name, type, domain,
      trl_current: cellNum(raw[idx.trlCur]),
      trl_target: cellNum(raw[idx.trlTgt]),
      description: cell(raw, idx.desc) || null,
      contact_email: cell(raw, idx.email) || null,
      founder_name: cell(raw, idx.founder) || null,
      geography: cell(raw, idx.geo).split(/[;,]/).map(s => s.trim()).filter(Boolean),
      website: cell(raw, idx.web) || null,
    };
    const parsed = importRowSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({ row: rowNo, name, reason: `${issue.path.join('.')}: ${issue.message}` });
      continue;
    }
    rows.push({ ...parsed.data, row: rowNo });
  }
  return { rows, errors };
}

/** Blank .xlsx template with the expected header row (+ one example row). */
export function buildImportTemplate(): Buffer {
  const example = [
    'Chakr Innovation', 'Startup', 'Air Pollution', 6, 9,
    'Captures particulate emissions from diesel generators',
    'info@chakr.in', 'Kushagra Srivastava', 'Delhi; Haryana', 'https://chakr.in',
  ];
  const ws = XLSX.utils.aoa_to_sheet([[...IMPORT_COLUMNS], example]);
  ws['!cols'] = IMPORT_COLUMNS.map(c => ({ wch: Math.max(c.length + 2, 18) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Innovators');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** "12 imported, 2 skipped (missing name), 1 duplicate (already exists)" */
export function summariseImport(imported: number, errors: RowError[], duplicates: string[]): string {
  const parts = [`${imported} imported`];
  if (errors.length) {
    const firstReason = errors[0].reason.split('(')[0].trim();
    parts.push(`${errors.length} skipped (${errors.length === 1 ? firstReason : 'see details'})`);
  }
  if (duplicates.length) parts.push(`${duplicates.length} duplicate${duplicates.length > 1 ? 's' : ''} (already exists)`);
  return parts.join(', ');
}
