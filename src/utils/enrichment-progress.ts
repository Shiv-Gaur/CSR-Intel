// In-memory live progress for enrichment runs, keyed by entity id. The
// dashboard server and the queue workers run in the same process (index.ts),
// so the dashboard's GET /api/companies/:id/enrichment-status can read this
// directly while the enrichment agent writes to it. State is ephemeral by
// design — it describes THIS run; persisted truth lives in entities.data.

export interface ProgressSource {
  label: string;
  url: string;
  success: boolean;
  chars: number;
}

export interface EnrichmentProgress {
  entityId: string;
  entityName: string;
  /** 'running' while the agent works, then 'done' or 'failed'. */
  state: 'running' | 'done' | 'failed';
  /** Human-readable current stage, e.g. "Fetching wikipedia…". */
  stage: string;
  /** Per-source fetch outcomes, appended as each fetch finishes. */
  sources: ProgressSource[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

const runs = new Map<string, EnrichmentProgress>();

// Keep finished runs visible for a while (the UI polls every 2 s and shows the
// final per-source report), then drop them so the map can't grow unbounded.
const RETAIN_FINISHED_MS = 10 * 60 * 1000;

function prune(): void {
  const cutoff = Date.now() - RETAIN_FINISHED_MS;
  for (const [id, p] of runs) {
    if (p.finishedAt && Date.parse(p.finishedAt) < cutoff) runs.delete(id);
  }
}

export function beginProgress(entityId: string, entityName: string): void {
  prune();
  runs.set(entityId, {
    entityId, entityName, state: 'running', stage: 'Starting…',
    sources: [], startedAt: new Date().toISOString(), finishedAt: null, error: null,
  });
}

export function setStage(entityId: string, stage: string): void {
  const p = runs.get(entityId);
  if (p && p.state === 'running') p.stage = stage;
}

export function addSource(entityId: string, s: ProgressSource): void {
  const p = runs.get(entityId);
  if (p && p.state === 'running') p.sources.push(s);
}

export function endProgress(entityId: string, error?: string): void {
  const p = runs.get(entityId);
  if (!p) return;
  p.state = error ? 'failed' : 'done';
  p.stage = error ? `Failed: ${error}` : 'Done';
  p.error = error ?? null;
  p.finishedAt = new Date().toISOString();
}

export function getProgress(entityId: string): EnrichmentProgress | null {
  return runs.get(entityId) ?? null;
}
