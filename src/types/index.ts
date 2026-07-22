// ─── Core entity types ───────────────────────────────────────────────────────

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type EntityStatus = 'stub' | 'enriched' | 'verified' | 'complete' | 'human_review';
export type EntityCategory = 'company' | 'foundation' | 'psu' | 'bank' | 'international_funder' | 'govt_scheme' | 'ngo';
export type ImplementingMode = 'direct' | 'foundation' | 'ngo_grant' | 'section8' | 'trust' | 'mixed';

export interface ConfidenceField<T> {
  value: T | null;
  confidence: ConfidenceLevel;
  source_url: string | null;
  extracted_at: string; // ISO8601
}

export interface CompanyEntity {
  id: string;                          // UUID
  name: string;
  name_aliases: string[];
  cin?: string;                        // MCA company ID
  category: EntityCategory;
  status: EntityStatus;
  priority: 1 | 2 | 3 | 4;

  // Enriched fields (all confidence-wrapped)
  sector_focus: ConfidenceField<string[]>;
  geography_focus: ConfidenceField<string[]>;
  csr_spend_cr: ConfidenceField<Record<string, number>>; // {FY: amount} — ANNUAL programme spend only
  /** One-off relief/disaster donations, kept apart from annual spend: a
   *  Rs 1 Cr cheque to a CM Relief Fund is real CSR activity but says nothing
   *  about the annual budget, and storing it as such put an identical 1 Cr on
   *  three unrelated companies. */
  notable_donations?: ConfidenceField<Array<{ amount_cr: number; context: string }>>;
  implementing_mode: ConfidenceField<ImplementingMode>;
  accepts_proposals: ConfidenceField<boolean>;
  required_registrations: ConfidenceField<string[]>;
  min_track_record_yrs: ConfidenceField<number | null>;
  application_url: ConfidenceField<string | null>;
  contact_email: ConfidenceField<string | null>;

  // Drift scores (computed)
  drift_scores?: DriftScores;

  // Meta
  source_urls: string[];
  missing_fields: string[];
  conflict_log: ConflictEntry[];
  created_at: string;
  updated_at: string;
}

export interface DriftScores {
  sector_drift?: number;       // 0–100 (optional for test/compatibility)
  geo_drift?: number;          // 0–100 (optional for test/compatibility)
  requirement_drift?: number;  // 0–100 (optional for test/compatibility)
  openness_drift?: number;     // 0–100 (optional for test/compatibility)
  composite_drift?: number;    // weighted composite (optional for test/compatibility)
  computed_at?: string;
  window_years?: number;

  // Compatibility for older drift-compute tools and tests:
  sector: number;
  geography: number;
  requirement: number;
  openness: number;
  composite: number;
}

export interface SectorAllocation {
  sector: string;
  spend_pct?: number;
  spend_cr?: number;
}

export interface DriftDetail {
  dimension: 'sector' | 'geography' | 'requirement' | 'openness';
  score: number;
  explanation: string;
  changes: Array<{
    item: string;
    direction: 'added' | 'removed' | 'increased' | 'decreased' | 'stable';
    magnitude: number;
  }>;
}

export interface ChangeHistoryEntry {
  id: string;
  entity_id: string;
  field_name: string;
  old_value: unknown;
  new_value: unknown;
  financial_year: string;       // e.g. "FY2023-24"
  change_type: 'sector_shift' | 'geo_shift' | 'requirement_change' | 'openness_change' | 'spend_change';
  source_url: string;
  detected_at: string;
}

export interface ConflictEntry {
  field: string;
  source_a_value: unknown;
  source_a_url: string;
  source_b_value: unknown;
  source_b_url: string;
  detected_at: string;
}

// ─── Innovator types (Side B — startups / researchers matched to funders) ─────

export type InnovatorType = 'startup' | 'individual' | 'research_institute';
export type InnovatorDomain =
  | 'solid_waste' | 'plastic' | 'wastewater' | 'air_pollution' | 'e_waste'
  | 'green_hydrogen' | 'circular_economy' | 'ai_medtech' | 'water_body'
  // Added 2026-07-21. clean_air folds into air_pollution and renewable_missions
  // into green_hydrogen (close enough) rather than adding distinct domains.
  | 'semiconductors' | 'energy_security' | 'industry_4_0' | 'smart_agriculture';
export type InnovationStage = 'ideation' | 'prototype' | 'pilot' | 'scale' | 'deployed';
export type InnovatorStatus = 'active' | 'inactive' | 'verified';

// Feasibility signals (Innovator-only). Robustness is a qualitative readiness
// band; the rest are auto-detected best-effort during enrichment and manually
// correctable (locked via data.feasibility_overrides).
export type Robustness = 'strong' | 'moderate' | 'weak' | 'unknown';

/** Land/electricity subsidy availability, with free-text notes. */
export interface SubsidyLandElectricity {
  land_subsidy: boolean | string | null;
  electricity_subsidy: boolean | string | null;
  notes: string | null;
}

export interface CircularityIndicators {
  closed_loop: boolean;
  zero_waste: boolean;
  renewable_energy: boolean;
  circular_economy: boolean;
}

export interface MoUEntry {
  partner: string;
  year?: string;
  description?: string;
}

export interface InnovatorEntity {
  id: string;                          // UUID
  name: string;
  type: InnovatorType;
  domain: InnovatorDomain;
  description: string | null;
  website: string | null;
  contact_email: string | null;
  founder_name: string | null;
  trl_current: number | null;          // 1–9
  trl_target: number | null;           // 1–9
  geography: string[];                 // states/UTs
  usp: string | null;
  sustainability_score: number;        // 0–100
  circularity_indicators: CircularityIndicators;
  ownership_transfer_open: boolean;    // willing to license/transfer technology
  mou_history: MoUEntry[];
  innovation_stage: InnovationStage;
  annual_revenue_cr: number | null;
  funding_raised_cr: number | null;
  team_size: number | null;
  patents_filed: number;
  status: InnovatorStatus;

  // ── Feasibility (Innovator-only, added 2026-07-21) ──────────────────────────
  robustness_logistics: Robustness;                 // logistics / supply-chain readiness
  robustness_geographic_scalability: Robustness;    // ease of scaling across geographies
  indigenous_tech: boolean | null;                  // domestically developed vs foreign
  govt_mission_alignment: string[];                 // e.g. ["PLI", "Make in India"]
  subsidy_land_electricity: SubsidyLandElectricity;
  capex_subsidy_available: boolean | null;
  capex_subsidy_notes: string | null;
  opex_subsidy_available: boolean | null;
  opex_subsidy_notes: string | null;

  data: Record<string, unknown>;       // deep-research payload (founders, awards, sources…)
  created_at: string;
  last_updated_at: string;
}

// ─── Task queue types ─────────────────────────────────────────────────────────

export type TaskType = 'discover' | 'enrich' | 'verify' | 'seed_drift' | 'human_review' | 'refresh';

export interface Task {
  id: string;
  type: TaskType;
  entity_id?: string;
  entity_name?: string;
  priority: number;          // lower = higher priority
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  created_at: string;
  updated_at: string;
  error?: string;
}

// ─── Agent I/O types ──────────────────────────────────────────────────────────

export interface ExtractionSchema {
  entity_type: 'company' | 'foundation' | 'scheme' | 'international_funder';
  fields_to_extract: Array<{
    field: string;
    type: string;
    required: boolean;
  }>;
  source_url: string;
  financial_year?: string;
}

export interface ExtractionResult {
  entity_id: string;
  extracted_fields: Partial<CompanyEntity>;
  missing_fields: string[];
  source_url: string;
  extracted_at: string;
  model_used: string;
}

export interface VerificationResult {
  entity_id: string;
  confirmed_fields: string[];
  conflict_fields: ConflictEntry[];
  unverified_fields: string[];
  human_review_required: boolean;
  human_review_reason?: string;
  updated_confidence: Record<string, ConfidenceLevel>;
}

export interface DriftSeedResult {
  entity_id: string;
  history_entries: ChangeHistoryEntry[];
  drift_scores: DriftScores;
  years_covered: string[];
  gaps: string[]; // years where source was unavailable
}

// ─── Scraper types ────────────────────────────────────────────────────────────

export interface FetchResult {
  url: string;
  content: string;
  content_type: 'html' | 'pdf' | 'text';
  fetched_at: string;
  success: boolean;
  error?: string;
}
