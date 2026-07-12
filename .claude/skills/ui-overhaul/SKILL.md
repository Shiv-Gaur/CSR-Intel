---
name: ui-overhaul
description: Redesign dashboard.html for light mode and non-technical users. Use when working on src/dashboard.html or src/dashboard.ts.
paths:
  - "src/dashboard.html"
  - "src/dashboard.ts"
---

Design rules (non-negotiable):
- Light mode ONLY - white #ffffff background, page bg #f8f9fa
- No dark backgrounds anywhere including header
- Font: system-ui, -apple-system, sans-serif - no external imports
- Vanilla HTML + CSS + JS only - no React, no Tailwind, no npm packages

Status label mapping (never show raw DB values):
- COMPLETE = Ready (green #16a34a)
- HUMAN_REVIEW = Needs Review (amber #d97706)
- ENRICHED = Enriched (blue #2563eb)
- STUB = Processing (grey #6b7280)
- VERIFIED = Verified (green #16a34a)

Layout:
[Header: CSR Funders Registry | Run Discovery button]
[4 stat cards: Total | Ready | Needs Review | Processing]
[Search bar + filter pills: All | Ready | Needs Review]
[Left 60%: company table] [Right 40%: detail panel]
[Footer: last updated timestamp]

Score display: progress bar 0-100 + label (80+=Strong, 60+=Good, 40+=Partial, 0+=Low data)
CSV download: GET /api/export/csv
Re-enrich: POST /api/companies/:id/enrich
