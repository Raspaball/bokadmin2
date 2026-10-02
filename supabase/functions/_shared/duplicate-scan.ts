// supabase/functions/_shared/duplicate-scan.ts
// Duplikatlisten for en jobb (pakke D del 3b). Første puls(er) skanner hele
// katalogen (runDuplicateScan i duplicates.ts) og lagrer ISBN med flere produkter
// i jobs.config.duplicates. Jobbene hopper over disse ISBN-ene til de er ryddet.
// Brukes av book-update, price-update, availability-check og sjangre-sync.

import { shopifyGraphQL } from "./shopify.ts";
import { duplicateCounts, emptyDuplicateScan, runDuplicateScan, type DuplicateScanState } from "./duplicates.ts";

/**
 * Duplikatlisten (ISBN → antall produkter), eller null når skanningen ikke er
 * ferdig: jobben er da satt på pause og fortsetter i neste puls. Oppdaterer
 * `job.config` slik at jobbens egne lagringer tar med listen.
 */
// deno-lint-ignore no-explicit-any
export async function ensureDuplicates(supabase: any, job: { id: string; config: any }, deadline: number): Promise<Record<string, number> | null> {
  if (job.config?.duplicates) return job.config.duplicates;
  const scan: DuplicateScanState = job.config?.dup_scan ?? emptyDuplicateScan();
  await runDuplicateScan(shopifyGraphQL, scan, deadline);
  if (!scan.done) {
    job.config = { ...job.config, dup_scan: scan };
    await supabase.from("jobs").update({ status: "paused", config: job.config }).eq("id", job.id);
    return null;
  }
  const { dup_scan: _d, ...rest } = job.config ?? {};
  job.config = { ...rest, duplicates: duplicateCounts(scan.counts) };
  await supabase.from("jobs").update({ config: job.config }).eq("id", job.id);
  return job.config.duplicates;
}
