---
name: fix-agent
description: Debug and fix broken pipeline agents. Use when an agent throws errors or produces no output.
paths:
  - "src/agents/**"
  - "src/tools/**"
---

Run agent directly: npm run ingest:discovery (or enrich, verify, drift)
Fix first error only, re-run, repeat until it passes.

Common errors:
- ECONNREFUSED 5432 = PostgreSQL not running
- ZodError = scraped data shape changed, update schema
- Cannot find module = missing .js extension in ESM import
- ENOTFOUND = no internet or site blocked IP
- null enrichment = claude.ts failing, check ANTHROPIC_API_KEY

Always run npm run build before debugging runtime errors.
Use subagent to scan files: "Use a subagent to read src/agents/ and return only what each agent exports and imports"
