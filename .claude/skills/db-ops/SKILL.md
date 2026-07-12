---
name: db-ops
description: PostgreSQL operations - migrations, queries, schema changes. Use when working in src/db/ or scripts/.
paths:
  - "src/db/**"
  - "scripts/**"
---

Always import pool from src/db/index.ts - never create new Pool instance.
Parameterised queries only - never string interpolate SQL.

Status values (exact strings, case-sensitive):
STUB -> ENRICHED -> HUMAN_REVIEW -> VERIFIED -> COMPLETE

Fix stuck HUMAN_REVIEW companies:
UPDATE companies SET status = 'VERIFIED'
WHERE status = 'HUMAN_REVIEW'
AND sectors IS NOT NULL
AND array_length(sectors, 1) > 0
AND geographies IS NOT NULL
AND array_length(geographies, 1) > 0;

Migration rules:
- New migrations in scripts/migrate.ts
- Always IF NOT EXISTS before CREATE TABLE
- Never DROP columns - add nullable columns instead
- Run npm run db:migrate after any schema change

Seed: INSERT ... ON CONFLICT (name) DO NOTHING - safe to re-run
