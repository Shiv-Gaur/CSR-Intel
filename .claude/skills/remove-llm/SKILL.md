---
name: remove-llm
description: Replace claude.ts LLM calls with deterministic extractor.ts. Use when touching src/utils/claude.ts or any agent that imports it.
paths:
  - "src/utils/claude.ts"
  - "src/utils/extractor.ts"
  - "src/agents/**"
---

Goal: zero API calls, zero LLM dependency. Must work without ANTHROPIC_API_KEY.

extractor.ts functions to create:
- extractSectors(text): string[] - match 15 Indian CSR sectors case-insensitive
- extractGeographies(text): string[] - match 28 states + 8 UTs + pan-india variants
- extractSpend(text): number | null - parse Rs/INR/crore patterns
- generateSummary(text): string - first 300 chars, no generation
- scoreCompany(data): number - 0-100 deterministic score

Steps:
1. Find every import of claude.ts across all agents
2. Map each call to equivalent extractor.ts function
3. Keep identical output shape - DB schema must not change
4. Rename claude.ts to claude.ts.disabled after all replaced
5. Make ANTHROPIC_API_KEY optional in src/config.ts
6. Run npm run test - fix all failures

Indian CSR sectors: Education, Healthcare, Environment, Rural Development,
Women Empowerment, Skill Development, Sanitation, Drinking Water, Sports,
Arts & Culture, Technology, Poverty Alleviation, Disaster Relief,
Animal Welfare, Armed Forces Veterans
