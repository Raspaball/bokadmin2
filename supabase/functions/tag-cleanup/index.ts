// supabase/functions/tag-cleanup/index.ts
// Deploy: supabase functions deploy tag-cleanup --no-verify-jwt --use-api --project-ref chwpqwblqummlufqdefe
//
// «Rydd tagger» (oppdrag 09.10.2026): fjerner alle tagger unntatt bkg-N/NN/NNN og de beskyttede
// (gave, lokal, lokalhistorie, lokallitteratur). Ingen tagger legges til. Regelen er tagsToRemove()
// i _shared/book-tags.ts. Jobbtype tag_cleanup, bygd på runBulkJob() (_shared/bulk-job.ts):
// spørring → (ONIX hoppes over, jobben trenger ikke Bokbasen) → plan → apply med tagsRemove i bulk.
//
// Hvorfor egen funksjon og ikke i sjangre-sync: sjangre-sync er over 1 000 linjer med to jobbmodi.
// Taggjobben har sine egne endepunkter, kan deployes og rulles tilbake uten å røre den, og trenger
// ingen pg_cron-jobb eller migrasjon: siden gjenopptar (som for sjangre-sync).
//
// Aldri med (0 endringer): beskyttede produkter, produkter uten ISBN, duplikat-ISBN.
//
//   POST /tag-cleanup/start       { mode?: "analyze" | "update", onlyIds?: string[] }   (sjekkmodus er standard)
//   GET  /tag-cleanup/status/:id | /active | /recent
//   POST /tag-cleanup/cancel/:id | /resume/:id | /resume-paused
//   POST /tag-cleanup/rollback    { jobId, mode?: "analyze" | "update", productIds?: string[] }
//        Legger de fjernede taggene tilbake med tagsAdd fra loggen. Sjekk først (standard). Kall igjen så lenge
//        `timedOut` er true. `productIds` = bare disse (til en test).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { ALL_PRODUCT_STATUSES, shopifyGraphQL } from "../_shared/shopify.ts";
import { getCaller } from "../_shared/auth.ts";
import { BOK_ISBN_FIELD, extractIsbn } from "../_shared/isbn.js";
import { protectedProduct, protectedProductMessage } from "../_shared/protected.ts";
import { ensureProtectedMembers } from "../_shared/protected-load.ts";
import { changedRow, errorRow, NO_ISBN_MESSAGE, skipRow, unchangedRow } from "../_shared/job-log.ts";
import { duplicateMessage } from "../_shared/duplicates.ts";
import { resumableJobFilter } from "../_shared/job-resume.ts";
import { currentShopDomain, jobShopError, stopIfShopChanged } from "../_shared/job-shop.ts";
import { isKeptTag, tagsToRemove } from "../_shared/book-tags.ts";
import { emptyBulkJobState, runBulkJob, summarizeBulkStats, type BulkJobSpec } from "../_shared/bulk-job.ts";

const ACTION = "tag_cleanup";
const ROLLBACK_ACTION = "tag_cleanup_rollback";
const JOB_TYPE = "tag_cleanup";
const TOP_TAGS = 50;
const TOP_TAGS_DISTINCT_CAP = 3000; // flere ulike tagger enn dette telles ikke (de vanligste kommer tidlig)
const EXAMPLES = 10;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, key);
}

// ══ Jobben ════════════════════════════════════════════════════════════════════

const QUERY = `{
  products(query: "${ALL_PRODUCT_STATUSES}") {
    edges { node {
      __typename id handle tags vendor
      ${BOK_ISBN_FIELD}
      variants(first: 1) { edges { node { __typename barcode sku } } }
    } }
  }
}`;

export const TAGS_REMOVE_MUTATION = `mutation tagCleanupRemove($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } }
}`;

export const TAGS_ADD_MUTATION = `mutation tagCleanupRestore($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}`;

interface Counts {
  cleaned: number; tagsRemoved: number; alreadyClean: number; errors: number;
  skippedNoIsbn: number; skippedProtected: number; skippedDuplicate: number; notInScope: number;
}

function loadCounts(raw: unknown): Counts {
  const r = (raw ?? {}) as Partial<Counts>;
  const n = (k: keyof Counts) => Number(r[k]) || 0;
  return {
    cleaned: n("cleaned"), tagsRemoved: n("tagsRemoved"), alreadyClean: n("alreadyClean"), errors: n("errors"),
    skippedNoIsbn: n("skippedNoIsbn"), skippedProtected: n("skippedProtected"), skippedDuplicate: n("skippedDuplicate"), notInScope: n("notInScope"),
  };
}

function summarize(c: Counts, mode: "analyze" | "update"): string {
  const skipped = c.skippedProtected + c.skippedDuplicate + c.skippedNoIsbn;
  const scope = c.notInScope ? `, ${c.notInScope} utenfor utvalget` : "";
  return `${c.cleaned} produkter ${mode === "update" ? "fikk" : "ville fått"} ${c.tagsRemoved} tagger fjernet, ${c.alreadyClean} var rene, ` +
    `hoppet over ${skipped} (${c.skippedProtected} beskyttet, ${c.skippedDuplicate} DUPLIKAT, ${c.skippedNoIsbn} uten ISBN)${scope}, ${c.errors} feil`;
}

const SPEC: BulkJobSpec<Counts> = {
  name: "tag-cleanup (bulk)",
  query: QUERY,
  slimFields: ["id", "handle", "tags", "vendor", "bokIsbn"],
  onixIsbns: () => [], // ingen ONIX

  async planChunk(products, ctx) {
    const c = ctx.counts;
    const update = ctx.mode === "update";
    const only: string[] | undefined = ctx.state.extra.onlyIds;
    const top: Record<string, number> = (ctx.state.extra.topTags ??= {});
    const examples: unknown[] = (ctx.state.extra.examples ??= []);
    const logs: Record<string, unknown>[] = [];
    const lines: unknown[] = [], refs: { id: string; isbn: string | null; handle: string }[] = [];
    for (const product of products) {
      if (only && !only.includes(product.id)) { c.notInScope++; continue; }
      const isbn = extractIsbn(product);
      const base = { isbn, title: product.handle, action: ACTION, shopify_id: product.id, job_id: ctx.jobId, user_id: ctx.userId };
      if (protectedProduct(product)) { c.skippedProtected++; logs.push(skipRow(base, "beskyttet", protectedProductMessage(product))); continue; }
      if (!isbn) { c.skippedNoIsbn++; logs.push(skipRow(base, "ingen_isbn", NO_ISBN_MESSAGE)); continue; }
      const dup = ctx.state.duplicates?.[isbn];
      if (dup) { c.skippedDuplicate++; logs.push(skipRow(base, "duplikat", duplicateMessage(dup))); continue; }
      const remove = tagsToRemove(product.tags);
      if (!remove.length) { c.alreadyClean++; logs.push(unchangedRow(base, "Uendret: ingen tagger å fjerne")); continue; }
      const kept = (product.tags ?? []).filter((t: string) => isKeptTag(t));
      c.cleaned++; c.tagsRemoved += remove.length;
      for (const t of remove) {
        if (top[t] !== undefined) top[t]++;
        else if ((ctx.state.extra.topDistinct ?? 0) < TOP_TAGS_DISTINCT_CAP) { top[t] = 1; ctx.state.extra.topDistinct = (ctx.state.extra.topDistinct ?? 0) + 1; }
      }
      if (examples.length < EXAMPLES) examples.push({ handle: product.handle, fjernes: remove.slice(0, 12), beholdes: kept });
      // fields = tagger som fjernes (leses tilbake av /rollback); meldingen har tallene og det som står igjen
      logs.push(changedRow(base, `${update ? "Fjernet" : "Ville fjernet"} ${remove.length} tagger; beholder: ${kept.join(", ") || "(ingen)"}`, remove));
      if (update) { lines.push({ id: product.id, tags: remove }); refs.push({ id: product.id, isbn, handle: product.handle }); }
    }
    return { logs, ops: [{ kind: "tags", mutation: TAGS_REMOVE_MUTATION, field: "tagsRemove", lines, refs, filename: "tag-cleanup.jsonl" }] };
  },

  onLineError(ctx, _kind, ref, error) {
    ctx.counts.errors++;
    ctx.counts.cleaned = Math.max(0, ctx.counts.cleaned - 1);
    return errorRow({ isbn: ref.isbn, title: ref.handle, action: ACTION, shopify_id: ref.id, job_id: ctx.jobId, user_id: ctx.userId }, `Feil i bulk (tagsRemove): ${error}`);
  },

  totals: (ctx) => ({
    succeeded: ctx.counts.cleaned,
    skipped: ctx.counts.skippedProtected + ctx.counts.skippedDuplicate + ctx.counts.skippedNoIsbn + ctx.counts.alreadyClean,
    failed: ctx.counts.errors,
  }),

  result(ctx) {
    const top = Object.entries((ctx.state.extra.topTags ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, TOP_TAGS);
    return {
      summary: `${summarize(ctx.counts, ctx.mode)}. ${summarizeBulkStats(ctx.state.stats)}`,
      counts: ctx.counts,
      topTags: top,
      topTagsDistinct: ctx.state.extra.topDistinct ?? 0,
      topTagsComplete: (ctx.state.extra.topDistinct ?? 0) < TOP_TAGS_DISTINCT_CAP,
      examples: ctx.state.extra.examples ?? [],
      mode: ctx.mode,
    };
  },
};

async function processBatch(jobId: string) {
  const supabase = getSupabase();
  const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  if (!job || job.type !== JOB_TYPE) return;
  if (job.status !== "running" && job.status !== "paused") return;
  if (await stopIfShopChanged(supabase, job)) return;
  return runBulkJob(supabase, jobId, SPEC, loadCounts);
}

// ══ Angre ═════════════════════════════════════════════════════════════════════

const ROLLBACK_BUDGET_MS = 40_000;
const ROLLBACK_PARALLEL = 5;

async function rollback(body: { jobId?: string; mode?: string; productIds?: string[] }, userId: string | null) {
  const supabase = getSupabase();
  const { data: job } = await supabase.from("jobs").select("*").eq("id", body.jobId ?? "").single();
  if (!job || job.type !== JOB_TYPE) return json({ error: "Fant ikke taggjobben" }, 404);
  if (job.config?.mode !== "update") return json({ error: "Jobben var en sjekk (ingenting ble fjernet), så det er ingenting å angre." }, 400);
  if (userId && job.user_id && job.user_id !== userId) return json({ error: "Ingen tilgang til denne jobben" }, 403);
  const shopErr = await jobShopError(job);
  if (shopErr) return json({ error: shopErr }, 409);
  await ensureProtectedMembers(0);
  const update = body.mode === "update";
  const only = Array.isArray(body.productIds) && body.productIds.length ? new Set(body.productIds) : null;

  // Radene fra loggen: produkter som faktisk fikk tagger fjernet (ikke feil, ikke hoppet over)
  const rows: { shopify_id: string; fields: string[] }[] = [];
  const failed = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from("sync_log").select("shopify_id, fields, outcome").eq("job_id", job.id).eq("action", ACTION)
      .in("outcome", ["endret", "feil"]).order("id").range(from, from + 999);
    for (const r of data ?? []) {
      if (r.outcome === "feil") failed.add(r.shopify_id);
      else if (r.fields?.length && (!only || only.has(r.shopify_id))) rows.push({ shopify_id: r.shopify_id, fields: r.fields });
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  const todo = rows.filter((r) => !failed.has(r.shopify_id));
  const done = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from("sync_log").select("shopify_id").eq("job_id", job.id).eq("action", ROLLBACK_ACTION).eq("outcome", "endret").order("id").range(from, from + 999);
    for (const r of data ?? []) done.add(r.shopify_id);
    if ((data?.length ?? 0) < 1000) break;
  }
  const remaining = todo.filter((r) => !done.has(r.shopify_id));
  const tagCount = remaining.reduce((s, r) => s + r.fields.length, 0);
  if (!update) {
    return json({ mode: "analyze", jobId: job.id, products: todo.length, alreadyRestored: todo.length - remaining.length, remaining: remaining.length, tagsToRestore: tagCount, skippedBecauseFailedInJob: failed.size });
  }

  const started = Date.now();
  let restored = 0, errors = 0, i = 0;
  const worker = async () => {
    while (Date.now() - started < ROLLBACK_BUDGET_MS) {
      const r = remaining[i++];
      if (!r) return;
      const base = { isbn: null, title: null, action: ROLLBACK_ACTION, shopify_id: r.shopify_id, job_id: job.id, user_id: userId };
      try {
        const res = await shopifyGraphQL(TAGS_ADD_MUTATION, { id: r.shopify_id, tags: r.fields }, { onlyMutations: ["tagsAdd"] });
        const errs = (res.data?.tagsAdd?.userErrors ?? []) as { message: string }[];
        if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
        restored++;
        await supabase.from("sync_log").insert(changedRow(base, `La tilbake ${r.fields.length} tagger`, r.fields));
      } catch (e) {
        errors++;
        await supabase.from("sync_log").insert(errorRow(base, `Feil ved angring: ${String((e as Error)?.message ?? e).slice(0, 300)}`));
      }
    }
  };
  await Promise.all(Array.from({ length: ROLLBACK_PARALLEL }, worker));
  const left = remaining.length - Math.min(i, remaining.length);
  if (left <= 0 && !only) await supabase.from("jobs").update({ result: { ...(job.result ?? {}), rolledBackAt: new Date().toISOString() } }).eq("id", job.id);
  return json({ mode: "update", jobId: job.id, restored, errors, remaining: left, timedOut: left > 0 });
}

// ══ HTTP ══════════════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(functions\/v1\/)?tag-cleanup\/?/, "");
    const supabase = getSupabase();
    const userId = (await getCaller(req)).userId;
    const mine = (q: any) => (userId ? q.eq("user_id", userId) : q.is("user_id", null)); // deno-lint-ignore no-explicit-any

    if (path === "start" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const mode = body.mode === "update" ? "update" : "analyze";
      const onlyIds = Array.isArray(body.onlyIds) && body.onlyIds.length ? body.onlyIds.map(String) : null;
      if (onlyIds && onlyIds.some((x: string) => !/^gid:\/\/shopify\/Product\/\d+$/.test(x))) return json({ error: "Ugyldig produkt-ID i onlyIds" }, 400);
      const { data: existing } = await mine(supabase.from("jobs").select("id").eq("type", JOB_TYPE).in("status", ["running", "paused", "pending"]).limit(1)).maybeSingle();
      if (existing) return json({ error: "En taggjobb kjøres allerede", jobId: existing.id }, 409);
      const bulk = emptyBulkJobState();
      if (onlyIds) bulk.extra.onlyIds = onlyIds;
      const { data: job, error } = await supabase.from("jobs").insert({
        type: JOB_TYPE, status: "running", user_id: userId, shop_domain: await currentShopDomain(),
        started_at: new Date().toISOString(), total_items: 0, processed: 0,
        config: { mode, bulk, counts: {} },
      }).select().single();
      if (error || !job) return json({ error: "Kunne ikke opprette jobb" }, 500);
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(processBatch(job.id));
      return json({ jobId: job.id, status: "running", mode, onlyIds: onlyIds?.length ?? null }, 202);
    }

    if (path === "resume-paused" && req.method === "POST") {
      let q = supabase.from("jobs").select("id").eq("type", JOB_TYPE).or(resumableJobFilter()).order("created_at", { ascending: false }).limit(1);
      if (userId) q = q.eq("user_id", userId);
      const { data } = await q;
      if (!data?.length) return json({ status: "no_paused_jobs" });
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(processBatch(data[0].id));
      return json({ status: "resuming", jobId: data[0].id }, 202);
    }

    const resumeMatch = path.match(/^resume\/(.+)$/);
    if (resumeMatch && req.method === "POST") {
      const { data: job } = await supabase.from("jobs").select("id").eq("id", resumeMatch[1]).eq("type", JOB_TYPE).single();
      if (!job) return json({ error: "Jobb ikke funnet" }, 404);
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(processBatch(job.id));
      return json({ status: "resuming", jobId: job.id }, 202);
    }

    const cancelMatch = path.match(/^cancel\/(.+)$/);
    if (cancelMatch && req.method === "POST") {
      const { data: job } = await supabase.from("jobs").select("id, user_id").eq("id", cancelMatch[1]).eq("type", JOB_TYPE).single();
      if (!job) return json({ error: "Jobb ikke funnet" }, 404);
      if (userId && job.user_id && job.user_id !== userId) return json({ error: "Ingen tilgang til denne jobben" }, 403);
      await supabase.from("jobs").update({ status: "failed", error_message: "Avbrutt av bruker", completed_at: new Date().toISOString() })
        .eq("id", job.id).in("status", ["running", "paused", "pending"]);
      return json({ status: "cancelled" });
    }

    if (path === "active" && req.method === "GET") {
      const { data } = await mine(supabase.from("jobs").select("*").eq("type", JOB_TYPE).in("status", ["running", "paused", "pending"]).order("created_at", { ascending: false }).limit(1)).maybeSingle();
      return json(data ?? null);
    }

    if (path === "recent" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "10");
      const { data } = await mine(supabase.from("jobs").select("*").eq("type", JOB_TYPE).order("created_at", { ascending: false }).limit(limit));
      return json(data ?? []);
    }

    const statusMatch = path.match(/^status\/(.+)$/);
    if (statusMatch && req.method === "GET") {
      const { data: job } = await supabase.from("jobs").select("*").eq("id", statusMatch[1]).eq("type", JOB_TYPE).single();
      if (!job) return json({ error: "Jobb ikke funnet" }, 404);
      return json(job);
    }

    if (path === "rollback" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return await rollback(body, userId);
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.startsWith("Shopify-sperre")) return json({ error: msg.slice(0, 400) }, 403);
    console.error("tag-cleanup:", e);
    return json({ error: msg.slice(0, 400) }, 500);
  }
});
