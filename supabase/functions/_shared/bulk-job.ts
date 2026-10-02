// supabase/functions/_shared/bulk-job.ts
// Felles driver for jobber over hele katalogen med Shopify Bulk Operations
// (pakke E del 5): tilgjengelighetssjekken og sjangersynken. Samme faser som
// bulk-modusen i book-update (pakke D del 3):
//   query  → bulkOperationRunQuery leser hele katalogen; URL til fila lagres
//   onix   → ONIX hentes til onix_cache i forkant (ONIX_CONCURRENCY parallelle
//            kall) for ISBN-ene jobben ber om; ferske treff i cachen hoppes over
//   plan   → BULK_CHUNK produkter om gangen: jobbens plan gir logg og (i
//            oppdateringsmodus) JSONL-linjer per mutasjon
//   apply  → én bulkOperationRunMutation per mutasjon og bit, i rekkefølge;
//            resultatfila leses og feil logges per bok
//   finish → jobbens avslutning (f.eks. samlinger), kan gå over flere pulser
// Hver puls gjør så mye den rekker på ~40 s; pg_cron gjenopptar som før.
// Jobbene eier reglene (planChunk); her ligger bare maskineriet.
//
// Beskyttede produkter og duplikater: driveren gir jobben duplikatlisten
// (ISBN med flere produkter, fra bulk-fila), og jobbens plan hopper over dem
// og beskyttede produkter før det lages en linje.

import { BulkProductAssembler, type BulkProduct, parseBulkResult, toJsonl } from "./book-bulk.ts";
import { BULK_ACTIVE, fetchBulkText, startBulkMutation, startBulkQuery, streamJsonlLines, waitForBulkOperation } from "./shopify-bulk.ts";
import { getOnixCached, ONIX_CACHE_MAX_AGE_DAYS } from "./onix-cache.ts";
import { extractIsbn } from "./isbn.js";
import { duplicateCounts } from "./duplicates.ts";

export const BULK_CHUNK = 1000;
export const ONIX_CONCURRENCY = 4;
export const BULK_DEADLINE_MS = 40_000;

export interface BulkRef { id: string; isbn: string | null; handle: string }

/** Én bulk-mutasjon jobben vil kjøre for en bit (tom `lines` = hoppes over). */
export interface BulkOpPlan {
  kind: string;
  mutation: string;
  /** Feltet i svaret (f.eks. "productUpdate"), for å lese resultatfila */
  field: string;
  lines: unknown[];
  refs: BulkRef[];
  filename: string;
}

interface PendingOp { kind: string; mutation: string; field: string; jsonl: string; refs: BulkRef[]; filename: string }

export interface BulkJobStats {
  onixCalls: number; onixOk: number; onixMissing: number; onixCached: number; onixMs: number;
  operations: number; operationMs: number; queryMs: number;
}

export interface BulkJobState {
  phase: "query" | "onix" | "plan" | "apply" | "finish";
  queryOpId?: string;
  productsUrl?: string;
  totalProducts?: number;
  /** ISBN → antall produkter, for ISBN med flere produkter (fra bulk-fila) */
  duplicates?: Record<string, number>;
  onixTodo?: string[];
  planIndex: number;
  /** Mutasjoner som venter; den første kjører når opId er satt */
  pending?: PendingOp[];
  opId?: string;
  opStartedAt?: number;
  stats: BulkJobStats;
  /** Jobbens egne data (f.eks. statusrapport, framdrift i samlinger) */
  // deno-lint-ignore no-explicit-any
  extra: Record<string, any>;
}

export function emptyBulkJobState(): BulkJobState {
  return {
    phase: "query", planIndex: 0, extra: {},
    stats: { onixCalls: 0, onixOk: 0, onixMissing: 0, onixCached: 0, onixMs: 0, operations: 0, operationMs: 0, queryMs: 0 },
  };
}

/** «Bulk: 3 operasjoner (41 s), lesing 5 s. ONIX: 120 kall på 95 s (115 hentet, 5 mangler), 330 fra cache» */
export function summarizeBulkStats(s: BulkJobStats): string {
  return `Bulk: ${s.operations} operasjoner (${Math.round(s.operationMs / 1000)} s), lesing ${Math.round(s.queryMs / 1000)} s. ` +
    `ONIX: ${s.onixCalls} kall på ${Math.round(s.onixMs / 1000)} s (${s.onixOk} hentet, ${s.onixMissing} mangler), ${s.onixCached} fra cache`;
}

// deno-lint-ignore no-explicit-any
type Supabase = any;

export interface BulkJobContext<C> {
  supabase: Supabase;
  jobId: string;
  userId: string | null;
  mode: "analyze" | "update";
  counts: C;
  state: BulkJobState;
  deadline: number;
  /** Rå ONIX fra onix_cache for ISBN-ene (de som finnes) */
  loadXml: (isbns: string[]) => Promise<Map<string, string>>;
}

export interface BulkJobSpec<C> {
  /** Loggnavn ved feil, f.eks. "availability-check (bulk)" */
  name: string;
  query: string;
  /** Feltene som trengs for å velge ONIX-ISBN (variantene kommer alltid med) */
  slimFields: readonly string[];
  onixMaxAgeDays?: number;
  /** ISBN-ene som trenger ONIX (én gang, alle produkter). Duplikatlisten er satt i ctx.state. */
  onixIsbns(products: BulkProduct[], ctx: BulkJobContext<C>): Promise<string[]> | string[];
  /** Planlegg en bit: logg-rader og mutasjoner (tomme i sjekkmodus). */
  planChunk(products: BulkProduct[], ctx: BulkJobContext<C>): Promise<{ logs: Record<string, unknown>[]; ops: BulkOpPlan[] }>;
  /** En linje feilet i Shopify: juster tellingene, returner logg-raden. */
  onLineError(ctx: BulkJobContext<C>, kind: string, ref: BulkRef, error: string): Record<string, unknown>;
  /** Etter siste bit. true = ferdig; false = fortsett i neste puls. */
  finish?(ctx: BulkJobContext<C>): Promise<boolean>;
  /** Tallene på jobbraden og result når jobben er ferdig */
  totals(ctx: BulkJobContext<C>): { succeeded: number; skipped: number; failed: number };
  result(ctx: BulkJobContext<C>): Record<string, unknown>;
}

// deno-lint-ignore no-explicit-any
export async function insertLogs(supabase: Supabase, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 500) await supabase.from("sync_log").insert(rows.slice(i, i + 500));
}

/** ISBN-ene som har fersk ONIX i cachen (bare ISBN, ikke XML). */
export async function freshOnixIsbns(supabase: Supabase, isbns: string[], maxAgeDays = ONIX_CACHE_MAX_AGE_DAYS): Promise<Set<string>> {
  const since = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  const fresh = new Set<string>();
  for (let i = 0; i < isbns.length; i += 150) {
    const { data, error } = await supabase.from("onix_cache").select("isbn").in("isbn", isbns.slice(i, i + 150)).gte("fetched_at", since);
    if (error) throw new Error(`onix_cache: ${error.message}`);
    for (const r of data ?? []) fresh.add(r.isbn);
  }
  return fresh;
}

export async function loadOnixXml(supabase: Supabase, isbns: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < isbns.length; i += 100) {
    const { data, error } = await supabase.from("onix_cache").select("isbn, xml").in("isbn", isbns.slice(i, i + 100));
    if (error) throw new Error(`onix_cache: ${error.message}`);
    for (const r of data ?? []) if (r.xml) out.set(r.isbn, r.xml);
  }
  return out;
}

/**
 * Kjør én puls av en bulk-jobb. Jobbraden må ha `config.bulk` (emptyBulkJobState)
 * og `config.counts`. `loadCounts` gir tellingene i jobbens form.
 */
export async function runBulkJob<C>(
  supabase: Supabase,
  jobId: string,
  spec: BulkJobSpec<C>,
  loadCounts: (raw: unknown) => C,
): Promise<void> {
  const startTime = Date.now();
  const deadline = startTime + BULK_DEADLINE_MS;
  const maxAge = spec.onixMaxAgeDays ?? ONIX_CACHE_MAX_AGE_DAYS;

  const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  if (!job || (job.status !== "running" && job.status !== "paused")) return;
  await supabase.from("jobs").update({ status: "running", started_at: job.started_at || new Date().toISOString() }).eq("id", jobId);

  const countsAtStart = loadCounts(job.config?.counts);
  const stateAtStart: BulkJobState = { ...emptyBulkJobState(), ...(job.config?.bulk ?? {}) };
  const state: BulkJobState = JSON.parse(JSON.stringify(stateAtStart));
  const processedAtStart: number = job.processed || 0;
  let processed = processedAtStart;
  const ctx: BulkJobContext<C> = {
    supabase, jobId, userId: job.user_id || null,
    mode: job.config?.mode === "update" ? "update" : "analyze",
    counts: loadCounts(job.config?.counts), state, deadline,
    loadXml: (isbns) => loadOnixXml(supabase, isbns),
  };

  const save = (extra: Record<string, unknown> = {}) => supabase.from("jobs").update({
    processed,
    ...spec.totals(ctx),
    config: { ...job.config, counts: ctx.counts, bulk: state },
    ...extra,
  }).eq("id", jobId);
  const cancelled = async () => (await supabase.from("jobs").select("status").eq("id", jobId).single()).data?.status === "failed";

  try {
    while (Date.now() < deadline) {
      if (await cancelled()) return;

      // ── 1. Les hele katalogen ──
      if (state.phase === "query") {
        if (!state.queryOpId) {
          state.queryOpId = await startBulkQuery(spec.query);
          await save();
        }
        const op = await waitForBulkOperation(state.queryOpId, deadline);
        if (!op) throw new Error("Fant ikke bulk-spørringen");
        if (BULK_ACTIVE.includes(op.status)) break;
        if (op.status !== "COMPLETED") throw new Error(`Bulk-spørringen endte med ${op.status} (${op.errorCode ?? "ingen feilkode"})`);
        state.productsUrl = op.url ?? undefined; // ingen URL = tom butikk
        state.stats.queryMs = Date.now() - new Date(job.started_at || job.created_at).getTime();
        state.phase = "onix";
        await save();
        continue;
      }

      // ── 2. ONIX i forkant ──
      if (state.phase === "onix") {
        if (!state.onixTodo) {
          const a = new BulkProductAssembler(() => true, spec.slimFields);
          if (state.productsUrl) await streamJsonlLines(state.productsUrl, (line) => a.add(line));
          state.totalProducts = a.count;
          const perIsbn: Record<string, number> = {};
          for (const p of a.products) {
            const isbn = extractIsbn(p);
            if (isbn) perIsbn[isbn] = (perIsbn[isbn] ?? 0) + 1;
          }
          state.duplicates = duplicateCounts(perIsbn);
          const wanted = [...new Set(await spec.onixIsbns(a.products, ctx))].filter((i) => !state.duplicates![i]);
          const fresh = await freshOnixIsbns(supabase, wanted, maxAge);
          state.stats.onixCached = fresh.size;
          state.onixTodo = wanted.filter((i) => !fresh.has(i));
          await supabase.from("jobs").update({ total_items: state.totalProducts }).eq("id", jobId);
          await save();
          continue;
        }
        while (state.onixTodo.length && Date.now() < deadline) {
          const batch = state.onixTodo.slice(0, ONIX_CONCURRENCY);
          const t0 = Date.now();
          // maxAge 0: cachen er allerede sjekket over, så dette henter alltid fra Bokbasen
          const results = await Promise.all(batch.map((isbn) => getOnixCached(isbn, ctx.userId, 0)));
          state.stats.onixMs += Date.now() - t0;
          results.forEach((r) => {
            state.stats.onixCalls++;
            if (r.xml) state.stats.onixOk++;
            else state.stats.onixMissing++;
          });
          state.onixTodo = state.onixTodo.slice(batch.length);
        }
        if (state.onixTodo.length) break;
        state.phase = "plan";
        await save();
        continue;
      }

      // ── 3. Planlegg en bit ──
      if (state.phase === "plan") {
        const total = state.totalProducts ?? 0;
        if (state.planIndex >= total) {
          state.phase = "finish";
          await save();
          continue;
        }
        const from = state.planIndex;
        const to = Math.min(total, from + BULK_CHUNK);
        const a = new BulkProductAssembler((i) => i >= from && i < to);
        await streamJsonlLines(state.productsUrl!, (line) => a.add(line));
        const { logs, ops } = await spec.planChunk(a.products, ctx);
        processed += a.products.length;
        await insertLogs(supabase, logs);
        state.planIndex = to;
        const pending = ops.filter((o) => o.lines.length).map((o) => ({
          kind: o.kind, mutation: o.mutation, field: o.field, jsonl: toJsonl(o.lines), refs: o.refs, filename: o.filename,
        }));
        if (ctx.mode === "update" && pending.length) {
          state.pending = pending;
          state.phase = "apply";
        }
        await save({ current_isbn: null });
        continue;
      }

      // ── 4. Kjør mutasjonene i rekkefølge, logg feil per bok ──
      if (state.phase === "apply") {
        const next = state.pending?.[0];
        if (!next) {
          state.pending = undefined;
          state.phase = "plan";
          continue;
        }
        if (!state.opId) {
          state.opId = await startBulkMutation(next.mutation, next.jsonl, next.filename);
          state.opStartedAt = Date.now();
          state.stats.operations++;
          await save();
        }
        const op = await waitForBulkOperation(state.opId, deadline);
        if (!op) throw new Error("Fant ikke bulk-operasjonen");
        if (BULK_ACTIVE.includes(op.status)) break;
        state.stats.operationMs += Date.now() - (state.opStartedAt ?? Date.now());

        const results = parseBulkResult(await fetchBulkText(op.url ?? op.partialDataUrl), next.field);
        const okLines = new Set(results.filter((r) => r.ok).map((r) => r.line));
        const errByLine = new Map(results.filter((r) => !r.ok).map((r) => [r.line, r.error!]));
        const logs: Record<string, unknown>[] = [];
        next.refs.forEach((ref, line) => {
          if (okLines.has(line)) return;
          const err = errByLine.get(line) ?? `mangler i resultatet (operasjonen endte med ${op.status}${op.errorCode ? `, ${op.errorCode}` : ""})`;
          logs.push(spec.onLineError(ctx, next.kind, ref, err));
        });
        await insertLogs(supabase, logs);
        state.pending = state.pending!.slice(1);
        state.opId = undefined;
        state.opStartedAt = undefined;
        await save();
        continue;
      }

      // ── 5. Avslutning ──
      if (state.phase === "finish") {
        const done = spec.finish ? await spec.finish(ctx) : true;
        if (!done) break;
        await save({
          ...spec.totals(ctx),
          status: "completed", current_isbn: null, completed_at: new Date().toISOString(), total_items: processed,
          result: { total: processed, processed, ...spec.totals(ctx), ...spec.result(ctx), bulk: state.stats },
        });
        return;
      }
      state.phase = "plan"; // ukjent tilstand: fortsett med neste bit
    }

    await save({ status: "paused", current_isbn: null });
  } catch (err) {
    console.error(`${spec.name}:`, err);
    const msg = String(err);
    const fatal = msg.includes("HTTP 401") || msg.includes("HTTP 403");
    // Tilstanden fra pulsstart, men en startet operasjon beholdes (ellers sendes den på nytt)
    const keep = state.opId && state.opId !== stateAtStart.opId ? state : stateAtStart;
    await supabase.from("jobs").update({
      status: fatal ? "failed" : "paused",
      error_message: msg,
      processed: keep === state ? processed : processedAtStart,
      config: { ...job.config, counts: keep === state ? ctx.counts : countsAtStart, bulk: keep },
    }).eq("id", jobId);
  }
}
