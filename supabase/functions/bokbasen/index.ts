// supabase/functions/bokbasen/index.ts
// Deploy: supabase functions deploy bokbasen

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { type BokbasenCredentials, getBokbasenCredentials, getBokbasenToken } from "../_shared/bokbasen-auth.ts";
import { getCaller } from "../_shared/auth.ts";
import { type BookMetadata, parseOnix, parseOnixMulti } from "../_shared/onix-book.ts";

const BOKBASEN_API_BASE = "https://api.bokbasen.io/metadata";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};


// ── Route handlers ───────────────────────────────────────────────────────────

// GET /bokbasen/isbn/:isbn — fetch full metadata for one ISBN
// Add ?raw=true to get raw ONIX XML for debugging
async function handleIsbnFetch(isbn: string, credentials: BokbasenCredentials | null, raw = false): Promise<Response> {
  const token = await getBokbasenToken(credentials);
  const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2/${isbn}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `Bokbasen returned ${res.status}` }), {
      status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const xml = await res.text();
  if (raw) {
    return new Response(xml, {
      headers: { ...corsHeaders, "Content-Type": "application/xml" },
    });
  }
  const metadata = parseOnix(xml, isbn);
  if (!metadata) {
    return new Response(JSON.stringify({ error: "Could not parse ONIX or format excluded" }), {
      status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(metadata), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// GET /bokbasen/search?q=...&field=isbn|title|author — search Bokbasen
// Note: Bokbasen ONIX export API only supports ISBN lookup, not free-text search.
// For title/author, we return an informative error. For ISBN, we support
// single ISBN and comma/space-separated multi-ISBN queries.
async function handleSearch(query: string, field: string, credentials: BokbasenCredentials | null): Promise<Response> {
  if (field !== "isbn") {
    return new Response(JSON.stringify({
      error: "Bokbasen API støtter kun ISBN-oppslag. Bruk ISBN-feltet for å søke.",
      results: [],
      total: 0,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Support single or multiple ISBNs (comma/space/newline separated)
  const isbns = query
    .split(/[,;\s\n]+/)
    .map(s => s.replace(/[^0-9Xx]/g, ""))
    .filter(s => s.length >= 10);

  if (isbns.length === 0) {
    return new Response(JSON.stringify({ error: "Ingen gyldige ISBN funnet i søket", results: [], total: 0 }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Single ISBN — use direct fetch
  if (isbns.length === 1) {
    return handleIsbnFetch(isbns[0], credentials);
  }

  // Multiple ISBNs — fetch each and return array
  const results: BookMetadata[] = [];
  for (const isbn of isbns) {
    try {
      const token = await getBokbasenToken(credentials);
      const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2/${isbn}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parseOnix(xml, isbn);
      if (parsed) results.push(parsed);
    } catch (_) {
      // Skip failed ISBNs
    }
  }

  return new Response(JSON.stringify({ results, total: results.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// GET /bokbasen/date-range?from=YYYY-MM-DD&to=YYYY-MM-DD — fetch books published in date range
async function handleDateRange(from: string, to: string, credentials: BokbasenCredentials | null): Promise<Response> {
  // Convert YYYY-MM-DD to comparable YYYYMMDD strings for filtering
  const fromCompare = from.replace(/-/g, "");  // e.g. "20050101"
  const toCompare = to.replace(/-/g, "");      // e.g. "20061231"

  // Bokbasen's "after" param filters by modification date, not publication date.
  // We use it as a rough lower bound, then filter by actual publication date below.
  const afterTs = fromCompare + "000000";

  const token = await getBokbasenToken(credentials);
  const subscription = credentials?.subscription || "extended";
  const pageSize = 50;
  const maxPages = 100; // 5 000 books max; returns truncated=true if hit

  const allResults: BookMetadata[] = [];
  let nextToken: string | null = null;
  let page = 0;
  let truncated = false;
  let totalFetched = 0;

  while (page < maxPages) {
    const params = new URLSearchParams({
      subscription,
      pagesize: String(pageSize),
    });
    if (nextToken) {
      params.set("next", nextToken);
    } else {
      params.set("after", afterTs);
    }

    const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      // 404 or empty means no more data
      if (res.status === 404) break;
      return new Response(JSON.stringify({ error: `Bokbasen returned ${res.status}` }), {
        status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const xml = await res.text();
    const parsed = parseOnixMulti(xml);
    totalFetched += parsed.length;

    // Filter by publication date — only include books published within [from, to]
    for (const book of parsed) {
      const pd = book.publicationDate || book.year || "";
      // Normalize to 8 chars for comparison: "2005" → "20050101", "200506" → "20050601"
      let normalized = pd.replace(/-/g, "");
      if (normalized.length === 4) normalized += "0101";
      else if (normalized.length === 6) normalized += "01";
      else if (normalized.length < 4) continue;  // Not enough data to filter
      normalized = normalized.slice(0, 8);

      if (normalized >= fromCompare && normalized <= toCompare) {
        allResults.push(book);
      }
    }

    // Check for next page token in response headers
    const newNextToken = res.headers.get("Next") || res.headers.get("next");
    if (!newNextToken || newNextToken === nextToken) break; // No more pages
    nextToken = newNextToken;
    page++;

    if (page >= maxPages) {
      truncated = true;
      break;
    }
  }

  return new Response(JSON.stringify({
    results: allResults,
    total: allResults.length,
    totalFetched,
    pages: page + 1,
    truncated,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// POST /bokbasen/enrich-db — fetch bokgruppekode from Bokbasen for all DB books missing it
async function handleEnrichDb(credentials: BokbasenCredentials | null, userId: string | null): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Fetch all ISBNs in our DB that lack bokgruppekode
  const scopeFilter = userId
    ? `&user_id=eq.${encodeURIComponent(userId)}`
    : "&user_id=is.null";
  const listRes = await fetch(
    `${supabaseUrl}/rest/v1/books?select=isbn&bokgruppekode=is.null${scopeFilter}`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
  );
  if (!listRes.ok) throw new Error(`Supabase list failed: ${await listRes.text()}`);
  const missing: { isbn: string }[] = await listRes.json();

  const total = missing.length;
  let updated = 0, failed = 0, noData = 0;

  // Process in batches of 10 (parallel Bokbasen calls)
  const batchSize = 10;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async ({ isbn }) => {
        const token = await getBokbasenToken(credentials);
        const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2/${isbn}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Bokbasen ${res.status}`);
        const xml = await res.text();
        const metadata = parseOnix(xml, isbn);
        if (!metadata?.bokgruppekode) throw new Error("no_data");
        return { isbn, bokgruppekode: metadata.bokgruppekode, varegruppe: metadata.varegruppe };
      })
    );

    // Write successful enrichments back to Supabase
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { isbn, bokgruppekode, varegruppe } = result.value;
        const updateScope = userId
          ? `isbn=eq.${encodeURIComponent(isbn)}&user_id=eq.${encodeURIComponent(userId)}`
          : `isbn=eq.${encodeURIComponent(isbn)}&user_id=is.null`;
        const patch = await fetch(
          `${supabaseUrl}/rest/v1/books?${updateScope}`,
          {
            method: "PATCH",
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ bokgruppekode, varegruppe }),
          }
        );
        patch.ok ? updated++ : failed++;
      } else {
        const msg = String((result as PromiseRejectedResult).reason);
        msg.includes("no_data") ? noData++ : failed++;
      }
    }

    if (i + batchSize < missing.length) {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  return new Response(JSON.stringify({ total, updated, noData, failed }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/bokbasen\/?/, "");
    // Verifisert bruker (auth.getUser i _shared/auth.ts), aldri lest rett fra tokenet
    const userId = (await getCaller(req)).userId;
    const credentials = await getBokbasenCredentials(userId);

    // /bokbasen/isbn/9788202693985  (add ?raw=true to get raw ONIX XML)
    const isbnMatch = path.match(/^isbn\/([0-9Xx]+)$/i);
    if (isbnMatch) {
      const raw = url.searchParams.get("raw") === "true";
      return await handleIsbnFetch(isbnMatch[1].replace(/[^0-9Xx]/g, ""), credentials, raw);
    }

    // POST /bokbasen/enrich-db — enrich all books in DB with bokgruppekode from Bokbasen
    if (path === "enrich-db" && req.method === "POST") {
      return await handleEnrichDb(credentials, userId);
    }

    // /bokbasen/date-range?from=2026-01-01&to=2026-01-31
    if (path === "date-range" || path.startsWith("date-range?")) {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      if (!from || !to) return new Response(JSON.stringify({ error: "Missing 'from' and/or 'to' query params (YYYY-MM-DD)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      return await handleDateRange(from, to, credentials);
    }

    // /bokbasen/search?q=hamsun&field=author
    if (path === "search" || path.startsWith("search?")) {
      const q = url.searchParams.get("q") || "";
      const field = url.searchParams.get("field") || "title";
      if (!q) return new Response(JSON.stringify({ error: "Missing query param 'q'" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      return await handleSearch(q, field, credentials);
    }

    // POST /bokbasen/formats — batch ISBN → format lookup
    if (path === "formats" && req.method === "POST") {
      const body = await req.json();
      const isbns: string[] = (body.isbns || []).map((s: string) => s.replace(/[^0-9Xx]/g, "")).filter((s: string) => s.length >= 10);
      if (isbns.length === 0) {
        return new Response(JSON.stringify({ formats: {} }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const FORMAT_MAP: Record<string, string> = {
        BA: "Paperback", BB: "Innbundet", BC: "Heftet", BD: "Løsblad",
        BE: "Spiralbundet", BF: "Pamflett", BG: "Skinninnbundet", BH: "Pekebokbok",
        BI: "Tøybok", BJ: "Badebok", BK: "Aktivitetsbok", BL: "Glidebundet",
        BM: "Storbok", BN: "Hefte", BO: "Utbrettsbok", BP: "Skumbok", BZ: "Annet bokformat",
        AA: "Lyd", AB: "Lydkassett", AC: "CD-lydbok", AJ: "Nedlastbar lydfil",
        AI: "DVD-lyd", AN: "Nedlastbar/online lydfil", AO: "Online lydfil", AM: "LP",
        DA: "Digitalt", DB: "CD-ROM", DI: "DVD-ROM",
        EA: "Digitalt", EB: "E-bok", EC: "Online digital", ED: "Nedlastbar digital",
        CA: "Kart", SA: "Sammensatt produkt",
      };

      const formats: Record<string, string> = {};
      const token = await getBokbasenToken(credentials);

      // Process in batches of 10 to avoid overloading Bokbasen
      const batchSize = 10;
      for (let i = 0; i < isbns.length; i += batchSize) {
        const batch = isbns.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (isbn) => {
            const res = await fetch(`${BOKBASEN_API_BASE}/export/onix/v2/${isbn}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return null;
            const xml = await res.text();
            const codeMatch = xml.match(/<ProductForm[^>]*>([^<]+)<\/ProductForm>/i);
            const code = codeMatch?.[1]?.trim().toUpperCase() || null;
            if (code) {
              formats[isbn] = FORMAT_MAP[code] || code;
            }
          })
        );
        // Small delay between batches
        if (i + batchSize < isbns.length) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      return new Response(JSON.stringify({ formats }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
