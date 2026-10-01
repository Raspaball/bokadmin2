// supabase/functions/availability-check/index.ts
// Deploy: supabase functions deploy availability-check --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { ALL_PRODUCT_STATUSES, shopifyGraphQL } from "../_shared/shopify.ts";
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

interface UserSettingsRow {
  bokbasen_client_id?: string | null;
  bokbasen_client_secret?: string | null;
}

interface BokbasenCredentials {
  clientId: string;
  clientSecret: string;
}

interface TokenCacheEntry {
  token: string;
  expiry: number;
}

const bokbasenTokenCache = new Map<string, TokenCacheEntry>();

function getUserIdFromJWT(authHeader: string): string | null {
  try {
    const token = authHeader.replace("Bearer ", "");
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

async function getUserSettings(userId: string | null): Promise<UserSettingsRow | null> {
  if (!userId) return null;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const res = await fetch(
      `${supabaseUrl}/rest/v1/user_settings?user_id=eq.${userId}&select=bokbasen_client_id,bokbasen_client_secret`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const rows = await res.json();
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

async function getBokbasenCredentials(userId: string | null): Promise<BokbasenCredentials> {
  const settings = await getUserSettings(userId);
  if (settings?.bokbasen_client_id && settings?.bokbasen_client_secret) {
    return {
      clientId: settings.bokbasen_client_id,
      clientSecret: settings.bokbasen_client_secret,
    };
  }

  return {
    clientId: Deno.env.get("BOKBASEN_CLIENT_ID")!,
    clientSecret: Deno.env.get("BOKBASEN_CLIENT_SECRET")!,
  };
}

async function getBokbasenToken(userId: string | null): Promise<string> {
  const credentials = await getBokbasenCredentials(userId);
  const cacheKey = `${credentials.clientId}:${credentials.clientSecret}`;
  const cached = bokbasenTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.token;

  const res = await fetch("https://auth.bokbasen.io/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      audience: "https://api.bokbasen.io/metadata/",
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) throw new Error(`Bokbasen auth failed: ${res.status}`);
  const data = await res.json();
  const token = data.access_token as string;
  const expiry = Date.now() + (data.expires_in - 60) * 1000;
  bokbasenTokenCache.set(cacheKey, { token, expiry });
  return token;
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

// ── ONIX List 65 → Shopify status mapping ───────────────────────────────────
// Canonical source: src/app/utils/availabilityCodes.ts (frontend).
// This Deno function cannot import from src/, so the logic is duplicated here.
// Keep in sync with mapAvailabilityToShopifyStatus() in availabilityCodes.ts.
//
// ACTIVE:   20–23 (tilgjengelig)
// ARCHIVED: 43=bekreftet utsolgt, 44=ikke vårt produkt, 45=rettighetstap, 46=trukket
// DRAFT:    everything else (midlertidig/usikker utilgjengelighet)
function mapAvailabilityToShopifyStatus(code: string): "ACTIVE" | "DRAFT" | "ARCHIVED" {
  const num = parseInt(code, 10);
  if (isNaN(num)) return "DRAFT";
  if (num >= 20 && num <= 23) return "ACTIVE";
  // Permanently unavailable: no longer supplied (43), withdrawn from sale (46), recalled (49)
  // 44 = "Apply direct" and 45 = "Not sold separately" are NOT permanent → DRAFT
  if (num === 43 || num === 46 || num === 49) return "ARCHIVED";
  return "DRAFT";
}

function availabilityStatusLabel(code: string): string {
  const num = parseInt(code, 10);
  if (isNaN(num)) return "unknown";
  if (num >= 20 && num <= 23) return "available";
  if (num === 43 || num === 44 || num === 45 || num === 46) return "permanently_unavailable";
  if (num >= 30 && num <= 34) return "temporarily_unavailable";
  if (num >= 40) return "not_available";
  if (num === 1 || (num >= 9 && num <= 12)) return "not_yet_available";
  return "unknown";
}

async function fetchBokbasenAvailability(isbn: string, userId: string | null): Promise<string | null> {
  const token = await getBokbasenToken(userId);
  const res = await fetch(`https://api.bokbasen.io/metadata/export/onix/v2/${isbn}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) return null;

  const xml = (await res.text())
    .replace(/\s+xmlns[^"]*"[^"]*"/g, "")
    .replace(/<(\w+:)/g, "<")
    .replace(/<\/(\w+:)/g, "</");

  const supplyBlocks = [...xml.matchAll(/<SupplyDetail[\s\S]*?<\/SupplyDetail>/gi)];
  for (const s of supplyBlocks) {
    const avail = s[0].match(/<ProductAvailability[^>]*>(\d+)<\/ProductAvailability>/i)?.[1];
    if (avail) return avail;
  }
  return null;
}

async function updateShopifyProductStatus(
  _userId: string | null,
  productId: string,
  newStatus: "ACTIVE" | "DRAFT" | "ARCHIVED"
): Promise<boolean> {
  try {
    const { data } = await shopifyGraphQL<{ productUpdate: { userErrors: Array<unknown> } }>(
      `mutation productUpdate($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { id status }
          userErrors { field message }
        }
      }`,
      { product: { id: productId, status: newStatus } }
    );
    return !data.productUpdate?.userErrors?.length;
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

  const mode = job.config?.mode || "analyze";
  const cursor: string | null = job.config?.shopify_cursor || null;
  const pageStartIndex: number = job.config?.page_start_index || 0;
  const userId: string | null = job.user_id || null;
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

      await supabase.from("jobs").update({
        current_isbn: isbn || product.handle,
        processed,
      }).eq("id", jobId);

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

        const expectedStatus = mapAvailabilityToShopifyStatus(bokbasenAvailability);
        const statusLabel = availabilityStatusLabel(bokbasenAvailability);
        const currentStatus = product.status;

        if (currentStatus === expectedStatus) {
          skipped++;
          processed++;
          continue;
        }

        if (mode === "analyze") {
          await supabase.from("sync_log").insert({
            isbn,
            title: product.handle,
            action: "availability_check",
            status: "success",
            message: `Avvik: Bokbasen kode ${bokbasenAvailability} (${statusLabel}) → bor vaere ${expectedStatus}, na: ${currentStatus || "ukjent"}`,
            shopify_id: product.id,
            job_id: jobId,
            user_id: userId,
          });
          succeeded++;
        } else {
          const shopifyOk = await updateShopifyProductStatus(userId, product.id, expectedStatus);

          await supabase.from("sync_log").insert({
            isbn,
            title: product.handle,
            action: "availability_update",
            status: shopifyOk ? "success" : "error",
            message: shopifyOk
              ? `Status endret: ${currentStatus || "ukjent"} → ${expectedStatus} (Bokbasen kode ${bokbasenAvailability})`
              : `Avvik funnet (${currentStatus} → ${expectedStatus}), men Shopify-oppdatering feilet`,
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
    const path = url.pathname.replace(/^\/availability-check\/?/, "");
    const supabase = getSupabase();
    const jwtUserId = getUserIdFromJWT(req.headers.get("Authorization") ?? "");

    // POST /availability-check/start
    if (path === "start" && req.method === "POST") {
      // Accept user_id from body when called from pg_cron (anon JWT, no sub claim)
      const body = await req.json().catch(() => ({}));
      const userId = jwtUserId ?? (body.user_id as string | null | undefined) ?? null;
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
