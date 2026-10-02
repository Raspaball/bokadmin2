// supabase/functions/sjangre-sync/index.ts
// Deploy: supabase functions deploy sjangre-sync --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { ALL_PRODUCT_STATUSES, shopifyGraphQL } from "../_shared/shopify.ts";
import { getCaller } from "../_shared/auth.ts";
import { BOKBASEN_ONIX_URL, clearBokbasenToken, getBokbasenCredentials, getBokbasenToken } from "../_shared/bokbasen-auth.ts";
import { BOK_ISBN_FIELD, extractIsbn } from "../_shared/isbn.js";
import { extractBokgruppekode } from "../_shared/onix.js";
import { protectedMessage, protectedTag } from "../_shared/protected.ts";
import { ensureDuplicates } from "../_shared/duplicate-scan.ts";
import { duplicateMessage } from "../_shared/duplicates.ts";
import { bkgCollectionPlan, type BkgCollectionPlan, COLLECTION_CREATE_MUTATION, COLLECTION_UPDATE_MUTATION, tagSources } from "../_shared/collections.ts";
import { COLLECTION_NAMES } from "../_shared/collection-names.ts";
import { bokgruppeCollectionCodes, missingBokgruppeTags } from "../_shared/bokgruppe.ts";
import { emptyBulkJobState, runBulkJob, summarizeBulkStats, type BulkJobContext, type BulkJobSpec, type BulkRef } from "../_shared/bulk-job.ts";

// Felt extractIsbn trenger (bok.isbn, strekkode, SKU) — handle er ikke lenger ISBN
const PRODUCT_ISBN_FIELDS = `${BOK_ISBN_FIELD} variants(first: 1) { nodes { barcode sku } }`;

const PAGE_SIZE = 50;
const TIMEOUT_MS = 100_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, key);
}

// bkg-taggene for en kode: bokgruppeTagsForKode() i _shared/bokgruppe.ts

type SupabaseClient = ReturnType<typeof getSupabase>;

// ISBN → bokgruppekode fra books (Import) og bokgruppe_cache (fylt av enrich).
// Ikke brukerbegrenset — koden er den samme for alle.
// Biter på 150, så hele katalogen kan slås opp (lange .in()-lister sprenger URL-en).
async function loadKodeMap(supabase: SupabaseClient, isbns: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < isbns.length; i += 150) {
    const part = isbns.slice(i, i + 150);
    const [{ data: cached }, { data: fromBooks }] = await Promise.all([
      supabase.from("bokgruppe_cache").select("isbn, bokgruppekode").in("isbn", part),
      supabase.from("books").select("isbn, bokgruppekode").in("isbn", part).not("bokgruppekode", "is", null),
    ]);
    for (const r of [...(cached ?? []), ...(fromBooks ?? [])] as { isbn: string; bokgruppekode: string }[]) {
      if (r.bokgruppekode) map.set(r.isbn, r.bokgruppekode);
    }
  }
  return map;
}

// ── Collections helper ────────────────────────────────────────────────────────

interface CollectionSyncResult {
  created: number; existing: number; renamed: number; errors: number; total: number;
  details: Array<{ code: string; status: string; error?: string; from?: string; to?: string }>;
  /** Sjekkmodus: hvor mange som ville blitt laget / fått nytt navn */
  toCreate?: number; toRename?: number;
}

/** Eksisterende bkg-samlinger: kode → { id, title } (én paginert liste i stedet for ett oppslag per kode). */
async function listBkgCollections(): Promise<Map<string, { id: string; title: string }>> {
  const out = new Map<string, { id: string; title: string }>();
  let after: string | null = null;
  for (;;) {
    const r = await shopifyGraphQL(`
      query($after: String) {
        collections(first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle title }
        }
      }`, { after });
    const cols = (r.data as Record<string, unknown>)?.collections as {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; handle: string; title: string }>;
    } | undefined;
    for (const c of cols?.nodes ?? []) if (c.handle.startsWith("bkg-")) out.set(c.handle.slice(4), { id: c.id, title: c.title });
    if (!cols?.pageInfo?.hasNextPage) return out;
    after = cols.pageInfo.endCursor;
  }
}

/**
 * Lager og retter samlingene i planen (bkgCollectionPlan i _shared/collections.ts)
 * fra progress.collectionIndex til `deadline`. true = ferdig.
 */
async function applyCollectionPlan(
  plan: BkgCollectionPlan, result: CollectionSyncResult, progress: { collectionIndex?: number }, deadline: number,
): Promise<boolean> {
  const items = [
    ...plan.create.map((x) => ({ ...x, type: "create" as const })),
    ...plan.rename.map((x) => ({ ...x, type: "rename" as const })),
  ];
  let i = progress.collectionIndex ?? 0;
  while (i < items.length) {
    if (Date.now() > deadline) { progress.collectionIndex = i; return false; }
    const it = items[i];
    try {
      if (it.type === "create") {
        const cr = await shopifyGraphQL(COLLECTION_CREATE_MUTATION, {
          collection: { title: it.title, handle: it.handle, sources: tagSources(`bkg-${it.code}`) },
        });
        const ue = (cr.data as Record<string, unknown>)?.collectionCreate as { userErrors: { message: string }[] } | undefined;
        if (ue?.userErrors?.length) throw new Error(ue.userErrors.map((e) => e.message).join(", "));
        result.created++;
        result.details.push({ code: it.code, status: "created" });
      } else {
        // Feil navn (f.eks. «Bokgruppe 334» fra før COLLECTION_NAMES var felles): rett tittelen
        const ur = await shopifyGraphQL(COLLECTION_UPDATE_MUTATION, { collection: { id: it.id, title: it.to } });
        const ue = (ur.data as Record<string, unknown>)?.collectionUpdate as { userErrors: { message: string }[] } | undefined;
        if (ue?.userErrors?.length) throw new Error(ue.userErrors.map((e) => e.message).join(", "));
        result.renamed++;
        result.details.push({ code: it.code, status: "renamed", from: it.from, to: it.to });
      }
    } catch (e) {
      result.errors++;
      result.details.push({ code: it.code, status: "error", error: String(e) });
    }
    i++;
    await new Promise(r => setTimeout(r, 100));
  }
  progress.collectionIndex = i;
  return true;
}

async function ensureCollections(koder: Set<string>): Promise<CollectionSyncResult> {
  const codes = bokgruppeCollectionCodes(koder);
  const plan = bkgCollectionPlan(codes, await listBkgCollections(), COLLECTION_NAMES);
  const result: CollectionSyncResult = {
    created: 0, existing: plan.existing.length, renamed: 0, errors: 0, total: codes.length,
    details: plan.existing.map((code) => ({ code, status: "existing" })),
  };
  await applyCollectionPlan(plan, result, {}, Infinity);
  return result;
}

// ══ SJANGRE SYNC JOB ═════════════════════════════════════════════════════════

interface SyncJobConfig {
  phase: "tagging" | "collections";
  cursor: string | null;
  total_products: number;
  koder_found: string[];
  tagged: number;
  already_tagged: number;
  no_kode: number;
  tag_errors: number;
  /** Beskyttet tagg (_shared/protected.ts): aldri tagget */
  skipped_protected?: number;
  /** Samme ISBN på flere produkter: aldri tagget før de er ryddet */
  skipped_duplicate?: number;
  /** ISBN → antall produkter (duplikatlisten) og skanningen som lager den */
  duplicates?: Record<string, number>;
  dup_scan?: unknown;
  processed: number;
}

async function runCollectionsPhase(
  jobId: string,
  config: SyncJobConfig,
  supabase: SupabaseClient
) {
  const koder = new Set<string>(config.koder_found.filter(Boolean));
  const colResult = await ensureCollections(koder);

  await supabase.from("jobs").update({
    status: "completed",
    completed_at: new Date().toISOString(),
    processed: config.processed,
    result: {
      products: {
        total: config.processed,
        tagged: config.tagged,
        already_tagged: config.already_tagged,
        no_product: config.no_kode,
        errors: config.tag_errors,
        skipped_protected: config.skipped_protected ?? 0,
        skipped_duplicate: config.skipped_duplicate ?? 0,
      },
      collections: colResult,
    },
    config: { ...config, phase: "collections" },
  }).eq("id", jobId);
}

async function processSyncBatch(jobId: string) {
  const supabase = getSupabase();
  const startTime = Date.now();

  const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  if (!job || (job.status !== "running" && job.status !== "paused")) return;
  // Bulk-modus (pakke E del 5): koder, tagger og samlinger over hele katalogen
  if (job.config?.bulk) return runBulkJob(supabase, jobId, SJANGRE_BULK_SPEC, loadSjangreCounts);

  await supabase.from("jobs").update({
    status: "running",
    started_at: job.started_at || new Date().toISOString(),
  }).eq("id", jobId);

  const userId: string | null = job.user_id || null;
  const config: SyncJobConfig = job.config || {
    phase: "tagging", cursor: null, total_products: 0,
    koder_found: [], tagged: 0, already_tagged: 0, no_kode: 0, tag_errors: 0, processed: 0,
  };


  try {
    // ISBN med flere produkter (pakke D del 3b): skannes én gang per jobb, så hoppes de over
    // Jobben lagrer sitt eget config-objekt: listen legges inn der
    const holder = { id: jobId, config };
    const duplicates = config.phase === "tagging" ? await ensureDuplicates(supabase, holder, startTime + 30_000) : {};
    if (!duplicates) return; // skanningen fortsetter i neste puls
    config.duplicates = duplicates;
    delete config.dup_scan;
    if (config.phase === "tagging") {
      if (!config.total_products) {
        const countResult = await shopifyGraphQL(`{ productsCount(query: "${ALL_PRODUCT_STATUSES}") { count } }`, {});
        config.total_products = ((countResult.data as Record<string, unknown>)?.productsCount as { count: number })?.count ?? 0;
        await supabase.from("jobs").update({ total_items: config.total_products, config }).eq("id", jobId);
      }

      const vars: Record<string, unknown> = { first: PAGE_SIZE };
      if (config.cursor) vars.after = config.cursor;

      const r = await shopifyGraphQL(`
        query($first: Int!, $after: String) {
          products(first: $first, after: $after, query: "${ALL_PRODUCT_STATUSES}") {
            pageInfo { hasNextPage endCursor }
            edges { node { id handle tags ${PRODUCT_ISBN_FIELDS} } }
          }
        }`, vars);

      const productsData = (r.data as Record<string, unknown>)?.products as {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        edges: Array<{ node: { id: string; handle: string; tags: string[] } }>;
      } | null;

      // ISBN hentes fra bok.isbn / strekkode / SKU — handle er ikke lenger ISBN
      const products = (productsData?.edges?.map(e => e.node) ?? [])
        .map(p => ({ ...p, isbn: extractIsbn(p) }));
      const pageInfo = productsData?.pageInfo;

      if (products.length === 0) {
        config.phase = "collections";
        await supabase.from("jobs").update({ config, processed: config.processed }).eq("id", jobId);
        await runCollectionsPhase(jobId, config, supabase);
        return;
      }

      // Batch-lookup ISBNs in books + bokgruppe_cache
      const isbns = products.map(p => p.isbn).filter((i): i is string => !!i);
      const kodeMap = await loadKodeMap(supabase, isbns);

      for (const product of products) {
        if (Date.now() - startTime > TIMEOUT_MS) {
          await supabase.from("jobs").update({ status: "paused", processed: config.processed, config }).eq("id", jobId);
          return;
        }

        const kode = product.isbn ? kodeMap.get(product.isbn) : undefined;

        // Beskyttet (tagg gave/lokal/lokalhistorie/lokallitteratur): får aldri nye tagger
        if (protectedTag(product.tags)) {
          config.skipped_protected = (config.skipped_protected ?? 0) + 1;
          await supabase.from("sync_log").insert({
            isbn: product.isbn, title: product.handle, action: "sjangre_sync", status: "info",
            message: protectedMessage(product.tags), shopify_id: product.id, job_id: jobId, user_id: userId,
          });
          config.processed++;
          continue;
        }

        if (product.isbn && duplicates[product.isbn]) {
          config.skipped_duplicate = (config.skipped_duplicate ?? 0) + 1;
          await supabase.from("sync_log").insert({
            isbn: product.isbn, title: product.handle, action: "sjangre_sync", status: "info",
            message: duplicateMessage(duplicates[product.isbn]), shopify_id: product.id, job_id: jobId, user_id: userId,
          });
          config.processed++;
          continue;
        }

        if (!kode) {
          config.no_kode++;
        } else {
          if (!config.koder_found.includes(kode)) config.koder_found.push(kode);
          try {
            const missingTags = missingBokgruppeTags(product.tags, kode);
            if (missingTags.length === 0) {
              config.already_tagged++;
            } else {
              const ur = await shopifyGraphQL(
                `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { message } } }`,
                { product: { id: product.id, tags: [...product.tags, ...missingTags] } });
              const errs = (ur.data as Record<string, unknown>)?.productUpdate as { userErrors: { message: string }[] } | null;
              if (errs?.userErrors?.length) config.tag_errors++;
              else config.tagged++;
            }
          } catch (_e) {
            config.tag_errors++;
          }
          await new Promise(r => setTimeout(r, 100));
        }
        config.processed++;
      }

      config.cursor = pageInfo?.endCursor ?? null;

      if (!pageInfo?.hasNextPage) {
        config.phase = "collections";
        await supabase.from("jobs").update({ config, processed: config.processed }).eq("id", jobId);
        await runCollectionsPhase(jobId, config, supabase);
      } else {
        await supabase.from("jobs").update({ status: "paused", processed: config.processed, config }).eq("id", jobId);
      }
    } else {
      await runCollectionsPhase(jobId, config, supabase);
    }
  } catch (err) {
    await supabase.from("jobs").update({ status: "paused", error_message: String(err), config }).eq("id", jobId);
  }
}

// ══ BULK-MODUS (pakke E del 5) ════════════════════════════════════════════════
// Bokgruppekoder, bkg-tagger og samlinger i én jobb over hele katalogen, med
// samme regler som før: koden fra bokgruppe_cache/books, ellers fra ONIX
// (onix_cache, hentet i forkant), manglende bkg-tagger legges til med tagsAdd
// (andre tagger røres ikke), og samlingene lages/får riktig navn til slutt.
// Sjekkmodus (standard) skriver ingenting til Shopify; koder fra Bokbasen
// lagres i bokgruppe_cache i begge moduser (det er en kopi av Bokbasen-data).
// Driveren er runBulkJob() i _shared/bulk-job.ts. Beskyttede og duplikater
// hoppes over.

const SJANGRE_BULK_QUERY = `{
  products(query: "${ALL_PRODUCT_STATUSES}") {
    edges { node {
      __typename id handle tags
      bokIsbn: metafield(namespace: "bok", key: "isbn") { value }
      variants(first: 1) { edges { node { __typename barcode sku } } }
    } }
  }
}`;

const SJANGRE_BULK_TAGS_MUTATION = `mutation sjangreBulkTags($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}`;

interface SjangreCounts {
  tagged: number; alreadyTagged: number; noKode: number; tagErrors: number;
  skippedNoIsbn: number; skippedProtected: number; skippedDuplicate: number;
  kodeFromCache: number; kodeFromOnix: number;
}

function loadSjangreCounts(raw: unknown): SjangreCounts {
  const r = (raw ?? {}) as Partial<SjangreCounts>;
  const n = (k: keyof SjangreCounts) => Number(r[k]) || 0;
  return {
    tagged: n("tagged"), alreadyTagged: n("alreadyTagged"), noKode: n("noKode"), tagErrors: n("tagErrors"),
    skippedNoIsbn: n("skippedNoIsbn"), skippedProtected: n("skippedProtected"), skippedDuplicate: n("skippedDuplicate"),
    kodeFromCache: n("kodeFromCache"), kodeFromOnix: n("kodeFromOnix"),
  };
}

/** Koder fra ONIX (cachen) for ISBN-ene, lagret i bokgruppe_cache og på bøker som mangler koden. */
async function kodeFromOnix(supabase: SupabaseClient, xmlByIsbn: Map<string, string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const [isbn, xml] of xmlByIsbn) {
    const kode = extractBokgruppekode(xml);
    if (kode) found.set(isbn, kode);
  }
  if (found.size) {
    const now = new Date().toISOString();
    const rows = [...found].map(([isbn, bokgruppekode]) => ({ isbn, bokgruppekode, updated_at: now }));
    const { error } = await supabase.from("bokgruppe_cache").upsert(rows, { onConflict: "isbn" });
    if (error) throw new Error(`bokgruppe_cache: ${error.message}`);
    // Ingen nye rader i books (arbeidslista på Import-siden), bare kode på bøker som mangler den
    for (const [isbn, bokgruppekode] of found) {
      await supabase.from("books").update({ bokgruppekode }).eq("isbn", isbn).is("bokgruppekode", null);
    }
  }
  return found;
}

/** «12 ville fått bkg-tagger, 400 hadde dem, 5 uten kode, hoppet over …; samlinger: 3 lages, 1 nytt navn» */
function summarizeSjangre(c: SjangreCounts, mode: "analyze" | "update", col: CollectionSyncResult | undefined): string {
  const tags = `${c.tagged} ${mode === "update" ? "fikk" : "ville fått"} bkg-tagger, ${c.alreadyTagged} hadde dem, ${c.noKode} uten bokgruppekode, ` +
    `hoppet over ${c.skippedProtected + c.skippedDuplicate + c.skippedNoIsbn} (${c.skippedProtected} beskyttet, ${c.skippedDuplicate} DUPLIKAT, ` +
    `${c.skippedNoIsbn} uten ISBN), ${c.tagErrors} feil. Koder: ${c.kodeFromCache} fra cache, ${c.kodeFromOnix} fra Bokbasen`;
  if (!col) return tags;
  const colText = mode === "update"
    ? `${col.created} laget, ${col.renamed} nytt navn, ${col.existing} fantes, ${col.errors} feil`
    : `${col.toCreate ?? 0} ville blitt laget, ${col.toRename ?? 0} ville fått nytt navn, ${col.existing} fantes`;
  return `${tags}. Samlinger: ${colText}`;
}

const SJANGRE_BULK_SPEC: BulkJobSpec<SjangreCounts> = {
  name: "sjangre-sync (bulk)",
  query: SJANGRE_BULK_QUERY,
  slimFields: ["id", "handle", "tags", "bokIsbn"],

  // ONIX bare for ISBN uten kode i bokgruppe_cache/books
  async onixIsbns(products, ctx) {
    const isbns = products.filter((p) => !protectedTag(p.tags)).map((p) => extractIsbn(p)).filter((i): i is string => !!i);
    const known = await loadKodeMap(ctx.supabase, isbns);
    return isbns.filter((i) => !known.has(i));
  },

  async planChunk(products, ctx) {
    const c = ctx.counts;
    const koder: string[] = (ctx.state.extra.koder ??= []);
    const isbns = products.filter((p) => !protectedTag(p.tags)).map((p) => extractIsbn(p))
      .filter((i): i is string => !!i && !ctx.state.duplicates?.[i]);
    const kodeMap = await loadKodeMap(ctx.supabase, isbns);
    const missing = isbns.filter((i) => !kodeMap.has(i));
    const fromOnix = missing.length ? await kodeFromOnix(ctx.supabase, await ctx.loadXml(missing)) : new Map<string, string>();
    c.kodeFromCache += kodeMap.size;
    c.kodeFromOnix += fromOnix.size;

    const logs: Record<string, unknown>[] = [];
    const lines: unknown[] = [];
    const refs: BulkRef[] = [];
    for (const product of products) {
      const isbn = extractIsbn(product);
      const base = { isbn, title: product.handle, action: "sjangre_sync", shopify_id: product.id, job_id: ctx.jobId, user_id: ctx.userId };
      // Beskyttet (tagg gave/lokal/lokalhistorie/lokallitteratur): får aldri nye tagger
      if (protectedTag(product.tags)) {
        c.skippedProtected++;
        logs.push({ ...base, status: "info", message: protectedMessage(product.tags) });
        continue;
      }
      if (!isbn) { c.skippedNoIsbn++; continue; }
      const dup = ctx.state.duplicates?.[isbn];
      if (dup) {
        c.skippedDuplicate++;
        logs.push({ ...base, status: "info", message: duplicateMessage(dup) });
        continue;
      }
      const kode = kodeMap.get(isbn) ?? fromOnix.get(isbn);
      if (!kode) { c.noKode++; continue; }
      if (!koder.includes(kode)) koder.push(kode);
      const add = missingBokgruppeTags(product.tags, kode);
      if (!add.length) { c.alreadyTagged++; continue; }
      c.tagged++;
      logs.push({ ...base, status: "success", message: `${ctx.mode === "update" ? "La til" : "Ville lagt til"} ${add.join(", ")} (bokgruppe ${kode})` });
      if (ctx.mode === "update") {
        lines.push({ id: product.id, tags: add });
        refs.push({ id: product.id, isbn, handle: product.handle });
      }
    }
    return { logs, ops: [{ kind: "tags", mutation: SJANGRE_BULK_TAGS_MUTATION, field: "tagsAdd", lines, refs, filename: "sjangre-tags.jsonl" }] };
  },

  onLineError(ctx, _kind, ref, error) {
    ctx.counts.tagErrors++;
    ctx.counts.tagged = Math.max(0, ctx.counts.tagged - 1);
    return { isbn: ref.isbn, title: ref.handle, action: "sjangre_sync", status: "error", message: `Feil i bulk (tagger): ${error}`, shopify_id: ref.id, job_id: ctx.jobId, user_id: ctx.userId };
  },

  // Samlinger: planen lages én gang; i oppdateringsmodus lages/rettes de til tiden er ute
  async finish(ctx) {
    const extra = ctx.state.extra;
    if (!extra.collectionPlan) {
      const codes = bokgruppeCollectionCodes(extra.koder ?? []);
      extra.collectionPlan = bkgCollectionPlan(codes, await listBkgCollections(), COLLECTION_NAMES);
      extra.collectionResult = {
        created: 0, existing: extra.collectionPlan.existing.length, renamed: 0, errors: 0, total: codes.length, details: [],
        toCreate: extra.collectionPlan.create.length, toRename: extra.collectionPlan.rename.length,
      } as CollectionSyncResult;
      extra.collectionIndex = 0;
      if (ctx.mode !== "update") {
        const r = extra.collectionResult as CollectionSyncResult;
        r.details = [
          ...extra.collectionPlan.create.map((x: { code: string; title: string }) => ({ code: x.code, status: "would_create", to: x.title })),
          ...extra.collectionPlan.rename.map((x: { code: string; from: string; to: string }) => ({ code: x.code, status: "would_rename", from: x.from, to: x.to })),
        ];
        return true;
      }
    }
    if (ctx.mode !== "update") return true;
    const done = await applyCollectionPlan(extra.collectionPlan, extra.collectionResult, extra, ctx.deadline);
    return done;
  },

  totals(ctx: BulkJobContext<SjangreCounts>) {
    const c = ctx.counts;
    return { succeeded: c.tagged, skipped: c.alreadyTagged + c.noKode + c.skippedNoIsbn, failed: c.tagErrors };
  },

  result(ctx) {
    const c = ctx.counts;
    const col = ctx.state.extra.collectionResult as CollectionSyncResult | undefined;
    return {
      counts: c,
      products: {
        total: (ctx.state.totalProducts ?? 0), tagged: c.tagged, already_tagged: c.alreadyTagged, no_product: c.noKode,
        errors: c.tagErrors, skipped_protected: c.skippedProtected, skipped_duplicate: c.skippedDuplicate,
      },
      collections: col,
      skippedProtected: c.skippedProtected, skippedDuplicate: c.skippedDuplicate,
      summary: `${summarizeSjangre(c, ctx.mode, col)}. ${summarizeBulkStats(ctx.state.stats)}`,
    };
  },
};

// ══ SHOPIFY ENRICH JOB (Shopify → Bokbasen → local cache) ════════════════════

interface EnrichJobConfig {
  cursor: string | null;
  total_products: number;
  processed: number;
  found_kode: number;      // ISBNs that got bokgruppekode from Bokbasen
  already_cached: number;  // ISBNs already in cache
  no_data: number;         // ISBNs Bokbasen returned no kode for
  errors: number;
}

async function processEnrichBatch(jobId: string) {
  const supabase = getSupabase();
  const startTime = Date.now();

  const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  if (!job || (job.status !== "running" && job.status !== "paused")) return;

  await supabase.from("jobs").update({
    status: "running",
    started_at: job.started_at || new Date().toISOString(),
  }).eq("id", jobId);

  const userId: string | null = job.user_id || null;
  const config: EnrichJobConfig = job.config || {
    cursor: null, total_products: 0, processed: 0,
    found_kode: 0, already_cached: 0, no_data: 0, errors: 0,
  };

  const bokbasenConfig = await getBokbasenCredentials(userId);

  if (!bokbasenConfig) {
    await supabase.from("jobs").update({
      status: "failed",
      error_message: "Bokbasen-credentials mangler. Konfigurer dem i Innstillinger.",
    }).eq("id", jobId);
    return;
  }

  try {
    if (!config.total_products) {
      const countResult = await shopifyGraphQL(`{ productsCount(query: "${ALL_PRODUCT_STATUSES}") { count } }`, {});
      config.total_products = ((countResult.data as Record<string, unknown>)?.productsCount as { count: number })?.count ?? 0;
      await supabase.from("jobs").update({ total_items: config.total_products, config }).eq("id", jobId);
    }

    const vars: Record<string, unknown> = { first: PAGE_SIZE };
    if (config.cursor) vars.after = config.cursor;

    const r = await shopifyGraphQL(`
      query($first: Int!, $after: String) {
        products(first: $first, after: $after, query: "${ALL_PRODUCT_STATUSES}") {
          pageInfo { hasNextPage endCursor }
          edges { node { handle ${PRODUCT_ISBN_FIELDS} } }
        }
      }`, vars);

    const productsData = (r.data as Record<string, unknown>)?.products as {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      edges: Array<{ node: { handle: string } }>;
    } | null;

    const products = (productsData?.edges?.map(e => e.node) ?? [])
      .map(p => ({ ...p, isbn: extractIsbn(p) }));
    const pageInfo = productsData?.pageInfo;

    if (products.length === 0) {
      await supabase.from("jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        processed: config.processed,
        result: { found_kode: config.found_kode, already_cached: config.already_cached, no_data: config.no_data, errors: config.errors, total: config.processed },
        config,
      }).eq("id", jobId);
      return;
    }

    // Check which ISBNs are already cached with bokgruppekode (books + bokgruppe_cache)
    const isbns = products.map(p => p.isbn).filter((i): i is string => !!i);
    const cachedMap = await loadKodeMap(supabase, isbns);

    let bokbasenToken: string | null = null;

    for (const product of products) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        await supabase.from("jobs").update({ status: "paused", processed: config.processed, config }).eq("id", jobId);
        return;
      }

      const isbn = product.isbn;
      if (!isbn) { config.processed++; continue; }

      // Already cached with bokgruppekode
      if (cachedMap.has(isbn) && cachedMap.get(isbn)) {
        config.already_cached++;
        config.processed++;
        continue;
      }

      // Look up in Bokbasen
      try {
        if (!bokbasenToken) bokbasenToken = await getBokbasenToken(bokbasenConfig);

        const onixRes = await fetch(`${BOKBASEN_ONIX_URL}/${isbn}`, {
          headers: { Authorization: `Bearer ${bokbasenToken}` },
        });

        if (!onixRes.ok) {
          if (onixRes.status === 401) { bokbasenToken = null; clearBokbasenToken(bokbasenConfig); } // Token expired, refresh next iteration
          config.no_data++;
        } else {
          const xml = await onixRes.text();
          const bokgruppekode = extractBokgruppekode(xml);

          if (bokgruppekode) {
            // Lagre i bokgruppe_cache. Ingen nye rader i books: books er også
            // arbeidslista på Import-siden (se migrasjonen 20260930120000_bokgruppe_cache).
            const { error: cacheErr } = await supabase.from("bokgruppe_cache")
              .upsert({ isbn, bokgruppekode, updated_at: new Date().toISOString() }, { onConflict: "isbn" });
            if (cacheErr) throw new Error(`bokgruppe_cache: ${cacheErr.message}`);
            // Fyll inn koden på en eksisterende bok som mangler den
            await supabase.from("books").update({ bokgruppekode }).eq("isbn", isbn).is("bokgruppekode", null);
            config.found_kode++;
          } else {
            config.no_data++;
          }
        }
      } catch (_e) {
        config.errors++;
        bokbasenToken = null;
        clearBokbasenToken(bokbasenConfig);
      }

      config.processed++;
      await new Promise(r => setTimeout(r, 150));
    }

    config.cursor = pageInfo?.endCursor ?? null;

    if (!pageInfo?.hasNextPage) {
      await supabase.from("jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        processed: config.processed,
        result: { found_kode: config.found_kode, already_cached: config.already_cached, no_data: config.no_data, errors: config.errors, total: config.processed },
        config,
      }).eq("id", jobId);
    } else {
      await supabase.from("jobs").update({ status: "paused", processed: config.processed, config }).eq("id", jobId);
    }
  } catch (err) {
    await supabase.from("jobs").update({ status: "paused", error_message: String(err), config }).eq("id", jobId);
  }
}

// ══ HTTP ROUTER ═══════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/sjangre-sync\/?/, "");
    const supabase = getSupabase();
    // Verifisert bruker (auth.getUser i _shared/auth.ts), aldri lest rett fra tokenet
    const userId = (await getCaller(req)).userId;

    // ── Sjangre sync ──────────────────────────────────────────────────────────

    // GET /sjangre-sync/analyze
    if (path === "analyze" && req.method === "GET") {

      const countResult = await shopifyGraphQL(`{ productsCount(query: "${ALL_PRODUCT_STATUSES}") { count } }`, {});
      const totalShopifyProducts = ((countResult.data as Record<string, unknown>)?.productsCount as { count: number })?.count ?? 0;

      const { count: withKode } = await supabase
        .from("books").select("id", { count: "exact", head: true }).not("bokgruppekode", "is", null);
      const { count: withoutKode } = await supabase
        .from("books").select("id", { count: "exact", head: true }).is("bokgruppekode", null);

      const { data: kodRows } = await supabase
        .from("books").select("bokgruppekode").not("bokgruppekode", "is", null);
      const distinctKoder = new Set<string>(
        (kodRows ?? []).map((r: { bokgruppekode: string }) => r.bokgruppekode).filter(Boolean)
      );

      const allCodes = new Set<string>();
      for (const k of distinctKoder) {
        if (k.length >= 1) allCodes.add(k[0]);
        if (k.length >= 2) allCodes.add(k.slice(0, 2));
        if (k.length >= 3) allCodes.add(k.slice(0, 3));
      }

      const existingHandles = new Set<string>();
      let after: string | null = null;
      while (true) {
        const vars: Record<string, unknown> = { first: 250 };
        if (after) vars.after = after;
        const r = await shopifyGraphQL(`
          query($first: Int!, $after: String) {
            collections(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { cursor node { handle } }
            }
          }`, vars);
        const edges = ((r.data as Record<string, unknown>)?.collections as { edges: Array<{ cursor: string; node: { handle: string } }> })?.edges ?? [];
        for (const e of edges) {
          if (e.node.handle.startsWith("bkg-")) existingHandles.add(e.node.handle.slice(4));
          after = e.cursor;
        }
        if (!((r.data as Record<string, unknown>)?.collections as { pageInfo: { hasNextPage: boolean } })?.pageInfo?.hasNextPage) break;
      }

      const totalCodes = allCodes.size;
      const existingCount = [...allCodes].filter(c => existingHandles.has(c)).length;

      return new Response(JSON.stringify({
        totalBooks: (withKode || 0) + (withoutKode || 0),
        booksWithKode: withKode || 0,
        booksWithoutKode: withoutKode || 0,
        totalShopifyProducts,
        collections: { existing: existingCount, toCreate: totalCodes - existingCount, total: totalCodes },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // POST /sjangre-sync/start  { mode?: "analyze" | "update", bulk?: boolean }
    // Bulk (standard): koder + tagger + samlinger i én jobb, sjekkmodus som standard.
    // bulk: false = den gamle side-for-side-taggingen (alltid oppdatering, uten koder fra Bokbasen).
    if (path === "start" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const bulk = body.bulk !== false;
      const mode = body.mode === "update" ? "update" : "analyze";
      let exQ = supabase.from("jobs").select("id, status")
        .eq("type", "sjangre_sync").in("status", ["running", "paused", "pending"]).limit(1);
      if (userId) exQ = exQ.eq("user_id", userId); else exQ = exQ.is("user_id", null);
      const { data: existing } = await exQ.single();
      if (existing) return new Response(JSON.stringify({ error: "En synk kjøres allerede", jobId: existing.id }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const countResult = await shopifyGraphQL(`{ productsCount(query: "${ALL_PRODUCT_STATUSES}") { count } }`, {});
      const totalProducts = ((countResult.data as Record<string, unknown>)?.productsCount as { count: number })?.count ?? 0;

      const { data: job, error } = await supabase.from("jobs").insert({
        type: "sjangre_sync", status: "running", user_id: userId,
        started_at: new Date().toISOString(), total_items: totalProducts, processed: 0,
        config: bulk
          ? { mode, bulk: emptyBulkJobState(), counts: {} }
          : { phase: "tagging", cursor: null, total_products: totalProducts, koder_found: [], tagged: 0, already_tagged: 0, no_kode: 0, tag_errors: 0, processed: 0 },
      }).select().single();

      if (error || !job) return new Response(JSON.stringify({ error: "Kunne ikke opprette jobb" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const response = new Response(JSON.stringify({ jobId: job.id, status: "running", mode: bulk ? mode : "update", bulk }), { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      // @ts-ignore
      EdgeRuntime.waitUntil(processSyncBatch(job.id));
      return response;
    }

    // POST /sjangre-sync/resume/:jobId
    const resumeMatch = path.match(/^resume\/(.+)$/);
    if (resumeMatch && req.method === "POST") {
      const jobId = resumeMatch[1];
      const { data: job } = await supabase.from("jobs").select("id").eq("id", jobId).single();
      if (!job) return new Response(JSON.stringify({ error: "Jobb ikke funnet" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const response = new Response(JSON.stringify({ status: "resuming", jobId }), { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      // @ts-ignore
      EdgeRuntime.waitUntil(processSyncBatch(jobId));
      return response;
    }

    // GET /sjangre-sync/active
    if (path === "active" && req.method === "GET") {
      let q = supabase.from("jobs").select("*").eq("type", "sjangre_sync")
        .in("status", ["running", "paused", "pending"]).order("created_at", { ascending: false }).limit(1);
      if (userId) q = q.eq("user_id", userId); else q = q.is("user_id", null);
      const { data: job } = await q.single();
      return new Response(JSON.stringify(job || null), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Shopify enrich ────────────────────────────────────────────────────────

    // POST /sjangre-sync/enrich-start
    if (path === "enrich-start" && req.method === "POST") {
      let exQ = supabase.from("jobs").select("id, status")
        .eq("type", "shopify_enrich").in("status", ["running", "paused", "pending"]).limit(1);
      if (userId) exQ = exQ.eq("user_id", userId); else exQ = exQ.is("user_id", null);
      const { data: existing } = await exQ.single();
      if (existing) return new Response(JSON.stringify({ error: "En henting kjøres allerede", jobId: existing.id }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const { data: job, error } = await supabase.from("jobs").insert({
        type: "shopify_enrich", status: "running", user_id: userId,
        started_at: new Date().toISOString(), total_items: 0, processed: 0,
        config: { cursor: null, total_products: 0, processed: 0, found_kode: 0, already_cached: 0, no_data: 0, errors: 0 },
      }).select().single();

      if (error || !job) return new Response(JSON.stringify({ error: "Kunne ikke opprette jobb" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const response = new Response(JSON.stringify({ jobId: job.id, status: "running" }), { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      // @ts-ignore
      EdgeRuntime.waitUntil(processEnrichBatch(job.id));
      return response;
    }

    // POST /sjangre-sync/enrich-resume/:jobId
    const enrichResumeMatch = path.match(/^enrich-resume\/(.+)$/);
    if (enrichResumeMatch && req.method === "POST") {
      const jobId = enrichResumeMatch[1];
      const response = new Response(JSON.stringify({ status: "resuming", jobId }), { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      // @ts-ignore
      EdgeRuntime.waitUntil(processEnrichBatch(jobId));
      return response;
    }

    // GET /sjangre-sync/enrich-active
    if (path === "enrich-active" && req.method === "GET") {
      let q = supabase.from("jobs").select("*").eq("type", "shopify_enrich")
        .in("status", ["running", "paused", "pending"]).order("created_at", { ascending: false }).limit(1);
      if (userId) q = q.eq("user_id", userId); else q = q.is("user_id", null);
      const { data: job } = await q.single();
      return new Response(JSON.stringify(job || null), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Shared status endpoint ────────────────────────────────────────────────

    // GET /sjangre-sync/status/:jobId
    const statusMatch = path.match(/^status\/(.+)$/);
    if (statusMatch && req.method === "GET") {
      const jobId = statusMatch[1];
      const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
      if (!job) return new Response(JSON.stringify({ error: "Jobb ikke funnet" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify(job), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // GET /sjangre-sync/catalog-bkg-stats
    // Henter alle Shopify-produkter (kun tags), parser bkg-NNN og returnerer telling per kode.
    if (path === "catalog-bkg-stats" && req.method === "GET") {
      const byKode: Record<string, number> = {};
      let withKode = 0, withoutKode = 0;
      let after: string | null = null;

      while (true) {
        const vars: Record<string, unknown> = { first: 250 };
        if (after) vars.after = after;
        const result = await shopifyGraphQL(`
          query($first: Int!, $after: String) {
            products(first: $first, after: $after, query: "${ALL_PRODUCT_STATUSES}") {
              pageInfo { hasNextPage endCursor }
              edges { cursor node { tags } }
            }
          }
        `, vars);
        const products = (result.data as Record<string, unknown>)?.products as {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: Array<{ cursor: string; node: { tags: string[] } }>;
        } | undefined;
        for (const { node } of products?.edges ?? []) {
          const tag3 = node.tags.find((t: string) => /^bkg-\d{3}$/.test(t));
          if (tag3) {
            const kode = tag3.slice(4);
            byKode[kode] = (byKode[kode] ?? 0) + 1;
            withKode++;
          } else {
            withoutKode++;
          }
        }
        after = products?.pageInfo?.hasNextPage ? products.pageInfo.endCursor : null;
        if (!after) break;
      }

      return new Response(
        JSON.stringify({ byKode, total: withKode + withoutKode, withKode, withoutKode }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // POST /sjangre-sync/delete-empty-collections
    if (path === "delete-empty-collections" && req.method === "POST") {
      const toDelete: { id: string; handle: string }[] = [];
      let after: string | null = null;
      let checked = 0;

      while (true) {
        const vars: Record<string, unknown> = { first: 250 };
        if (after) vars.after = after;
        const result = await shopifyGraphQL(`
          query($first: Int!, $after: String) {
            collections(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  handle
                  productsCount { count }
                }
              }
            }
          }
        `, vars);
        const cols = (result.data as Record<string, unknown>)?.collections as {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: Array<{ node: { id: string; handle: string; productsCount: { count: number } } }>;
        } | undefined;
        for (const { node } of cols?.edges ?? []) {
          if (node.handle.startsWith("bkg-")) {
            checked++;
            if ((node.productsCount?.count ?? 0) === 0) {
              toDelete.push({ id: node.id, handle: node.handle });
            }
          }
        }
        after = cols?.pageInfo?.hasNextPage ? cols.pageInfo.endCursor : null;
        if (!after) break;
      }

      let deleted = 0;
      let errors = 0;
      for (const col of toDelete) {
        try {
          const r = await shopifyGraphQL(`
            mutation($id: ID!) {
              collectionDelete(input: { id: $id }) {
                deletedCollectionId
                userErrors { field message }
              }
            }
          `, { id: col.id });
          const res = (r.data as Record<string, unknown>)?.collectionDelete as { userErrors: Array<{ message: string }> } | undefined;
          if (res?.userErrors?.length) { errors++; } else { deleted++; }
        } catch { errors++; }
      }

      return new Response(
        JSON.stringify({ checked, deleted, errors }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
