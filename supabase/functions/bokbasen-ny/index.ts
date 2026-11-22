// supabase/functions/bokbasen-ny/index.ts
// «Bokbasen ny» (UTKAST 22.11.2026): henter bokdata med LISTEOPPSLAGET i ONIX v3,
// ikke med enkeltoppslag per ISBN.
//
// Deploy (bare etter Eiriks ja, aldri mot live-prosjektet til gamle Bokadmin):
//   supabase functions deploy bokbasen-ny --no-verify-jwt --use-api --project-ref chwpqwblqummlufqdefe
//
// Bare lesing mot Bokbasen. Funksjonen skriver ingenting: ikke til Supabase, ikke til Shopify.
// Den husker heller ingenting: siden (BokbasenNy.tsx) holder bokmerket (`next`) og spør om
// én bunke om gangen. Én bunke per kall holder regnetiden nede (Supabase gir ca. 2 s per kall).
//
// POST /bokbasen-ny/hent
//   { after?: "YYYY-MM-DD" | "yyyyMMddHHmmss", next?: string, pagesize?: number (1–200, standard 50),
//     notificationType?: "updated" | "deleted" }
//   Én av `next` (bokmerke fra forrige svar) eller `after` må være med. `next` går foran.
// Svar:
//   { books: BookMetadata[], deleted: string[], next: string | null, done: boolean, stats: {...} }
//
// Tolkingen er den samme som dagens Bokbasen-fane (_shared/onix-book.ts). Reglene kopieres ikke.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { BOKBASEN_ONIX_V3_URL, clearBokbasenToken, getBokbasenCredentials, getBokbasenToken } from "../_shared/bokbasen-auth.ts";
import { getCaller } from "../_shared/auth.ts";
import { type BookMetadata, parseOnix } from "../_shared/onix-book.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** "2026-11-21" → "20261121000000". 14 sifre slippes rett gjennom. Ellers null. */
function afterParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length === 8) return digits + "000000";
  if (digits.length === 14) return digits;
  return null;
}

/** Bokmerket for neste bunke: headeren `Next`, ellers `next=` i `Link`-headeren. */
function nextCursor(headers: Headers): string | null {
  const next = headers.get("next");
  if (next) return next;
  const link = headers.get("link");
  const m = link?.match(/[?&]next=([^&>;\s]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

/** ISBN for én <Product>: ProductIDType 15 (ISBN-13), ellers 03 (EAN), ellers 02 (ISBN-10). */
function productIsbn(product: string): string {
  let isbn = "";
  for (const id of product.matchAll(/<ProductIdentifier[\s\S]*?<\/ProductIdentifier>/gi)) {
    const type = id[0].match(/<ProductIDType[^>]*>(.*?)<\/ProductIDType>/i)?.[1]?.trim();
    const value = id[0].match(/<IDValue[^>]*>(.*?)<\/IDValue>/i)?.[1]?.trim();
    if (!value) continue;
    if (type === "15") return value;
    if ((type === "03" || type === "02") && !isbn) isbn = value;
  }
  return isbn;
}

/**
 * v3: PublishingDate rolle 37 er utgivelsesåret (rolle 01 er nå «i salg»-dato) [Bokbasen: Changes ONIX 2026].
 * Tolkeren (parseOnix) leser fortsatt rolle 01. Her rettes bare året som vises, når rolle 37 finnes.
 * Den ordentlige rettingen hører hjemme i resolvePublication() (trinn 1).
 */
function year37(product: string): string | null {
  for (const pd of product.matchAll(/<PublishingDate>[\s\S]*?<\/PublishingDate>/gi)) {
    if (pd[0].match(/<PublishingDateRole[^>]*>\s*37\s*</i)) {
      const y = pd[0].match(/<Date[^>]*>\s*(\d{4})/i)?.[1];
      if (y) return y;
    }
  }
  return null;
}

async function handleHent(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const next = typeof body.next === "string" && body.next.trim() ? body.next.trim() : null;
  const after = afterParam(body.after);
  if (!next && !after) return json({ error: "Mangler «after» (dato) eller «next» (bokmerke)." }, 400);
  const pagesize = Math.min(200, Math.max(1, Number(body.pagesize) || 50));
  const notificationType = body.notificationType === "updated" || body.notificationType === "deleted" ? body.notificationType : null;

  // Verifisert bruker (auth.getUser i _shared/auth.ts). Uten innlogget bruker: ingen henting.
  const userId = (await getCaller(req)).userId;
  if (!userId) return json({ error: "Du må være logget inn." }, 401);
  const credentials = await getBokbasenCredentials(userId);
  if (!credentials) return json({ error: "Bokbasen-innlogging mangler (Innstillinger)." }, 400);

  const params = new URLSearchParams({ subscription: credentials.subscription, pagesize: String(pagesize) });
  if (next) params.set("next", next); else params.set("after", after!);
  if (notificationType) params.set("notificationType", notificationType);
  const url = `${BOKBASEN_ONIX_V3_URL}?${params}`;

  const t0 = Date.now();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${await getBokbasenToken(credentials)}` } });
  if (res.status === 401) {
    clearBokbasenToken(credentials);
    res = await fetch(url, { headers: { Authorization: `Bearer ${await getBokbasenToken(credentials)}` } });
  }
  if (res.status === 413) return json({ error: "Bokbasen: svaret ble for stort (413). Prøv færre per bunke.", status: 413 }, 413);
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    return json({ error: `Bokbasen svarte ${res.status}${text ? ": " + text : ""}`, status: res.status }, 502);
  }
  const xmlRaw = await res.text();
  const fetchMs = Date.now() - t0;

  const t1 = Date.now();
  const xml = xmlRaw.replace(/\s+xmlns[^"]*"[^"]*"/g, "").replace(/<(\w+:)/g, "<").replace(/<\/(\w+:)/g, "</");
  const products = [...xml.matchAll(/<Product(?:\s[^>]*)?>[\s\S]*?<\/Product>/gi)].map((m) => m[0]);

  const books: BookMetadata[] = [];
  const deleted: string[] = [];
  const notificationTypes: Record<string, number> = {};
  let withoutIsbn = 0;
  let skipped = 0; // format som tolkeren ikke tar med (ikke bok), eller uten tittel
  let failed = 0;
  for (const product of products) {
    const type = product.match(/<NotificationType[^>]*>\s*(\d+)\s*</i)?.[1] ?? "?";
    notificationTypes[type] = (notificationTypes[type] ?? 0) + 1;
    const isbn = productIsbn(product);
    if (!isbn) { withoutIsbn++; continue; }
    if (type === "05") { deleted.push(isbn); continue; }
    try {
      const book = parseOnix(product, isbn);
      if (!book) { skipped++; continue; }
      const y = year37(product);
      if (y) book.year = y;
      books.push(book);
    } catch {
      failed++;
    }
  }
  const parseMs = Date.now() - t1;

  const cursor = nextCursor(res.headers);
  // Ferdig når Bokbasen ikke gir nytt bokmerke, eller bunken er tom (da er vi à jour).
  // Bokmerket fra en tom bunke beholdes: det er det neste «siden sist» skal bruke.
  const done = !cursor || products.length === 0;

  return json({
    books,
    deleted,
    next: cursor ?? next,
    done,
    stats: {
      products: products.length,
      books: books.length,
      deleted: deleted.length,
      skipped,
      withoutIsbn,
      failed,
      notificationTypes,
      kB: Math.round(xmlRaw.length / 1024),
      fetchMs,
      parseMs,
      pagesize,
      hasNextHeader: !!res.headers.get("next"),
      hasLinkHeader: !!res.headers.get("link"),
      onixRelease: xmlRaw.match(/<ONIXMessage[^>]*release="([^"]+)"/i)?.[1] ?? null,
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const path = new URL(req.url).pathname.replace(/^\/bokbasen-ny\/?/, "");
    if (path === "hent" && req.method === "POST") return await handleHent(req);
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
