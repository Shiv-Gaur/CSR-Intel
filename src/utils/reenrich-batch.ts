// In-memory "Re-enrich All" batch tracking. Companies ride the existing
// Postgres task queue (the single background worker drains enrich tasks one at
// a time, so sequential processing / concurrency 1 is guaranteed by the
// pipeline itself); innovators have no task queue, so their batch runs through
// a local p-queue with concurrency 1. Both live in this process alongside the
// dashboard server, so status endpoints read this state directly.

import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import { logger } from './logger.js';

export interface CompanyBatch {
  id: string;
  kind: 'company';
  /** task_queue ids — done/failed/queued are derived from their DB statuses. */
  taskIds: string[];
  total: number;
  createdAt: number;
}

export interface InnovatorBatch {
  id: string;
  kind: 'innovator';
  total: number;
  createdAt: number;
  done: number;
  failed: number;
  currentId: string | null;
  currentName: string | null;
  finishedAt: number | null;
}

export type Batch = CompanyBatch | InnovatorBatch;

const batches = new Map<string, Batch>();

// Batches are one-shot progress trackers; keep them around for a day so a
// left-open tab can still read the final state, then let them go.
const RETAIN_MS = 24 * 60 * 60 * 1000;
function prune(): void {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, b] of batches) {
    if (b.createdAt < cutoff) batches.delete(id);
  }
}

export function createCompanyBatch(taskIds: string[]): CompanyBatch {
  prune();
  const b: CompanyBatch = { id: randomUUID(), kind: 'company', taskIds, total: taskIds.length, createdAt: Date.now() };
  batches.set(b.id, b);
  return b;
}

export function getBatch(id: string): Batch | null {
  return batches.get(id) ?? null;
}

/**
 * Most recent batch id per kind, so a freshly loaded page (any browser, not
 * just the one that clicked the button) can attach to an in-flight batch.
 * The caller still checks the batch's live status before showing progress.
 */
export function latestBatchIds(): { company: string | null; innovator: string | null } {
  let company: CompanyBatch | null = null;
  let innovator: InnovatorBatch | null = null;
  for (const b of batches.values()) {
    if (b.kind === 'company') {
      if (!company || b.createdAt > company.createdAt) company = b;
    } else if (!innovator || b.createdAt > innovator.createdAt) {
      innovator = b;
    }
  }
  return { company: company?.id ?? null, innovator: innovator?.id ?? null };
}

/**
 * Start a sequential innovator re-enrichment batch. `enrich` is injected
 * (tools/innovator-research.enrichInnovator) to keep this module dependency-free.
 * Returns immediately; the queue drains in the background.
 */
export function startInnovatorBatch(
  items: Array<{ id: string; name: string }>,
  enrich: (id: string) => Promise<boolean>,
): InnovatorBatch {
  prune();
  const b: InnovatorBatch = {
    id: randomUUID(), kind: 'innovator', total: items.length, createdAt: Date.now(),
    done: 0, failed: 0, currentId: null, currentName: null, finishedAt: null,
  };
  batches.set(b.id, b);

  const queue = new PQueue({ concurrency: 1 }); // one innovator at a time — don't hammer sources
  for (const item of items) {
    void queue.add(async () => {
      b.currentId = item.id;
      b.currentName = item.name;
      try {
        await enrich(item.id);
        b.done++;
      } catch (err: any) {
        b.failed++;
        logger.warn('Innovator batch item failed', { name: item.name, error: err.message });
      }
    });
  }
  void queue.onIdle().then(() => {
    b.currentId = null;
    b.currentName = null;
    b.finishedAt = Date.now();
    logger.info('Innovator re-enrich batch finished', { batchId: b.id, done: b.done, failed: b.failed });
  });

  return b;
}

/** Shared timing math for status responses. */
export function batchTiming(createdAt: number, done: number, remaining: number, finishedAt?: number | null): {
  elapsed_seconds: number;
  avg_seconds_per_company: number | null;
  estimated_seconds_remaining: number | null;
} {
  const elapsed = ((finishedAt ?? Date.now()) - createdAt) / 1000;
  const avg = done > 0 ? elapsed / done : null;
  return {
    elapsed_seconds: Math.round(elapsed),
    avg_seconds_per_company: avg !== null ? Math.round(avg * 10) / 10 : null,
    estimated_seconds_remaining: avg !== null ? Math.round(avg * remaining) : null,
  };
}
