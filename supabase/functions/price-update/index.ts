// supabase/functions/price-update/index.ts
// Deploy: supabase functions deploy price-update --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { ALL_PRODUCT_STATUSES, shopifyGraphQL } from "../_shared/shopify.ts";
import { BOKBASEN_ONIX_URL, getBokbasenToken } from "../_shared/bokbasen-auth.ts";
import { choosePrice, type PriceChoice } from "../_shared/price.ts";
import { BOK_ISBN_FIELD, extractIsbn } from "../_shared/isbn.js";

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
  bokIsbn?: { value: string } | null;
  variants: {
    edges: Array<{
      node: {
        id: string;
        barcode: string | null;
        price: string;
        inventoryItem: { sku: string | null };
      };
    }>;
  };
}

interface ShopifyPage {
  products: ShopifyProduct[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function getUserIdFromJWT(authHeader: string): string | null {
  try {
    const token = authHeader.replace("Bearer ", "");
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

// userId-parameterne beholdes for jobbenes kallsignatur. Shopify-tilgangen er
// felles for hele serveren (se _shared/shopify.ts).
async function fetchShopifyProductsPage(
  _userId: string | null,
  cursor: string | null,
  pageSize: number = PAGE_SIZE
): Promise<ShopifyPage> {
  // Explicitly fetch all statuses — without this Shopify defaults to ACTIVE only,
  // meaning DRAFT and ARCHIVED products never get their prices checked.
  const query = `
    query($first: Int!, $after: String) {
      products(first: $first, after: $after, query: "${ALL_PRODUCT_STATUSES}") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            status
            handle
            ${BOK_ISBN_FIELD}
            variants(first: 1) {
              edges {
                node {
                  id
                  barcode
                  price
                  inventoryItem { sku }
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

// Pris fra Bokbasen etter regelen i _shared/price.ts (NOK, Norge, gyldig i dag,
// 04 > 03 > 02 > 01 > andre). price = null med årsak når ingen pris godkjennes.
async function fetchBokbasenPrice(isbn: string, userId: string | null): Promise<PriceChoice> {
  const token = await getBokbasenToken(userId);
  const res = await fetch(`${BOKBASEN_ONIX_URL}/${isbn}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { price: null };
  return choosePrice(await res.text());
}

async function updateShopifyPrice(
  _userId: string | null,
  productId: string,
  variantId: string,
  newPrice: number
): Promise<boolean> {
  try {
    const { data } = await shopifyGraphQL<{ productVariantsBulkUpdate: { userErrors: Array<unknown> } }>(
      `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }`,
      { productId, variants: [{ id: variantId, price: String(newPrice) }] }
    );
    return !data.productVariantsBulkUpdate?.userErrors?.length;
  } catch {
    return false;
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

  const cursor: string | null = job.config?.shopify_cursor || null;
  const pageStartIndex: number = job.config?.page_start_index || 0;
  const userId: string | null = job.user_id || null;
  const mode: string = job.config?.mode || "update";
  let succeeded = job.succeeded || 0;
  let failed = job.failed || 0;
  let skipped = job.skipped || 0;
  let processed = job.processed || 0;

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
          config: { ...job.config, shopify_cursor: cursor, page_start_index: i },
        }).eq("id", jobId);
        return;
      }

      const isbn = extractIsbn(product);
      const variantId = product.variants?.edges?.[0]?.node?.id;
      const currentPrice = product.variants?.edges?.[0]?.node?.price;

      await supabase.from("jobs").update({
        current_isbn: isbn || product.handle,
        processed,
      }).eq("id", jobId);

      if (!isbn || !variantId) {
        skipped++;
        processed++;
        continue;
      }

      try {
        const { price: bokbasenPrice, reason } = await fetchBokbasenPrice(isbn, userId);

        if (bokbasenPrice === null) {
          failed++;
          await supabase.from("sync_log").insert({
            isbn,
            title: product.handle,
            action: "update",
            status: "error",
            // Ingen godkjent pris: prisen endres ikke («ingen NOK-pris», «ingen gyldig pris i dag» …)
            message: reason ? `Ingen endring: ${reason}` : "Kunne ikke hente pris fra Bokbasen",
            shopify_id: product.id,
            job_id: jobId,
            user_id: userId,
          });
          processed++;
          continue;
        }

        if (bokbasenPrice <= 0) {
          failed++;
          await supabase.from("sync_log").insert({
            isbn,
            title: product.handle,
            action: "update",
            status: "error",
            message: `Avvist: Bokbasen returnerte ugyldig pris (${bokbasenPrice} kr) — ingen endring gjort`,
            shopify_id: product.id,
            job_id: jobId,
            user_id: userId,
          });
          processed++;
          continue;
        }

        const shopifyPrice = currentPrice ? parseFloat(currentPrice) : null;
        if (shopifyPrice !== null && Math.abs(shopifyPrice - bokbasenPrice) < 0.01) {
          skipped++;
          processed++;
          continue;
        }

        if (mode === "analyze") {
          // Analyze mode: log discrepancy without updating Shopify
          await supabase.from("sync_log").insert({
            isbn,
            title: product.handle,
            action: "update",
            status: "success",
            message: `Avvik: ${shopifyPrice ?? "mangler"} → ${bokbasenPrice} kr (ikke oppdatert)`,
            shopify_id: product.id,
            job_id: jobId,
            user_id: userId,
          });
          succeeded++;
        } else {
          // Update mode: actually change the price in Shopify
          const shopifyOk = await updateShopifyPrice(userId, product.id, variantId, bokbasenPrice);

          await supabase.from("sync_log").insert({
            isbn,
            title: product.handle,
            action: "update",
            status: shopifyOk ? "success" : "error",
            message: shopifyOk
              ? `Pris endret: ${shopifyPrice} → ${bokbasenPrice} kr`
              : `Pris endret (${shopifyPrice} → ${bokbasenPrice}), men Shopify-oppdatering feilet`,
            shopify_id: product.id,
            job_id: jobId,
            user_id: userId,
          });

          if (shopifyOk) succeeded++;
          else failed++;
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
      },
      ...(isComplete ? {
        completed_at: new Date().toISOString(),
        total_items: processed,
        result: { total: processed, processed, succeeded, failed, skipped },
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
      config: { ...job.config, shopify_cursor: cursor, page_start_index: pageStartIndex },
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
    const path = url.pathname.replace(/^\/price-update\/?/, "");
    const supabase = getSupabase();
    const jwtUserId = getUserIdFromJWT(req.headers.get("Authorization") ?? "");

    // POST /price-update/start
    if (path === "start" && req.method === "POST") {
      // Accept user_id from body when called from pg_cron (anon JWT, no sub claim)
      const body = await req.json().catch(() => ({}));
      const userId = jwtUserId ?? (body.user_id as string | null | undefined) ?? null;

      let existingQuery = supabase
        .from("jobs")
        .select("id, status")
        .eq("type", "price_update")
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
          error: "En prisoppdatering kjorer allerede",
          jobId: existing.id,
        }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const mode = (body.mode === "analyze" || body.mode === "update") ? body.mode : "update";
      const totalProducts = await getShopifyProductCount(userId);

      const { data: job, error } = await supabase
        .from("jobs")
        .insert({
          type: "price_update",
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

      const response = new Response(JSON.stringify({ jobId: job.id, status: "running" }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

      // @ts-ignore
      EdgeRuntime.waitUntil(processBatch(job.id));

      return response;
    }

    // Use jwtUserId for all other endpoints
    const userId = jwtUserId;

    // GET /price-update/status/:jobId
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

    // POST /price-update/cancel/:jobId
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

    // POST /price-update/resume/:jobId
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

    // POST /price-update/resume-paused
    if (path === "resume-paused" && req.method === "POST") {
      let pausedQuery = supabase
        .from("jobs")
        .select("id")
        .eq("type", "price_update")
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

    // GET /price-update/active
    if (path === "active" && req.method === "GET") {
      let activeQuery = supabase
        .from("jobs")
        .select("*")
        .eq("type", "price_update")
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

    // GET /price-update/recent
    if (path === "recent" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "10");
      let recentQuery = supabase
        .from("jobs")
        .select("*")
        .eq("type", "price_update")
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
