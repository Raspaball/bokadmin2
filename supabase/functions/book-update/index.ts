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
// Endepunkter: POST /start { mode?: "analyze" | "update", isbns?: string[] },
// GET /status/:jobId, POST /cancel/:jobId, POST /resume/:jobId,
// POST /resume-paused, GET /active, GET /recent?limit=
//
// Deploy: supabase functions deploy book-update --no-verify-jwt --use-api --project-ref chwpqwblqummlufqdefe

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { ALL_PRODUCT_STATUSES, shopifyGraphQL, waitForShopifyBudget } from "../_shared/shopify.ts";
import { BOK_ISBN_FIELD, extractIsbn } from "../_shared/isbn.js";
import { getOnixCached } from "../_shared/onix-cache.ts";
import { protectedMessage, protectedTag } from "../_shared/protected.ts";
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

function getUserIdFromJWT(authHeader: string): string | null {
  try {
    return JSON.parse(atob(authHeader.replace("Bearer ", "").split(".")[1])).sub ?? null;
  } catch {
    return null;
  }
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
  if (plan.cover) {
    const r = await shopifyGraphQL(FILE_UPDATE, { files: [{ id: plan.cover.mediaId, ...plan.cover.change }] });
    const e = errs(r.data?.fileUpdate?.userErrors);
    if (e) throw new Error(`fileUpdate: ${e}`);
    await waitForShopifyBudget(r.extensions, 100);
  }
}

// ── Jobben ──────────────────────────────────────────────────────────────────

async function processBatch(jobId: string) {
  const supabase = getSupabase();
  const startTime = Date.now();

  const { data: job } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  if (!job || (job.status !== "running" && job.status !== "paused")) return;

  await supabase.from("jobs").update({ status: "running", started_at: job.started_at || new Date().toISOString() }).eq("id", jobId);

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
    skipped: counts.unchanged + counts.skippedNoIsbn + counts.skippedNoOnix + counts.skippedProtected,
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
      // Beskyttet (tagg gave/lokal/lokalhistorie/lokallitteratur): aldri rørt, ikke engang ONIX-oppslag
      if (protectedTag(product.tags)) {
        counts.skippedProtected++;
        await supabase.from("sync_log").insert({
          isbn, title: product.handle, action: "book_update", status: "info",
          message: protectedMessage(product.tags), shopify_id: product.id, job_id: jobId, user_id: userId,
        });
        continue;
      }
      if (!isbn) { counts.skippedNoIsbn++; continue; }

      await supabase.from("jobs").update({ current_isbn: isbn, processed }).eq("id", jobId);

      try {
        const onix = await getOnixCached(isbn, userId);
        if (!onix.xml) {
          counts.skippedNoOnix++;
          await supabase.from("sync_log").insert({
            isbn, title: product.handle, action: "book_update", status: "info",
            message: "Hoppet over: fant ikke boka i Bokbasen", shopify_id: product.id, job_id: jobId, user_id: userId,
          });
          continue;
        }

        const plan = planBookUpdate(product, onix.xml);
        const what = plan.changes.map((c) => `${c.field}: ${c.from || "(tom)"} → ${c.to}`).join("; ");
        const notes = plan.notes.length ? ` (${plan.notes.join("; ")})` : "";

        if (!plan.changes.length) {
          countPlan(counts, product.handle, plan);
          if (plan.notes.length) {
            await supabase.from("sync_log").insert({
              isbn, title: product.handle, action: "book_update", status: "info",
              message: `Uendret${notes}`, shopify_id: product.id, job_id: jobId, user_id: userId,
            });
          }
          continue;
        }

        if (mode === "update") await applyPlan(product.id, plan);
        countPlan(counts, product.handle, plan);
        await supabase.from("sync_log").insert({
          isbn, title: product.handle, action: "book_update", status: "success",
          message: `${mode === "update" ? "Endret" : "Ville endret"}: ${what}${notes}`,
          shopify_id: product.id, job_id: jobId, user_id: userId,
        });
      } catch (err) {
        counts.errors++;
        await supabase.from("sync_log").insert({
          isbn, title: product.handle, action: "book_update", status: "error",
          message: `Feil: ${err instanceof Error ? err.message : String(err)}`, shopify_id: product.id, job_id: jobId, user_id: userId,
        });
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
    const fatal = msg.includes("HTTP 401") || msg.includes("HTTP 403");
    // Markøren rulles tilbake til pulsstart, og tallene med den
    await supabase.from("jobs").update({
      status: fatal ? "failed" : "paused",
      error_message: msg,
      processed: job.processed || 0,
      config: { ...job.config, shopify_cursor: cursor, page_start_index: pageStartIndex, counts: countsAtStart },
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
    const jwtUserId = getUserIdFromJWT(req.headers.get("Authorization") ?? "");

    // POST /start { mode?, isbns? } — uten mode: sjekk
    if (path === "start" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const userId = jwtUserId ?? (body.user_id as string | null | undefined) ?? null;
      const mode = body.mode === "update" ? "update" : "analyze";
      const isbns = Array.isArray(body.isbns) ? body.isbns.map(String).filter((s: string) => /^\d{13}$/.test(s)) : null;

      let existingQ = supabase.from("jobs").select("id").eq("type", JOB_TYPE).in("status", ["running", "paused", "pending"]).limit(1);
      existingQ = userId ? existingQ.eq("user_id", userId) : existingQ.is("user_id", null);
      const { data: existing } = await existingQ;
      if (existing?.length) return json({ error: "Oppdatering av bøker kjører allerede", jobId: existing[0].id }, 409);

      const total = isbns?.length ?? await getProductCount();
      const { data: job, error } = await supabase.from("jobs").insert({
        type: JOB_TYPE, status: "running", user_id: userId, started_at: new Date().toISOString(), total_items: total,
        config: { mode, isbns: isbns?.length ? isbns : null, shopify_cursor: null },
      }).select().single();
      if (error || !job) return json({ error: "Kunne ikke opprette jobb" }, 500);

      // @ts-ignore
      EdgeRuntime.waitUntil(processBatch(job.id));
      return json({ jobId: job.id, status: "running", mode }, 202);
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
      let q = supabase.from("jobs").select("id").eq("type", JOB_TYPE).eq("status", "paused").order("created_at", { ascending: false }).limit(1);
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
