// supabase/functions/book-update/index.ts
// Jobben «Oppdater eksisterende bøker» (pakke B del 8). Går gjennom alle
// produkter med ISBN i butikken, regner ut standarden fra ONIX
// (_shared/book-update.ts: planBookUpdate) og oppdaterer bare det som er
// annerledes. Endrer aldri pris, status, tilgjengelighet, handle eller tittel.
//
// Samme rammeverk som price-update: pulser på 45 s, cursor + page_start_index,
// pauset → gjenopptas av pg_cron (resume-paused-book-update-jobs) eller siden.
// Sjekkmodus (analyze, standard) endrer ingenting.
//
// Endepunkter: POST /start { mode?: "analyze" | "update", isbns?: string[], bulk?: boolean },
// GET /status/:jobId, POST /cancel/:jobId, POST /resume/:jobId,
// POST /resume-paused, GET /active, GET /recent?limit=
//
// Deploy: supabase functions deploy book-update --no-verify-jwt --use-api --project-ref chwpqwblqummlufqdefe

import { currentShopDomain, stopIfShopChanged } from "../_shared/job-shop.ts";
import { resumableJobFilter } from "../_shared/job-resume.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { ALL_PRODUCT_STATUSES, shopifyGraphQL, waitForShopifyBudget } from "../_shared/shopify.ts";
import { getCaller } from "../_shared/auth.ts";
import { BOK_ISBN_FIELD, extractIsbn } from "../_shared/isbn.js";
import { getOnixCached } from "../_shared/onix-cache.ts";
import {
  BULK_COVER_MUTATION, BULK_PRODUCT_UPDATE_MUTATION, BULK_PRODUCTS_QUERY, BulkProductAssembler,
  bulkCoverLine, bulkUpdateLine, parseBulkResult, toJsonl,
} from "../_shared/book-bulk.ts";
import { BULK_ACTIVE, fetchBulkText, startBulkMutation, startBulkQuery, streamJsonlLines, waitForBulkOperation } from "../_shared/shopify-bulk.ts";
import { channelsToPublish, getAllPublicationIds, PUBLISH_BULK_MUTATION, publishBulkLine } from "../_shared/publish.ts";
import { extractProductForm } from "../_shared/onix.js";
import { beginPlanSlice, clearChunkLogs, freshOnixIsbns, insertLogs, loadOnixXml, PLAN_BUDGET_MS, readPlanSlice } from "../_shared/bulk-job.ts";
import { isFatalJobError, protectedProduct, protectedProductMessage } from "../_shared/protected.ts";
import { ensureProtectedMembers } from "../_shared/protected-load.ts";
import { bookFormat, notBookSkip, NOT_IN_BOKBASEN_MESSAGE } from "../_shared/book-format.ts";
import { changedRow, errorRow, NO_ISBN_MESSAGE, skipRow, unchangedRow, type JobLogRow, type LogBase } from "../_shared/job-log.ts";
import { ensureDuplicates } from "../_shared/duplicate-scan.ts";
import { duplicateCounts, duplicateMessage } from "../_shared/duplicates.ts";
import {
  BOOK_UPDATE_PRODUCT_FIELDS, countPlan, loadBookUpdateCounts, planBookUpdate, summarizeBookUpdate,
  type BookUpdatePlan, type ShopifyBookProduct,
} from "../_shared/book-update.ts";

const JOB_TYPE = "book_update";
const PAGE_SIZE = 50; // mange felt per produkt: holder kostnaden per side nede
const TIMEOUT_MS = 45_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, key);
}


// ── Shopify ─────────────────────────────────────────────────────────────────

type Product = ShopifyBookProduct & { bokIsbn?: { value: string } | null; variants?: { nodes: Array<{ barcode: string | null; sku: string | null }> } };

const PRODUCTS_PAGE_QUERY = `
  query bookUpdatePage($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "${ALL_PRODUCT_STATUSES}") {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${BOOK_UPDATE_PRODUCT_FIELDS}
        ${BOK_ISBN_FIELD}
        variants(first: 1) { nodes { barcode sku } }
      }
    }
  }
`;

const PRODUCT_UPDATE = `
  mutation bookUpdateProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id } userErrors { field message } }
  }
`;

const METAFIELDS_SET = `
  mutation bookUpdateMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
  }
`;

const METAFIELDS_DELETE = `
  mutation bookUpdateMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { deletedMetafields { key namespace ownerId } userErrors { field message } }
  }
`;

/** Sletter metafelt (pakke G: «Norge» som forfatter, format «Annet»). Kaster med Shopifys melding ved feil. */
async function deleteMetafields(list: BookUpdatePlan["metafieldDeletes"]): Promise<void> {
  for (let i = 0; i < list.length; i += 25) {
    const r = await shopifyGraphQL(METAFIELDS_DELETE, { metafields: list.slice(i, i + 25) });
    const e = (r.data?.metafieldsDelete?.userErrors ?? []).map((x: { message: string }) => x.message).join(", ");
    if (e) throw new Error(`metafieldsDelete: ${e}`);
    await waitForShopifyBudget(r.extensions, 100);
  }
}

const FILE_UPDATE = `
  mutation bookUpdateCover($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) { files { id } userErrors { field message code } }
  }
`;

async function fetchPage(cursor: string | null) {
  const res = await shopifyGraphQL<{ products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Product[] } }>(
    PRODUCTS_PAGE_QUERY, { first: PAGE_SIZE, after: cursor },
  );
  await waitForShopifyBudget(res.extensions, 400);
  return res.data.products;
}

async function getProductCount(): Promise<number> {
  try {
    const { data } = await shopifyGraphQL<{ productsCount: { count: number } }>(`{ productsCount(query: "${ALL_PRODUCT_STATUSES}") { count } }`);
    return data.productsCount?.count || 0;
  } catch {
    return 0;
  }
}

/** Gjør endringene i planen. Kaster med Shopifys melding ved feil. */
async function applyPlan(productId: string, plan: BookUpdatePlan): Promise<void> {
  const errs = (list: Array<{ message: string }> | undefined) => (list ?? []).map((e) => e.message).join(", ");
  if (Object.keys(plan.product).length) {
    const r = await shopifyGraphQL(PRODUCT_UPDATE, { product: { id: productId, ...plan.product } });
    const e = errs(r.data?.productUpdate?.userErrors);
    if (e) throw new Error(`productUpdate: ${e}`);
    await waitForShopifyBudget(r.extensions, 100);
  }
  if (plan.metafields.length) {
    const r = await shopifyGraphQL(METAFIELDS_SET, { metafields: plan.metafields });
    const e = errs(r.data?.metafieldsSet?.userErrors);
    if (e) throw new Error(`metafieldsSet: ${e}`);
    await waitForShopifyBudget(r.extensions, 100);
  }
  if (plan.metafieldDeletes.length) await deleteMetafields(plan.metafieldDeletes);
  if (plan.cover) {
    const r = await shopifyGraphQL(FILE_UPDATE, { files: [{ id: plan.cover.mediaId, ...plan.cover.change }] });
    const e = errs(r.data?.fileUpdate?.userErrors);
    if (e) throw new Error(`fileUpdate: ${e}`);
    await waitForShopifyBudget(r.extensions, 100);
  }
}

// ── Jobben ──────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Supabase = any;

/** Produktene i de beskyttede samlingene (wrendale), hentet hver puls. Mangler samlingen: jobben stopper (false). */
async function loadProtectedOrFail(supabase: Supabase, jobId: string): Promise<boolean> {
  try {
    await ensureProtectedMembers(0);
    return true;
  } catch (err) {
    await supabase.from("jobs").update({ status: "failed", error_message: String(err), completed_at: new Date().toISOString() }).eq("id", jobId);
    return false;
  }
}

/** Loggraden for et produkt med plan: endret (feltene), eller uendret med merknadene. */
function bookUpdatePlanRow(base: LogBase, plan: BookUpdatePlan, verb: string): JobLogRow {
  const notes = plan.notes.length ? ` (${plan.notes.join("; ")})` : "";
  if (!plan.changes.length) return unchangedRow(base, `Uendret${notes}`);
  const what = plan.changes.map((c) => `${c.field}: ${c.from || "(tom)"} → ${c.to}`).join("; ");
  return changedRow(base, `${verb}: ${what}${notes}`, plan.changes.map((c) => c.field));
}

async function processBatch(jobId: string) {
  const supabase = getSupabase();
  // Bulk-modus har egen løkke (se processBulk)
  const { data: kind } = await supabase.from("jobs").select("config").eq("id", jobId).single();
  if (kind?.config?.bulk) return processBulk(jobId);
  const startTime = Date.now();

  const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  if (!job || (job.status !== "running" && job.status !== "paused")) return;
  if (await stopIfShopChanged(supabase, job)) return;

  await supabase.from("jobs").update({ status: "running", started_at: job.started_at || new Date().toISOString() }).eq("id", jobId);
  if (!await loadProtectedOrFail(supabase, jobId)) return;

  // ISBN med flere produkter (pakke D del 3b): skannes én gang per jobb, så hoppes de over
  const duplicates = await ensureDuplicates(supabase, job, startTime + 30_000);
  if (!duplicates) return; // skanningen fortsetter i neste puls

  const mode: "analyze" | "update" = job.config?.mode === "update" ? "update" : "analyze";
  const only: string[] | null = Array.isArray(job.config?.isbns) && job.config.isbns.length ? job.config.isbns : null;
  const cursor: string | null = job.config?.shopify_cursor || null;
  const pageStartIndex: number = job.config?.page_start_index || 0;
  const userId: string | null = job.user_id || null;
  const countsAtStart = loadBookUpdateCounts(job.config?.counts);
  const counts = loadBookUpdateCounts(job.config?.counts);
  let processed = job.processed || 0;

  const save = (extra: Record<string, unknown>) => supabase.from("jobs").update({
    processed,
    succeeded: counts.changed,
    skipped: counts.unchanged + counts.skippedNoIsbn + counts.skippedNoOnix + counts.skippedNotBook + counts.skippedProtected + counts.skippedDuplicate,
    failed: counts.errors,
    ...extra,
  }).eq("id", jobId);

  try {
    const page = await fetchPage(cursor);

    for (let i = pageStartIndex; i < page.nodes.length; i++) {
      const product = page.nodes[i];

      const { data: fresh } = await supabase.from("jobs").select("status").eq("id", jobId).single();
      if (fresh?.status === "failed") return; // avbrutt

      if (Date.now() - startTime > TIMEOUT_MS) {
        await save({ status: "paused", current_isbn: null, config: { ...job.config, shopify_cursor: cursor, page_start_index: i, counts } });
        return;
      }

      const isbn = extractIsbn(product);
      if (only && (!isbn || !only.includes(isbn))) continue; // ikke valgt i denne kjøringen
      processed++;
      // Én loggrad per produkt (pakke F del 3.1)
      const base: LogBase = { isbn, title: product.handle, action: "book_update", shopify_id: product.id, job_id: jobId, user_id: userId };
      const log = (row: JobLogRow) => supabase.from("sync_log").insert(row);
      // Beskyttet (tagg, leverandør Wrendale eller samling wrendale): aldri rørt, ikke engang ONIX-oppslag
      if (protectedProduct(product)) {
        counts.skippedProtected++;
        await log(skipRow(base, "beskyttet", protectedProductMessage(product)));
        continue;
      }
      if (!isbn) { counts.skippedNoIsbn++; await log(skipRow(base, "ingen_isbn", NO_ISBN_MESSAGE)); continue; }
      if (duplicates[isbn]) {
        counts.skippedDuplicate++;
        await log(skipRow(base, "duplikat", duplicateMessage(duplicates[isbn])));
        continue;
      }

      await supabase.from("jobs").update({ current_isbn: isbn, processed }).eq("id", jobId);

      try {
        const onix = await getOnixCached(isbn, userId);
        if (!onix.xml) {
          counts.skippedNoOnix++;
          await log(skipRow(base, "ikke_i_bokbasen", NOT_IN_BOKBASEN_MESSAGE));
          continue;
        }
        const notBook = notBookSkip(onix.xml);
        if (notBook) {
          counts.skippedNotBook++;
          await log(skipRow(base, "ikke_bok", notBook));
          continue;
        }

        const plan = planBookUpdate(product, onix.xml);
        if (plan.changes.length && mode === "update") await applyPlan(product.id, plan);
        countPlan(counts, product.handle, plan, isbn);
        await log(bookUpdatePlanRow(base, plan, mode === "update" ? "Endret" : "Ville endret"));
      } catch (err) {
        counts.errors++;
        await log(errorRow(base, `Feil: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    const done = !page.pageInfo.hasNextPage;
    await save({
      status: done ? "completed" : "paused",
      current_isbn: null,
      config: { ...job.config, shopify_cursor: page.pageInfo.endCursor, page_start_index: 0, counts },
      ...(done ? {
        completed_at: new Date().toISOString(),
        total_items: processed,
        result: { processed, counts, summary: summarizeBookUpdate(counts, mode) },
      } : {}),
    });
  } catch (err) {
    console.error("book-update:", err);
    const msg = String(err);
    const fatal = isFatalJobError(msg);
    // Markøren rulles tilbake til pulsstart, og tallene med den
    await supabase.from("jobs").update({
      status: fatal ? "failed" : "paused",
      error_message: msg,
      processed: job.processed || 0,
      config: { ...job.config, shopify_cursor: cursor, page_start_index: pageStartIndex, counts: countsAtStart },
    }).eq("id", jobId);
  }
}

// ── Bulk-modus (pakke D del 3) ──────────────────────────────────────────────
// Samme regel (planBookUpdate), men hele katalogen leses med bulkOperationRunQuery
// og endringene sendes som JSONL med bulkOperationRunMutation. Faser i config.bulk:
//   query  → bulk-spørringen kjører; URL til fila lagres
//   onix   → ONIX hentes til onix_cache i forkant (ONIX_CONCURRENCY parallelle kall)
//   plan   → små porsjoner planlegges (se beginPlanSlice i bulk-job.ts); sjekk: bare telling, oppdatering: én
//            productUpdate-operasjon (+ én fileUpdate for omslag) per bit
//   apply  → venter på operasjonen og logger feil per bok, så neste bit
// Hver puls gjør så mye den rekker på ~40 s; pg_cron gjenopptar som før.

const ONIX_CONCURRENCY = 4;
const BULK_DEADLINE_MS = 40_000;

interface BulkLineRef { id: string; isbn: string | null; handle: string }
interface ApplyOp { kind: "product" | "cover" | "publish"; jsonl: string; refs: BulkLineRef[] }
interface BulkState {
  phase: "query" | "onix" | "plan" | "apply";
  queryOpId?: string;
  productsUrl?: string;
  totalProducts?: number;
  onixTodo?: string[];
  /** ISBN → antall produkter, for ISBN med flere produkter (fra bulk-fila) */
  duplicates?: Record<string, number>;
  onixMissing?: string[];
  planIndex: number;
  planByte?: number;
  chunk?: number;
  attempt?: { index: number; n: number };
  /** `queue`: operasjonene som kjøres etter denne (omslag, publisering). coverJsonl/coverRefs: gammel form, leses fortsatt */
  apply?: {
    kind: "product" | "cover" | "publish"; opId: string; refs: BulkLineRef[]; coverJsonl?: string; coverRefs?: BulkLineRef[]; startedAt: number;
    queue?: ApplyOp[];
  };
  stats: { onixCalls: number; onixOk: number; onixMissing: number; onixCached: number; onixMs: number; operations: number; operationMs: number; queryMs: number };
}

function emptyBulkState(): BulkState {
  return { phase: "query", planIndex: 0, stats: { onixCalls: 0, onixOk: 0, onixMissing: 0, onixCached: 0, onixMs: 0, operations: 0, operationMs: 0, queryMs: 0 } };
}

/** «Bulk: 3 operasjoner (41 s), ONIX: 120 kall på 95 s (115 hentet, 5 mangler), 330 fra cache» */
function summarizeBulk(s: BulkState["stats"]): string {
  return `Bulk: ${s.operations} operasjoner (${Math.round(s.operationMs / 1000)} s), lesing ${Math.round(s.queryMs / 1000)} s. ` +
    `ONIX: ${s.onixCalls} kall på ${Math.round(s.onixMs / 1000)} s (${s.onixOk} hentet, ${s.onixMissing} mangler), ${s.onixCached} fra cache`;
}

// insertLogs, freshOnixIsbns og loadOnixXml: felles i _shared/bulk-job.ts

/** Starter bulk-mutasjonen for én operasjon i apply-køen */
async function startApplyOp(op: ApplyOp): Promise<NonNullable<BulkState["apply"]>> {
  const [mutation, file] = op.kind === "product" ? [BULK_PRODUCT_UPDATE_MUTATION, "book-update.jsonl"]
    : op.kind === "cover" ? [BULK_COVER_MUTATION, "book-cover.jsonl"]
    : [PUBLISH_BULK_MUTATION, "book-publish.jsonl"];
  const opId = await startBulkMutation(mutation, op.jsonl, file);
  return { kind: op.kind, opId, refs: op.refs, startedAt: Date.now() };
}

async function processBulk(jobId: string) {
  const supabase = getSupabase();
  const startTime = Date.now();
  const deadline = startTime + BULK_DEADLINE_MS;

  const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  if (!job || (job.status !== "running" && job.status !== "paused")) return;
  if (await stopIfShopChanged(supabase, job)) return;
  await supabase.from("jobs").update({ status: "running", started_at: job.started_at || new Date().toISOString() }).eq("id", jobId);
  if (!await loadProtectedOrFail(supabase, jobId)) return;

  const mode: "analyze" | "update" = job.config?.mode === "update" ? "update" : "analyze";
  const only: Set<string> | null = Array.isArray(job.config?.isbns) && job.config.isbns.length ? new Set(job.config.isbns) : null;
  const userId: string | null = job.user_id || null;
  const countsAtStart = loadBookUpdateCounts(job.config?.counts);
  const counts = loadBookUpdateCounts(job.config?.counts);
  const stateAtStart: BulkState = job.config?.bulk ?? emptyBulkState();
  const state: BulkState = JSON.parse(JSON.stringify(stateAtStart));
  const processedAtStart: number = job.processed || 0;
  let processed = processedAtStart;

  let planMs = 0; // tid brukt i planfasen denne pulsen (PLAN_BUDGET_MS)
  const save = (extra: Record<string, unknown> = {}) => supabase.from("jobs").update({
    processed,
    succeeded: counts.changed,
    skipped: counts.unchanged + counts.skippedNoIsbn + counts.skippedNoOnix + counts.skippedNotBook + counts.skippedProtected + counts.skippedDuplicate,
    failed: counts.errors,
    config: { ...job.config, counts, bulk: state },
    ...extra,
  }).eq("id", jobId);
  const cancelled = async () => (await supabase.from("jobs").select("status").eq("id", jobId).single()).data?.status === "failed";

  try {
    while (Date.now() < deadline) {
      if (await cancelled()) return;

      // ── 1. Les hele katalogen ──
      if (state.phase === "query") {
        if (!state.queryOpId) {
          state.queryOpId = await startBulkQuery(BULK_PRODUCTS_QUERY);
          await save();
        }
        const op = await waitForBulkOperation(state.queryOpId, deadline, 2000, () => save());
        if (!op) throw new Error("Fant ikke bulk-spørringen");
        if (BULK_ACTIVE.includes(op.status)) break;
        if (op.status !== "COMPLETED" || !op.url) {
          if (op.status === "COMPLETED") { // tom butikk
            state.totalProducts = 0;
            state.phase = "plan";
            continue;
          }
          throw new Error(`Bulk-spørringen endte med ${op.status} (${op.errorCode ?? "ingen feilkode"})`);
        }
        state.productsUrl = op.url;
        state.stats.queryMs = Date.now() - new Date(job.started_at || job.created_at).getTime();
        state.phase = "onix";
        await save();
        continue;
      }

      // ── 2. ONIX i forkant ──
      if (state.phase === "onix") {
        if (!state.onixTodo) {
          const isbns: string[] = [];
          // Bare ISBN og tagger trengs her (slim)
          const a = new BulkProductAssembler(() => true, true);
          await streamJsonlLines(state.productsUrl!, (line) => a.add(line));
          state.totalProducts = a.count;
          const perIsbn: Record<string, number> = {};
          for (const p of a.products) {
            const isbn = extractIsbn(p);
            if (isbn) perIsbn[isbn] = (perIsbn[isbn] ?? 0) + 1;
            if (isbn && !protectedProduct(p) && (!only || only.has(isbn))) isbns.push(isbn);
          }
          state.duplicates = duplicateCounts(perIsbn);
          const unique = [...new Set(isbns)].filter((i) => !state.duplicates![i]);
          const fresh = await freshOnixIsbns(supabase, unique);
          state.stats.onixCached = fresh.size;
          state.onixTodo = unique.filter((i) => !fresh.has(i));
          state.onixMissing = [];
          await supabase.from("jobs").update({ total_items: only ? only.size : state.totalProducts }).eq("id", jobId);
          await save();
          continue;
        }
        let lastBeat = Date.now();
        while (state.onixTodo.length && Date.now() < deadline) {
          const batch = state.onixTodo.slice(0, ONIX_CONCURRENCY);
          // Livstegn (pakke F del 3.2): siste ISBN og hvor mange som gjenstår, minst hvert 20. s
          if (Date.now() - lastBeat > 20_000) { lastBeat = Date.now(); await save({ current_isbn: batch[0] }); }
          const t0 = Date.now();
          const results = await Promise.all(batch.map((isbn) => getOnixCached(isbn, userId)));
          state.stats.onixMs += Date.now() - t0;
          results.forEach((r, i) => {
            state.stats.onixCalls++;
            if (r.xml) state.stats.onixOk++;
            else { state.stats.onixMissing++; state.onixMissing!.push(batch[i]); }
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
          const summary = `${summarizeBookUpdate(counts, mode)}. ${summarizeBulk(state.stats)}`;
          await save({
            status: "completed", current_isbn: null, completed_at: new Date().toISOString(), total_items: processed,
            result: { processed, counts, bulk: state.stats, summary },
          });
          return;
        }
        // Tidsbudsjett per puls: resten tas av neste puls (pg_cron)
        if (planMs >= PLAN_BUDGET_MS) break;
        const tPlan = Date.now();
        const slice = beginPlanSlice(state);
        if (slice.stuck) {
          await supabase.from("jobs").update({
            status: "failed", error_message: slice.stuck, completed_at: new Date().toISOString(),
            config: { ...job.config, counts, bulk: state },
          }).eq("id", jobId);
          return;
        }
        await save(); // forsøket lagres før arbeidet: dør pulsen, teller det neste gang
        const { products: chunkProducts, to, nextByte } = await readPlanSlice(state, slice.size, total);
        const xmlByIsbn = await loadOnixXml(supabase, chunkProducts.map((p) => extractIsbn(p)).filter((i): i is string => !!i && (!only || only.has(i))));

        const logs: Record<string, unknown>[] = [];
        const productLines: unknown[] = [], productRefs: BulkLineRef[] = [];
        const coverLines: unknown[] = [], coverRefs: BulkLineRef[] = [];
        const publishLines: unknown[] = [], publishRefs: BulkLineRef[] = [];
        const allChannels = await getAllPublicationIds(); // _shared/publish.ts
        for (const product of chunkProducts) {
          const isbn = extractIsbn(product);
          if (only && (!isbn || !only.has(isbn))) continue;
          processed++;
          const base = { isbn, title: product.handle, action: "book_update", shopify_id: product.id, job_id: jobId, user_id: userId };
          // Én loggrad per produkt (pakke F del 3.1)
          if (protectedProduct(product)) {
            counts.skippedProtected++;
            logs.push(skipRow(base, "beskyttet", protectedProductMessage(product)));
            continue;
          }
          if (!isbn) { counts.skippedNoIsbn++; logs.push(skipRow(base, "ingen_isbn", NO_ISBN_MESSAGE)); continue; }
          const dup = state.duplicates?.[isbn];
          if (dup) {
            counts.skippedDuplicate++;
            logs.push(skipRow(base, "duplikat", duplicateMessage(dup)));
            continue;
          }
          const xml = xmlByIsbn.get(isbn);
          if (!xml) {
            counts.skippedNoOnix++;
            logs.push(skipRow(base, "ikke_i_bokbasen", NOT_IN_BOKBASEN_MESSAGE));
            continue;
          }
          const notBook = notBookSkip(xml);
          if (notBook) {
            counts.skippedNotBook++;
            logs.push(skipRow(base, "ikke_bok", notBook));
            continue;
          }
          const plan = planBookUpdate(product, xml);
          countPlan(counts, product.handle, plan, isbn);
          const planRow = bookUpdatePlanRow(base, plan, mode === "update" ? "Sendt i bulk" : "Ville endret");
          logs.push(planRow);
          // Aktive bøker som mangler salgskanaler (pakke H del 2): lydbøker, e-bøker og beskyttede røres ikke
          const form = extractProductForm(xml);
          const missing = channelsToPublish(allChannels, product, bookFormat(form.form, form.details).productType, product.status === "ACTIVE");
          const ref = { id: product.id, isbn, handle: product.handle };
          if (missing.length) {
            counts.publishProducts++;
            counts.publishChannels += missing.length;
            planRow.message = `${planRow.message} + ${mode === "update" ? "publiseres" : "ville blitt publisert"} på ${missing.length} kanaler`;
            if (mode === "update") { publishLines.push(publishBulkLine(product.id, missing)); publishRefs.push(ref); }
          }
          if (!plan.changes.length || mode !== "update") continue;
          const pl = bulkUpdateLine(product, plan);
          if (pl) { productLines.push(pl); productRefs.push(ref); }
          const cl = bulkCoverLine(product, plan);
          if (cl) { coverLines.push(cl); coverRefs.push(ref); }
          // Sletting av metafelt (få, ikke i bulk): egen vanlig mutasjon per bok
          if (plan.metafieldDeletes.length) {
            try { await deleteMetafields(plan.metafieldDeletes); } catch (e) {
              counts.errors++;
              counts.changed = Math.max(0, counts.changed - 1);
              logs.push(errorRow(base, `Feil ved sletting av metafelt: ${String(e)}`));
            }
          }
        }
        await clearChunkLogs(supabase, jobId, chunkProducts.map((p) => p.id));
        await insertLogs(supabase, logs);
        state.planIndex = to;
        state.planByte = nextByte;
        state.attempt = undefined;
        planMs += Date.now() - tPlan;

        if (mode === "update" && (productLines.length || coverLines.length || publishLines.length)) {
          // Rekkefølge: produkt/metafelt, omslag, publisering. Resten ligger i køen til første er ferdig
          const ops: ApplyOp[] = [];
          if (productLines.length) ops.push({ kind: "product", jsonl: toJsonl(productLines), refs: productRefs });
          if (coverLines.length) ops.push({ kind: "cover", jsonl: toJsonl(coverLines), refs: coverRefs });
          if (publishLines.length) ops.push({ kind: "publish", jsonl: toJsonl(publishLines), refs: publishRefs });
          const first = ops.shift()!;
          state.apply = { ...(await startApplyOp(first)), queue: ops };
          state.stats.operations++;
          state.phase = "apply";
        }
        await save();
        continue;
      }

      // ── 4. Vent på operasjonen og logg feil per bok ──
      if (state.phase === "apply" && state.apply) {
        const ap = state.apply;
        const op = await waitForBulkOperation(ap.opId, deadline, 2000, () => save());
        if (!op) throw new Error("Fant ikke bulk-operasjonen");
        if (BULK_ACTIVE.includes(op.status)) break;
        state.stats.operationMs += Date.now() - ap.startedAt;

        const field = ap.kind === "product" ? "productUpdate" : ap.kind === "cover" ? "fileUpdate" : "publishablePublish";
        const results = parseBulkResult(await fetchBulkText(op.url ?? op.partialDataUrl), field);
        const okLines = new Set(results.filter((r) => r.ok).map((r) => r.line));
        const errByLine = new Map(results.filter((r) => !r.ok).map((r) => [r.line, r.error!]));
        const logs: Record<string, unknown>[] = [];
        ap.refs.forEach((ref, line) => {
          if (okLines.has(line)) return;
          const err = errByLine.get(line) ?? `mangler i resultatet (operasjonen endte med ${op.status}${op.errorCode ? `, ${op.errorCode}` : ""})`;
          counts.errors++;
          if (ap.kind === "product") counts.changed = Math.max(0, counts.changed - 1);
          logs.push(errorRow({ isbn: ref.isbn, title: ref.handle, action: "book_update", shopify_id: ref.id, job_id: jobId, user_id: userId },
            `Feil i bulk (${ap.kind === "product" ? "produkt/metafelt" : ap.kind === "cover" ? "omslag" : "publisering på kanaler"}): ${err}`));
        });
        await insertLogs(supabase, logs);

        // Gammel form (coverJsonl) leses som en kø med én operasjon
        const queue = ap.queue ?? (ap.coverJsonl ? [{ kind: "cover" as const, jsonl: ap.coverJsonl, refs: ap.coverRefs ?? [] }] satisfies ApplyOp[] : []);
        if (queue.length) {
          const [next, ...rest] = queue;
          state.apply = { ...(await startApplyOp(next)), queue: rest };
          state.stats.operations++;
        } else {
          state.apply = undefined;
          state.phase = "plan";
        }
        await save();
        continue;
      }
      state.phase = "plan"; // ukjent tilstand: fortsett med neste bit
    }

    await save({ status: "paused", current_isbn: null });
  } catch (err) {
    console.error("book-update (bulk):", err);
    const msg = String(err);
    const fatal = isFatalJobError(msg);
    // Tilstanden fra pulsstart, men en startet operasjon beholdes (ellers sendes den på nytt)
    const keep: BulkState = state.apply && !stateAtStart.apply ? state : stateAtStart;
    // Forsøksmarkøren beholdes også når tilstanden rulles tilbake, ellers telles aldri feilen
    if (keep !== state && state.attempt && state.attempt.index === keep.planIndex) { keep.attempt = state.attempt; keep.chunk = state.chunk; }
    await supabase.from("jobs").update({
      status: fatal ? "failed" : "paused",
      error_message: msg,
      processed: keep === state ? processed : processedAtStart,
      config: { ...job.config, counts: keep === state ? counts : countsAtStart, bulk: keep },
    }).eq("id", jobId);
  }
}

// ── Endepunkter ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/book-update\/?/, "");
    const supabase = getSupabase();
    // Verifisert bruker (auth.getUser i _shared/auth.ts), aldri lest rett fra tokenet
    const jwtUserId = (await getCaller(req)).userId;

    // POST /start { mode?, isbns? } — uten mode: sjekk
    if (path === "start" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      // Ingen planlagte oppgaver for denne jobben: user_id i body godtas ikke
      const userId = jwtUserId;
      const mode = body.mode === "update" ? "update" : "analyze";
      // bulk: true → hele katalogen med Shopify Bulk Operations (pakke D del 3)
      const bulk = body.bulk === true;
      const isbns = Array.isArray(body.isbns) ? body.isbns.map(String).filter((s: string) => /^\d{13}$/.test(s)) : null;

      let existingQ = supabase.from("jobs").select("id").eq("type", JOB_TYPE).in("status", ["running", "paused", "pending"]).limit(1);
      existingQ = userId ? existingQ.eq("user_id", userId) : existingQ.is("user_id", null);
      const { data: existing } = await existingQ;
      if (existing?.length) return json({ error: "Oppdatering av bøker kjører allerede", jobId: existing[0].id }, 409);

      const total = isbns?.length ?? await getProductCount();
      const { data: job, error } = await supabase.from("jobs").insert({
        type: JOB_TYPE, status: "running", user_id: userId, shop_domain: currentShopDomain(), started_at: new Date().toISOString(), total_items: total,
        config: { mode, isbns: isbns?.length ? isbns : null, shopify_cursor: null, ...(bulk ? { bulk: emptyBulkState() } : {}) },
      }).select().single();
      if (error || !job) return json({ error: "Kunne ikke opprette jobb" }, 500);

      // @ts-ignore
      EdgeRuntime.waitUntil(processBatch(job.id));
      return json({ jobId: job.id, status: "running", mode, bulk }, 202);
    }

    const userId = jwtUserId;
    const owns = (job: { user_id: string | null }) => !(userId && job.user_id && job.user_id !== userId);

    const statusMatch = path.match(/^status\/(.+)$/);
    if (statusMatch && req.method === "GET") {
      const { data: job } = await supabase.from("jobs").select("*").eq("id", statusMatch[1]).single();
      if (!job) return json({ error: "Jobb ikke funnet" }, 404);
      if (!owns(job)) return json({ error: "Ingen tilgang til denne jobben" }, 403);
      return json(job);
    }

    const cancelMatch = path.match(/^cancel\/(.+)$/);
    if (cancelMatch && req.method === "POST") {
      const { data: job } = await supabase.from("jobs").select("id, user_id").eq("id", cancelMatch[1]).single();
      if (!job) return json({ error: "Jobb ikke funnet" }, 404);
      if (!owns(job)) return json({ error: "Ingen tilgang til denne jobben" }, 403);
      await supabase.from("jobs").update({ status: "failed", error_message: "Avbrutt av bruker", completed_at: new Date().toISOString() })
        .eq("id", job.id).in("status", ["running", "paused", "pending"]);
      return json({ status: "cancelled" });
    }

    const resumeMatch = path.match(/^resume\/(.+)$/);
    if (resumeMatch && req.method === "POST") {
      const { data: job } = await supabase.from("jobs").select("id, user_id").eq("id", resumeMatch[1]).single();
      if (!job) return json({ error: "Jobb ikke funnet" }, 404);
      if (!owns(job)) return json({ error: "Ingen tilgang til denne jobben" }, 403);
      // @ts-ignore
      EdgeRuntime.waitUntil(processBatch(job.id));
      return json({ status: "resuming", jobId: job.id }, 202);
    }

    // POST /resume-paused — pg_cron (anon-nøkkel, ingen bruker): gjenoppta EN pauset
    // jobb uansett user_id; processBatch leser user_id fra jobbens egen rad.
    if (path === "resume-paused" && req.method === "POST") {
      let q = supabase.from("jobs").select("id").eq("type", JOB_TYPE).or(resumableJobFilter()).order("created_at", { ascending: false }).limit(1);
      if (userId) q = q.eq("user_id", userId);
      const { data: paused } = await q;
      if (!paused?.length) return json({ status: "no_paused_jobs" });
      // @ts-ignore
      EdgeRuntime.waitUntil(processBatch(paused[0].id));
      return json({ status: "resuming", jobId: paused[0].id }, 202);
    }

    if (path === "active" && req.method === "GET") {
      let q = supabase.from("jobs").select("*").eq("type", JOB_TYPE).in("status", ["running", "paused", "pending"]).order("created_at", { ascending: false }).limit(1);
      q = userId ? q.eq("user_id", userId) : q.is("user_id", null);
      const { data } = await q;
      return json(data?.[0] ?? null);
    }

    if (path === "recent" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "5");
      let q = supabase.from("jobs").select("*").eq("type", JOB_TYPE).order("created_at", { ascending: false }).limit(limit);
      q = userId ? q.eq("user_id", userId) : q.is("user_id", null);
      const { data } = await q;
      return json(data ?? []);
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
