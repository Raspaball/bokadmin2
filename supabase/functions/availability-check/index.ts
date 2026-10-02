// supabase/functions/availability-check/index.ts
// Deploy: supabase functions deploy availability-check --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { ALL_PRODUCT_STATUSES, shopifyGraphQL } from "../_shared/shopify.ts";
import { getCaller, scheduledUserId } from "../_shared/auth.ts";
import { BOKBASEN_ONIX_URL, getBokbasenToken } from "../_shared/bokbasen-auth.ts";
import { BOK_ISBN_FIELD, extractIsbn } from "../_shared/isbn.js";
import { extractAvailabilityCode, extractPublishingDate } from "../_shared/onix.js";
import { protectedMessage, protectedTag } from "../_shared/protected.ts";
import {
  availabilityDescription, availabilityMetafields, availabilityRule, needsContinuePolicy, type AvailabilityRule,
} from "../_shared/availability.ts";

const PAGE_SIZE = 250;
const TIMEOUT_MS = 45_000; // Leave 15s headroom

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Supabase client ─────────────────────────────────────────────────────────
function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, key);
}

// ── Shopify helpers ─────────────────────────────────────────────────────────

interface ShopifyProduct {
  id: string;
  status: string;
  handle: string;
  tags: string[];
  bokIsbn?: { value: string } | null;
  tilgjengelighet?: { value: string } | null;
  utgivelsesdato?: { value: string } | null;
  variants: {
    edges: Array<{
      node: {
        id: string;
        barcode: string | null;
        price: string;
        inventoryPolicy: string;
        inventoryItem: { sku: string | null; tracked: boolean };
      };
    }>;
  };
}

interface ShopifyPage {
  products: ShopifyProduct[];
  hasNextPage: boolean;
  endCursor: string | null;
}


// userId-parameterne beholdes for jobbenes kallsignatur. Shopify-tilgangen er
// felles for hele serveren (se _shared/shopify.ts).
async function fetchShopifyProductsPage(
  _userId: string | null,
  cursor: string | null,
  pageSize: number = PAGE_SIZE
): Promise<ShopifyPage> {
  // Explicitly fetch all statuses — without this, Shopify defaults to ACTIVE only,
  // meaning DRAFT and ARCHIVED products are never checked or re-activated.
  const query = `
    query($first: Int!, $after: String) {
      products(first: $first, after: $after, query: "${ALL_PRODUCT_STATUSES}") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            status
            handle
            tags
            ${BOK_ISBN_FIELD}
            tilgjengelighet: metafield(namespace: "bok", key: "tilgjengelighet") { value }
            utgivelsesdato: metafield(namespace: "bok", key: "utgivelsesdato") { value }
            variants(first: 1) {
              edges {
                node {
                  id
                  barcode
                  price
                  inventoryPolicy
                  inventoryItem { sku tracked }
                }
              }
            }
          }
        }
      }
    }
  `;

  const { data } = await shopifyGraphQL<{
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: ShopifyProduct }>;
    };
  }>(query, { first: pageSize, after: cursor });

  return {
    products: data.products.edges.map(e => e.node),
    hasNextPage: data.products.pageInfo.hasNextPage,
    endCursor: data.products.pageInfo.endCursor,
  };
}

async function getShopifyProductCount(_userId: string | null): Promise<number> {
  try {
    const { data } = await shopifyGraphQL<{ productsCount: { count: number } }>(
      `{ productsCount(query: "${ALL_PRODUCT_STATUSES}") { count } }`
    );
    return data.productsCount?.count || 0;
  } catch {
    return 0;
  }
}

// extractIsbn: felles regel i _shared/isbn.js (bok.isbn → strekkode → SKU → ISBN-handle)

// ── ONIX List 65 → status, bok.tilgjengelighet og kjøpbarhet ────────────────
// Regelen står i _shared/availability.ts (availabilityRule), felles med push og
// CSV-eksporten. Koden og datoen leses med _shared/onix.js.

interface OnixAvailability {
  code: string | null;
  /** Utgivelsesdato som YYYY-MM-DD, eller null */
  date: string | null;
}

/** Tilgjengelighetskode og utgivelsesdato fra Bokbasen, eller null når oppslaget feiler. */
async function fetchBokbasenAvailability(isbn: string, userId: string | null): Promise<OnixAvailability | null> {
  const token = await getBokbasenToken(userId);
  const res = await fetch(`${BOKBASEN_ONIX_URL}/${isbn}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const xml = await res.text();
  return { code: extractAvailabilityCode(xml), date: extractPublishingDate(xml) };
}

interface AvailabilityChanges {
  status?: { from: string; to: string };
  tilgjengelighet?: { from: string | null; to: string };
  utgivelsesdato?: { from: string | null; to: string };
  /** inventoryPolicy DENY → CONTINUE (sporet lager), slik at boka kan kjøpes uansett lager */
  continuePolicy?: boolean;
}

/** Hva som må endres på produktet for å følge regelen. Tomt objekt = ingenting. */
function availabilityChanges(product: ShopifyProduct, rule: AvailabilityRule, date: string | null): AvailabilityChanges {
  const changes: AvailabilityChanges = {};
  if (product.status !== rule.status) changes.status = { from: product.status || "ukjent", to: rule.status };
  const currentTilg = product.tilgjengelighet?.value ?? null;
  if (currentTilg !== rule.tilgjengelighet) changes.tilgjengelighet = { from: currentTilg, to: rule.tilgjengelighet };
  const currentDate = product.utgivelsesdato?.value ?? null;
  if (date && currentDate !== date) changes.utgivelsesdato = { from: currentDate, to: date };
  if (needsContinuePolicy(rule, product.variants?.edges?.[0]?.node)) changes.continuePolicy = true;
  return changes;
}

/** «status DRAFT → ACTIVE, tilgjengelighet → kommer, utgivelsesdato → 15.11.2026, salg uten lager» */
function describeChanges(c: AvailabilityChanges): string {
  const parts: string[] = [];
  if (c.status) parts.push(`status ${c.status.from} → ${c.status.to}`);
  if (c.tilgjengelighet) parts.push(`tilgjengelighet ${c.tilgjengelighet.from ?? "mangler"} → ${c.tilgjengelighet.to}`);
  if (c.utgivelsesdato) parts.push(`utgivelsesdato ${c.utgivelsesdato.from ?? "mangler"} → ${c.utgivelsesdato.to}`);
  if (c.continuePolicy) parts.push("salg uten lager (inventoryPolicy CONTINUE)");
  return parts.join(", ");
}

/** Gjør endringene i Shopify. Kaster med Shopifys feilmelding hvis noe feiler. */
async function applyAvailabilityChanges(
  product: ShopifyProduct,
  rule: AvailabilityRule,
  date: string | null,
  c: AvailabilityChanges,
): Promise<void> {
  const errs = (list: Array<{ message: string }> | undefined) => (list ?? []).map((e) => e.message).join(", ");

  if (c.continuePolicy) {
    const variantId = product.variants.edges[0].node.id;
    const { data } = await shopifyGraphQL<{ productVariantsBulkUpdate: { userErrors: Array<{ message: string }> } }>(
      `mutation variantPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id inventoryPolicy }
          userErrors { field message }
        }
      }`,
      { productId: product.id, variants: [{ id: variantId, inventoryPolicy: "CONTINUE" }] },
    );
    const e = errs(data.productVariantsBulkUpdate?.userErrors);
    if (e) throw new Error(`inventoryPolicy: ${e}`);
  }

  if (c.tilgjengelighet || c.utgivelsesdato) {
    const { data } = await shopifyGraphQL<{ metafieldsSet: { userErrors: Array<{ message: string }> } }>(
      `mutation availabilityMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key value }
          userErrors { field message }
        }
      }`,
      { metafields: availabilityMetafields(product.id, rule, date) },
    );
    const e = errs(data.metafieldsSet?.userErrors);
    if (e) throw new Error(`metafelt: ${e}`);
  }

  // Status sist: blir boka ACTIVE, er den da allerede kjøpbar og har metafeltene
  if (c.status) {
    const { data } = await shopifyGraphQL<{ productUpdate: { userErrors: Array<{ message: string }> } }>(
      `mutation productStatus($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { id status }
          userErrors { field message }
        }
      }`,
      { product: { id: product.id, status: rule.status } },
    );
    const e = errs(data.productUpdate?.userErrors);
    if (e) throw new Error(`status: ${e}`);
  }
}

// ── Process a batch of products from Shopify ────────────────────────────────
async function processBatch(jobId: string) {
  const supabase = getSupabase();
  const startTime = Date.now();

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (jobError || !job) {
    console.error("Job not found:", jobId);
    return;
  }

  if (job.status !== "running" && job.status !== "paused") {
    return;
  }

  await supabase.from("jobs").update({
    status: "running",
    started_at: job.started_at || new Date().toISOString(),
  }).eq("id", jobId);

  const mode = job.config?.mode || "analyze";
  const cursor: string | null = job.config?.shopify_cursor || null;
  const pageStartIndex: number = job.config?.page_start_index || 0;
  const userId: string | null = job.user_id || null;
  let succeeded = job.succeeded || 0;
  let failed = job.failed || 0;
  let skipped = job.skipped || 0;
  let processed = job.processed || 0;
  // Beskyttede produkter (_shared/protected.ts) telles for seg, ikke som «OK»
  const protectedAtStart: number = job.config?.skipped_protected || 0;
  let skippedProtected = protectedAtStart;

  try {
    const page = await fetchShopifyProductsPage(userId, cursor);

    for (let i = 0; i < page.products.length; i++) {
      const product = page.products[i];

      // Skip products already processed in a previous pulse on this same page.
      if (i < pageStartIndex) continue;

      // Re-read job to check for cancellation
      const { data: freshJob } = await supabase
        .from("jobs").select("status").eq("id", jobId).single();
      if (freshJob?.status === "failed") return; // cancelled

      // Timeout safety — save start-of-page cursor + index so next resume
      // skips already-processed products instead of re-fetching them.
      if (Date.now() - startTime > TIMEOUT_MS) {
        await supabase.from("jobs").update({
          status: "paused",
          processed,
          succeeded,
          failed,
          skipped,
          current_isbn: null,
          config: { ...job.config, shopify_cursor: cursor, page_start_index: i, skipped_protected: skippedProtected },
        }).eq("id", jobId);
        return;
      }

      const isbn = extractIsbn(product);

      await supabase.from("jobs").update({
        current_isbn: isbn || product.handle,
        processed,
      }).eq("id", jobId);

      // Beskyttet (tagg gave/lokal/lokalhistorie/lokallitteratur): status og metafelt røres aldri
      if (protectedTag(product.tags)) {
        await supabase.from("sync_log").insert({
          isbn, title: product.handle, action: "availability_check", status: "info",
          message: protectedMessage(product.tags), shopify_id: product.id, job_id: jobId, user_id: userId,
        });
        skippedProtected++;
        processed++;
        continue;
      }

      if (!isbn) {
        skipped++;
        processed++;
        continue;
      }

      try {
        const bokbasenAvailability = await fetchBokbasenAvailability(isbn, userId);

        if (bokbasenAvailability === null) {
          failed++;
          await supabase.from("sync_log").insert({
            isbn,
            title: product.handle,
            action: "availability_check",
            status: "error",
            message: "Kunne ikke hente tilgjengelighet fra Bokbasen",
            shopify_id: product.id,
            job_id: jobId,
            user_id: userId,
          });
          processed++;
          continue;
        }

        const rule = availabilityRule(bokbasenAvailability.code);
        const date = bokbasenAvailability.date;
        const changes = availabilityChanges(product, rule, date);

        if (Object.keys(changes).length === 0) {
          skipped++;
          processed++;
          continue;
        }

        // «Kommer 15.11.2026: ACTIVE, kan forhåndsbestilles (status DRAFT → ACTIVE, …)»
        const what = `${availabilityDescription(rule, date)} (${describeChanges(changes)})`;

        if (mode === "analyze") {
          await supabase.from("sync_log").insert({
            isbn,
            title: product.handle,
            action: "availability_check",
            status: "success",
            message: `Ville endret: ${what}`,
            shopify_id: product.id,
            job_id: jobId,
            user_id: userId,
          });
          succeeded++;
        } else {
          let error: string | null = null;
          try {
            await applyAvailabilityChanges(product, rule, date, changes);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }

          await supabase.from("sync_log").insert({
            isbn,
            title: product.handle,
            action: "availability_update",
            status: error ? "error" : "success",
            message: error ? `Endring feilet: ${what}. ${error}` : `Endret: ${what}`,
            shopify_id: product.id,
            job_id: jobId,
            user_id: userId,
          });

          if (error) failed++;
          else succeeded++;
        }
      } catch (err) {
        failed++;
        console.error(`Error processing ${isbn}:`, err);
      }

      processed++;
    }

    const isComplete = !page.hasNextPage;

    await supabase.from("jobs").update({
      status: isComplete ? "completed" : "paused",
      processed,
      succeeded,
      failed,
      skipped,
      current_isbn: null,
      config: {
        ...job.config,
        shopify_cursor: page.endCursor,
        page_start_index: 0,
        skipped_protected: skippedProtected,
      },
      ...(isComplete ? {
        completed_at: new Date().toISOString(),
        total_items: processed,
        result: { total: processed, processed, succeeded, failed, skipped, skippedProtected },
      } : {}),
    }).eq("id", jobId);

  } catch (err) {
    console.error("Batch processing error:", err);
    const errMsg = String(err);
    // Fatal auth/config errors → fail permanently to avoid infinite retry loop.
    // Transient errors (network, throttle) → stay paused so pg_cron retries.
    const isFatal = errMsg.includes("HTTP 401") || errMsg.includes("HTTP 403");
    await supabase.from("jobs").update({
      status: isFatal ? "failed" : "paused",
      error_message: errMsg,
      processed,
      succeeded,
      failed,
      skipped,
      config: { ...job.config, shopify_cursor: cursor, page_start_index: pageStartIndex, skipped_protected: protectedAtStart },
    }).eq("id", jobId);
  }
}

// ── Main handler ────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/availability-check\/?/, "");
    const supabase = getSupabase();
    // Verifisert bruker (auth.getUser i _shared/auth.ts), aldri lest rett fra tokenet
    const jwtUserId = (await getCaller(req)).userId;

    // POST /availability-check/start
    if (path === "start" && req.method === "POST") {
      // Accept user_id from body when called from pg_cron (anon JWT, no sub claim)
      const body = await req.json().catch(() => ({}));
      // pg_cron (anon-nøkkel) sender user_id: godtas bare for brukere med aktiv planlagt oppgave
      const userId = jwtUserId ?? await scheduledUserId(supabase, body.user_id, "availability_check");
      const mode = body.mode || "analyze";

      let existingQuery = supabase
        .from("jobs")
        .select("id, status")
        .eq("type", "availability_check")
        .in("status", ["running", "paused", "pending"])
        .limit(1);

      if (userId) {
        existingQuery = existingQuery.eq("user_id", userId);
      } else {
        existingQuery = existingQuery.is("user_id", null);
      }

      const { data: existing } = await existingQuery.single();

      if (existing) {
        return new Response(JSON.stringify({
          error: "En tilgjengelighetssjekk kjorer allerede",
          jobId: existing.id,
        }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const totalProducts = await getShopifyProductCount(userId);

      const { data: job, error } = await supabase
        .from("jobs")
        .insert({
          type: "availability_check",
          status: "running",
          user_id: userId,
          started_at: new Date().toISOString(),
          total_items: totalProducts,
          config: { mode, shopify_cursor: null },
        })
        .select()
        .single();

      if (error || !job) {
        return new Response(JSON.stringify({ error: "Kunne ikke opprette jobb" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const response = new Response(JSON.stringify({ jobId: job.id, status: "running", mode }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

      // @ts-ignore
      EdgeRuntime.waitUntil(processBatch(job.id));

      return response;
    }

    // Use jwtUserId for all other endpoints
    const userId = jwtUserId;

    // GET /availability-check/status/:jobId
    const statusMatch = path.match(/^status\/(.+)$/);
    if (statusMatch && req.method === "GET") {
      const jobId = statusMatch[1];
      const { data: job, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("id", jobId)
        .single();

      if (error || !job) {
        return new Response(JSON.stringify({ error: "Jobb ikke funnet" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (userId && job.user_id && job.user_id !== userId) {
        return new Response(JSON.stringify({ error: "Ingen tilgang til denne jobben" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(job), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /availability-check/cancel/:jobId
    const cancelMatch = path.match(/^cancel\/(.+)$/);
    if (cancelMatch && req.method === "POST") {
      const jobId = cancelMatch[1];

      const { data: job } = await supabase
        .from("jobs")
        .select("id, user_id")
        .eq("id", jobId)
        .single();

      if (!job) {
        return new Response(JSON.stringify({ error: "Jobb ikke funnet" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (userId && job.user_id && job.user_id !== userId) {
        return new Response(JSON.stringify({ error: "Ingen tilgang til denne jobben" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase.from("jobs").update({
        status: "failed",
        error_message: "Avbrutt av bruker",
        completed_at: new Date().toISOString(),
      }).eq("id", jobId).in("status", ["running", "paused", "pending"]);

      return new Response(JSON.stringify({ status: "cancelled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /availability-check/resume/:jobId
    const resumeMatch = path.match(/^resume\/(.+)$/);
    if (resumeMatch && req.method === "POST") {
      const jobId = resumeMatch[1];

      const { data: job } = await supabase
        .from("jobs")
        .select("id, user_id")
        .eq("id", jobId)
        .single();

      if (!job) {
        return new Response(JSON.stringify({ error: "Jobb ikke funnet" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (userId && job.user_id && job.user_id !== userId) {
        return new Response(JSON.stringify({ error: "Ingen tilgang til denne jobben" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const response = new Response(JSON.stringify({ status: "resuming", jobId }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      // @ts-ignore
      EdgeRuntime.waitUntil(processBatch(jobId));
      return response;
    }

    // POST /availability-check/resume-paused
    if (path === "resume-paused" && req.method === "POST") {
      let pausedQuery = supabase
        .from("jobs")
        .select("id")
        .eq("type", "availability_check")
        .eq("status", "paused")
        .order("created_at", { ascending: false })
        .limit(1);

      // If called with a specific userId (e.g. direct frontend call), scope to that user.
      // If called without userId (e.g. pg_cron with anon key), resume ANY paused job —
      // processBatch() reads user_id from the job row itself to get the right credentials.
      if (userId) {
        pausedQuery = pausedQuery.eq("user_id", userId);
      }

      const { data: pausedJobs } = await pausedQuery;

      if (pausedJobs && pausedJobs.length > 0) {
        const jobId = pausedJobs[0].id;
        const response = new Response(JSON.stringify({ status: "resuming", jobId }), {
          status: 202,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
        // @ts-ignore
        EdgeRuntime.waitUntil(processBatch(jobId));
        return response;
      }

      return new Response(JSON.stringify({ status: "no_paused_jobs" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /availability-check/active
    if (path === "active" && req.method === "GET") {
      let activeQuery = supabase
        .from("jobs")
        .select("*")
        .eq("type", "availability_check")
        .in("status", ["running", "paused", "pending"])
        .order("created_at", { ascending: false })
        .limit(1);

      if (userId) {
        activeQuery = activeQuery.eq("user_id", userId);
      } else {
        activeQuery = activeQuery.is("user_id", null);
      }

      const { data: job } = await activeQuery.single();

      return new Response(JSON.stringify(job || null), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /availability-check/recent
    if (path === "recent" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "10");
      let recentQuery = supabase
        .from("jobs")
        .select("*")
        .eq("type", "availability_check")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (userId) {
        recentQuery = recentQuery.eq("user_id", userId);
      } else {
        recentQuery = recentQuery.is("user_id", null);
      }

      const { data: jobs } = await recentQuery;

      return new Response(JSON.stringify(jobs || []), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
