import 'dotenv/config';
import {
  claimNextTask, completeTask, failTask,
  getEntityById, updateEntityData, updateEntityStatus,
  addToHumanReview, enqueueTask, getManualOverrides, getPool
} from '../db/index.js';
import {
  extractSectors, extractGeographies, extractSpend, generateSummary,
  extractEmail, extractRegistrations, detectAcceptsProposals, scoreCompany,
  attributeAcrossSources, extractExecutiveContacts, mergeExecutiveContacts,
  applyContactOverrides, pickOfficialContact,
  detectDomainFocus, extractMoUHistory, detectOwnershipTransfer,
} from '../utils/extractor.js';
import { gatherSourceText } from '../tools/free-sources.js';
import { fetchCompanyOfficialContacts } from '../tools/official-site.js';
import { getKnownUrls } from '../tools/known-urls.js';
import { beginProgress, setStage, addSource, endProgress } from '../utils/enrichment-progress.js';
import { inferSectorsFromText, inferGeographyFromCIN, estimateSpendFromProfit } from '../utils/inference.js';
import { inferTRL } from '../utils/trl.js';
import { logger } from '../utils/logger.js';
import type { CompanyEntity, ConfidenceField, ConfidenceLevel } from '../types/index.js';

// Minimum combined text (chars) before we consider enrichment to have any signal.
const MIN_COMBINED_CHARS = 100;

// ─── Build extracted fields from the combined source corpus ──────────────────

/**
 * Run the deterministic extractors once over the combined text from all sources
 * and shape the result into the ConfidenceField record the DB/merge expects.
 */
function buildExtractedFields(combined: string, primaryUrl: string, entityName?: string, companyDomain?: string | null): Partial<CompanyEntity> {
  const now = new Date().toISOString();
  const cf = <T>(value: T | null, confidence: ConfidenceLevel): ConfidenceField<T> =>
    ({ value, confidence, source_url: primaryUrl, extracted_at: now });

  const sectors = extractSectors(combined);
  const geographies = extractGeographies(combined);
  const spend = extractSpend(combined);
  // Combined corpus mixes source-site boilerplate with company text — the
  // relevance gate stops publisher mailboxes becoming the company's contact.
  const email = extractEmail(combined, entityName, companyDomain);
  const registrations = extractRegistrations(combined);
  const acceptsProposals = detectAcceptsProposals(combined);

  const extracted: Partial<CompanyEntity> = {
    sector_focus: cf<string[]>(sectors.length ? sectors : null, sectors.length ? 'medium' : 'low'),
    geography_focus: cf<string[]>(geographies.length ? geographies : null, geographies.length ? 'medium' : 'low'),
    csr_spend_cr: cf<Record<string, number>>(spend !== null ? { latest: spend } : null, spend !== null ? 'medium' : 'low'),
    required_registrations: cf<string[]>(registrations.length ? registrations : null, registrations.length ? 'medium' : 'low'),
    contact_email: cf<string | null>(email, email ? 'high' : 'low'),
    accepts_proposals: cf<boolean>(acceptsProposals, acceptsProposals !== null ? 'medium' : 'low'),
  };

  const missing_fields: string[] = [];
  if (!sectors.length) missing_fields.push('sector_focus');
  if (!geographies.length) missing_fields.push('geography_focus');
  if (spend === null) missing_fields.push('csr_spend_cr');
  if (!registrations.length) missing_fields.push('required_registrations');
  if (!email) missing_fields.push('contact_email');
  if (acceptsProposals === null) missing_fields.push('accepts_proposals');
  // Not derivable deterministically from free text:
  missing_fields.push('implementing_mode', 'min_track_record_yrs', 'application_url');

  (extracted as any).missing_fields = missing_fields;
  (extracted as any).raw_notes = generateSummary(combined);

  return extracted;
}

// ─── Determine if entity needs human review ───────────────────────────────────

// Manual review policy: a company that fetched successfully is sent to human
// review ONLY when it carries essentially no usable signal — a low data score
// AND no sectors AND no geographies. Missing CSR spend (or accepts_proposals)
// alone no longer flags, since deterministic extraction often can't find them.
function needsHumanReview(sectors: string[], geographies: string[], score: number): { needed: boolean; reason: string } {
  if (score < 30 && sectors.length === 0 && geographies.length === 0) {
    return { needed: true, reason: `Low signal: data score ${score}, no sectors or geographies extracted` };
  }
  return { needed: false, reason: '' };
}

// ─── Search and extract stock/news (real data only) ──────────────────────────

async function enrichStockAndNews(companyName: string): Promise<{
  stockTicker: string | null;
  stockMarketData: any;
  newsData: any[];
}> {
  // LLM removed — stock and news extraction previously required an LLM to parse
  // arbitrary web pages. In deterministic mode this is skipped and empty values
  // are returned (DB shape unchanged).
  logger.debug('Stock/news enrichment skipped (deterministic LLM-free mode)', { companyName });
  return { stockTicker: null, stockMarketData: null, newsData: [] };
}

// ─── Process a single enrichment task ────────────────────────────────────────

export async function processEnrichmentTask(): Promise<boolean> {
  const task = await claimNextTask('enrich');
  if (!task) return false;

  const entityId = task.entity_id!;
  const entityName = task.entity_name!;
  const category = (task.payload.category as string) ?? 'company';

  logger.info('Enriching entity', { entityName, entityId, attempt: task.attempts });
  beginProgress(entityId, entityName);

  try {
    // Step 1 — assemble source identity (ticker/cin/website) from the curated seed
    const seed = getKnownUrls(entityName);
    const sourceEntity = {
      name: entityName,
      ticker: seed?.ticker ?? null,
      cin: seed?.cin ?? null,
      website: seed?.website ?? null,
      kind: 'company' as const,
    };

    // Extra direct URLs to fold in alongside the free providers: seed CSR pages
    // plus anything the task already carried.
    const payloadUrl = task.payload.source_url as string | undefined;
    const existingUrls = (task.payload.search_urls as string[]) ?? [];
    const extraUrls = [...(seed?.urls ?? []), ...(payloadUrl ? [payloadUrl] : []), ...existingUrls];

    // Step 2 — fetch every source (Screener, IndiaCSR, seed URLs, BSE/NSE feeds)
    // and combine text; live per-source progress feeds the dashboard modal.
    const { combined, perSource } = await gatherSourceText(sourceEntity, extraUrls, ev => {
      if (ev.phase === 'fetching') setStage(entityId, `Fetching ${ev.label}…`);
      else addSource(entityId, { label: ev.label, url: ev.url, success: !!ev.success, chars: ev.chars ?? 0 });
    });
    const usable = perSource.filter(s => s.success);

    // Step 3 — no reachable source: route to human review (NOT failed). This is an
    // environment/data limitation, not a task error, and is recoverable later.
    if (combined.trim().length < MIN_COMBINED_CHARS) {
      logger.warn('No source text reachable during enrichment', { entityName, sourcesTried: perSource.length });
      await addToHumanReview(entityId, 'No source text reachable — all free sources empty or blocked', {
        entityName,
        category,
        urls_attempted: perSource.map(s => s.url),
      });
      await completeTask(task.id);
      endProgress(entityId, 'No source text reachable — all sources empty or blocked');
      return true;
    }
    setStage(entityId, 'Extracting sectors, geographies, spend…');

    // Step 4 — deterministic extraction over the combined corpus, plus per-source
    // attribution (which source found which sector/geo) and agreement confidence.
    const extracted = buildExtractedFields(combined, usable[0].url, entityName, sourceEntity.website);
    const attribution = attributeAcrossSources(usable.map(s => ({ label: s.label, text: s.text })));
    // Lift sector_focus confidence to the strongest cross-source agreement.
    const bestAgreement = Object.values(attribution.sectorConfidence);
    if (extracted.sector_focus && (extracted.sector_focus.value as string[] | null)?.length) {
      extracted.sector_focus.confidence =
        bestAgreement.includes('high') ? 'high' : bestAgreement.includes('medium') ? 'medium' : 'low';
    }

    // Step 4.2 — executive/leadership contacts, per source (keeps the source
    // label on each contact), pooled with email-bearing entries preferred.
    setStage(entityId, 'Extracting executive contacts…');
    const contactLists = usable.map(s => extractExecutiveContacts(s.text, s.label, entityName, sourceEntity.website));

    // Step 4.2b — the company's OWN website (when the curated seed knows it).
    // Feeds ONLY contact extraction — this text is never added to `combined`,
    // so sectors/geography/spend/financial extraction are untouched by it.
    if (sourceEntity.website) {
      setStage(entityId, 'Checking official website for contacts…');
      try {
        // PSU/bank/government sites publish conventional board-of-directors
        // pages — crawl those paths unconditionally for them.
        const thorough = category === 'psu' || category === 'bank';
        const officialPages = await fetchCompanyOfficialContacts(sourceEntity.website, { thorough });
        for (const page of officialPages) {
          let found = extractExecutiveContacts(page.text, 'official-site', entityName, sourceEntity.website);
          // Leadership NAMES are trusted only on genuine leadership/board/
          // management pages; on other official pages (contact forms, footers)
          // keep only email-bearing entries — a name printed beside its email
          // on the company's own page is genuinely attributed, a bare name is not.
          const isLeadershipPage = /leadership|management|board|governance|team|director|about/i
            .test(new URL(page.url).pathname);
          if (!isLeadershipPage) found = found.filter(c => c.email);
          contactLists.push(found);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('Official-site contact fetch failed, continuing without it', { entityName, error: message });
      }
    }
    // Manual corrections (data.key_contact_overrides) always win over whatever
    // automation just extracted — a human fix must survive every re-run.
    const current = await getEntityById(entityId);
    const keyContacts = applyContactOverrides(
      mergeExecutiveContacts(contactLists),
      (current as any)?.key_contact_overrides ?? null,
    );

    // Step 4.3 — primary-contact fallback. Personal exec emails are rarely
    // public, so when raw extraction found no email, promote the best OFFICIAL
    // channel (Company Secretary → IR → CSR → general; see pickOfficialContact)
    // to contact_email. Runs BEFORE the data score so the contact counts.
    if (!extracted.contact_email?.value) {
      const official = pickOfficialContact(keyContacts);
      if (official?.email) {
        extracted.contact_email = {
          value: official.email, confidence: 'medium',
          source_url: usable[0].url, extracted_at: new Date().toISOString(),
        };
        (extracted as any).missing_fields =
          ((extracted as any).missing_fields as string[]).filter(f => f !== 'contact_email');
      }
      // When nothing real was found, contact_email stays null and the UI says
      // "No public email found". We never synthesise addresses (the old
      // guessOfficialMailboxes cosec@/csr@ pattern-guesses were fabrication).
    }

    // Step 4.5 — stock/news (no-op in deterministic mode, DB shape preserved)
    let stockAndNews = { stockTicker: null as string | null, stockMarketData: null as any, newsData: [] as any[] };
    if (category === 'company' || category === 'foundation' || category === 'psu' || category === 'bank') {
      try {
        stockAndNews = await enrichStockAndNews(entityName);
      } catch (err: any) {
        logger.warn('Stock/news enrichment failed, continuing without it', { entityName, error: err.message });
      }
    }

    // Step 5 — compute the deterministic data score
    const sectors = (extracted.sector_focus?.value as string[] | null) ?? [];
    const geographies = (extracted.geography_focus?.value as string[] | null) ?? [];
    const spendMap = extracted.csr_spend_cr?.value as Record<string, number> | null;
    const spend = spendMap && Object.keys(spendMap).length ? Math.max(...Object.values(spendMap)) : null;
    const email = (extracted.contact_email?.value as string | null) ?? null;
    const dataScore = scoreCompany({
      sectors, geographies, spend,
      hasDocument: usable.length > 0,
      hasContactInfo: !!email,
    });

    // Step 5.5 — inferred/estimated values (SYNTHETIC — kept in separate badged
    // fields, never merged into the extracted sector_focus/geography_focus/spend).
    // Industry inference runs on the company NAME only: the full corpus includes
    // financial pages (Screener etc.) whose boilerplate ("financial", "systems")
    // matched INDUSTRY_RULES and produced false positives like Financial Inclusion.
    const inferredSectors = inferSectorsFromText(entityName, sectors.length);
    const inferredGeo = inferGeographyFromCIN(sourceEntity.cin);
    const spendEstimate = estimateSpendFromProfit(combined);

    // Technology Readiness Level inferred from the CSR project descriptions.
    const trl = inferTRL(combined);

    // Platform domain focus, MoU mentions and tech-transfer openness — same
    // fields innovators carry, now detected for funders too.
    const domainFocus = detectDomainFocus(combined);
    const mouHistory = extractMoUHistory(combined);
    const ownershipTransferOpen = detectOwnershipTransfer(combined);

    // Step 6 — persist, but never overwrite user-locked (manual override) fields
    setStage(entityId, 'Saving extracted data…');
    const usableUrls = usable.map(s => s.url);
    const enrichRunAt = new Date().toISOString();
    const persist: Record<string, unknown> = {
      ...extracted,
      inferred_sectors: { value: inferredSectors.sectors, inferred: true, basis: inferredSectors.basis },
      inferred_geographies: { value: inferredGeo.geographies, inferred: true, basis: inferredGeo.basis },
      estimated_spend_cr: { value: spendEstimate.estimatedCr, estimated: true, basis: spendEstimate.basis },
      trl: { band: trl.band, min: trl.min, max: trl.max, label: trl.label, basis: trl.basis },
      key_contacts: keyContacts,
      domain_focus: domainFocus,
      mou_history: mouHistory,
      ownership_transfer_open: ownershipTransferOpen,
      stockTicker: stockAndNews.stockTicker,
      stockMarketData: stockAndNews.stockMarketData,
      newsData: stockAndNews.newsData,
      source_urls: usableUrls,
      // Labelled per-source record of THIS run (which pages answered, when) —
      // lets the UI link every field's source label to the actual URL + date.
      sources: perSource.map(s => ({
        label: s.label, url: s.url, chars: s.chars, success: s.success, fetched_at: enrichRunAt,
      })),
      enriched_at: enrichRunAt,
      extraction_count: usable.length,
      data_score: dataScore,
      sector_sources: attribution.sectorSources,
      geography_sources: attribution.geographySources,
      sector_confidence: attribution.sectorConfidence,
    };
    const overrides = await getManualOverrides(entityId);
    for (const field of ['sector_focus', 'geography_focus', 'csr_spend_cr']) {
      if (overrides[field]) delete persist[field];
    }
    await updateEntityData(entityId, persist);
    // Also keep the source_urls COLUMN in sync — the dashboard reads the column
    // (row.source_urls); before this line only insert-time discovery ever wrote
    // it, so enriched documents were invisible to the UI/data score.
    await getPool().query('UPDATE entities SET source_urls = $1 WHERE id = $2', [usableUrls, entityId]);

    const review = needsHumanReview(sectors, geographies, dataScore);
    // Status: a re-enrich refreshes DATA — it must not regress a company that
    // already passed verification. Only downgrade verified/complete when the
    // fresh data genuinely fails the quality gate (needsHumanReview); otherwise
    // keep the earned status and let the re-verify pass re-confirm it.
    // (`current` was fetched before contact-override application above.)
    const hadEarnedStatus = current?.status === 'verified' || current?.status === 'complete';
    if (!hadEarnedStatus || review.needed) {
      await updateEntityStatus(entityId, 'enriched');
    }

    // Step 7 — human review only when there's essentially no usable signal
    if (review.needed) {
      await addToHumanReview(entityId, review.reason, { score: dataScore, sectors: sectors.length, geographies: geographies.length });
    }

    // Step 8 — ALWAYS queue for verification (even if flagged for review)
    await enqueueTask({
      type: 'verify',
      entity_id: entityId,
      entity_name: entityName,
      priority: task.priority,
      payload: { source_urls: usableUrls, category },
      max_attempts: 2,
    });

    await completeTask(task.id);
    endProgress(entityId);
    logger.info('Enrichment complete', {
      entityName,
      sources: usable.length,
      combinedChars: combined.length,
      status: review.needed ? 'human_review + verification_queued' : 'verification_queued',
    });
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Enrichment task failed', { entityName, error: message });
    endProgress(entityId, message);
    await failTask(task.id, message);
    return true;
  }
}

// ─── Entry point — sequential processing (one company at a time) ─────────────

export async function runEnrichmentAgent(): Promise<void> {
  logger.info('=== Enrichment agent starting (sequential mode) ===');

  let processed = 0;
  let consecutiveEmpty = 0;

  // Process one company at a time, fully completing each before moving to the next
  while (consecutiveEmpty < 3) {
    const hadWork = await processEnrichmentTask();
    if (hadWork) {
      processed++;
      consecutiveEmpty = 0;
      logger.info(`✅ Completed entity ${processed} — moving to next`, { processed });
    } else {
      consecutiveEmpty++;
      if (consecutiveEmpty < 3) await new Promise(r => setTimeout(r, 1000));
    }
  }

  logger.info('=== Enrichment agent complete ===', { totalProcessed: processed });
}

// ─── CLI entry point (so `npm run ingest:enrich` actually runs the agent) ─────
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runEnrichmentAgent()
    .then(() => process.exit(0))
    .catch((err) => { logger.error({ err }, 'Enrichment agent failed'); process.exit(1); });
}
