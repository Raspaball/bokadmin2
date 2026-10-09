// supabase/functions/publish-books/index.ts
// Deploy: supabase functions deploy publish-books --no-verify-jwt --use-api --project-ref chwpqwblqummlufqdefe
//
// Publiseringsfasen (09.10.2026): publiserer aktive bøker i Online Store, og ingenting annet.
// En gitt liste (id + ISBN) behandles i omganger. For hver bok kontrolleres alle kravene på nytt
// rett før publisering (se _shared/publish-books.ts), med fersk ONIX fra Bokbasen (ikke cache).
//
//   POST /publish-books/run      { mode: "check" | "publish", expectedShop, runId, items: [{ id, isbn }] }
//   POST /publish-books/rollback { mode: "check" | "publish", expectedShop, runId, items: [{ id }] }
//        «publish» i rollback = avpubliser fra Online Store; «check» = bare tell.
//
// Sikring: (1) aktiv butikk må være lik expectedShop, (2) publish/rollback i «publish»-modus krever
// headeren x-publish-token = hemmeligheten PUBLISH_BOOKS_TOKEN, (3) Shopify-kallene har en smal liste:
// bare publishablePublish / publishableUnpublish slipper gjennom, selv om skrivesperren er åpen,
// (4) skrivesperren og «åpen til» gjelder som ellers. En omgang er høyst 100 bøker.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { getShopDomain, shopifyGraphQL } from "../_shared/shopify.ts";
import { BOKBASEN_ONIX_URL, getBokbasenToken } from "../_shared/bokbasen-auth.ts";
import { ensureProtectedMembers } from "../_shared/protected-load.ts";
import { changedRow, errorRow, logRow, skipRow, unchangedRow, type JobLogRow, type LogBase } from "../_shared/job-log.ts";
import {
  decidePublish, decideUnpublish, DUPLICATE_LOOKUP_QUERY, ONLINE_STORE_NAME, PUBLICATIONS_NAMED_QUERY,
  PUBLISH_MUTATION, PUBLISH_ONLY_MUTATION, PUBLISH_PRODUCTS_QUERY, toPublishProduct, UNPUBLISH_MUTATION, UNPUBLISH_ONLY_MUTATION,
  type PublishDecision, type PublishProduct,
} from "../_shared/publish-books.ts";

const MAX_ITEMS = 100;
const DEADLINE_MS = 110_000;
const CONCURRENCY = 4;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-publish-token",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, key);
}

async function onlineStoreId(): Promise<string | null> {
  const r = await shopifyGraphQL(PUBLICATIONS_NAMED_QUERY, {});
  const nodes = (r.data?.publications?.nodes ?? []) as { id: string; name: string }[];
  return nodes.find((n) => n.name === ONLINE_STORE_NAME)?.id ?? null;
}

/** Fersk ONIX direkte fra Bokbasen (aldri cache). undefined = oppslaget feilet, null = finnes ikke. */
async function freshOnix(isbn: string): Promise<string | null | undefined> {
  try {
    const token = await getBokbasenToken(null);
    const res = await fetch(`${BOKBASEN_ONIX_URL}/${isbn}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

/** Antall produkter med samme ISBN (strekkode eller SKU). */
async function sameIsbnCount(isbn: string): Promise<number> {
  const r = await shopifyGraphQL(DUPLICATE_LOOKUP_QUERY, { q: `barcode:${isbn} OR sku:${isbn}` });
  return ((r.data?.products?.nodes ?? []) as unknown[]).length;
}

async function loadProducts(ids: string[]): Promise<Map<string, PublishProduct>> {
  const out = new Map<string, PublishProduct>();
  for (let i = 0; i < ids.length; i += 25) {
    const r = await shopifyGraphQL(PUBLISH_PRODUCTS_QUERY, { ids: ids.slice(i, i + 25) });
    for (const node of (r.data?.nodes ?? []) as unknown[]) {
      const p = toPublishProduct(node);
      if (p) out.set(p.id, p);
    }
  }
  return out;
}

async function sendMutation(mutation: string, only: string, id: string, publicationId: string): Promise<string | null> {
  const r = await shopifyGraphQL(mutation, { id, input: [{ publicationId }] }, { onlyMutations: [only] });
  const root = only === PUBLISH_ONLY_MUTATION ? r.data?.publishablePublish : r.data?.publishableUnpublish;
  const errs = (root?.userErrors ?? []) as { message: string }[];
  return errs.length ? errs.map((e) => e.message).join(", ") : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const path = new URL(req.url).pathname.replace(/^\/(functions\/v1\/)?publish-books\/?/, "");
  try {
    if (req.method !== "POST" || (path !== "run" && path !== "rollback")) return json({ error: "Ukjent endepunkt" }, 404);
    const body = await req.json().catch(() => ({}));
    const mode = body.mode === "publish" ? "publish" : "check";
    const rollback = path === "rollback";
    const runId = String(body.runId ?? "");
    const items = (Array.isArray(body.items) ? body.items : []) as { id?: string; isbn?: string }[];
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ error: "runId må være en UUID" }, 400);
    if (!items.length || items.length > MAX_ITEMS) return json({ error: `Send 1–${MAX_ITEMS} bøker per omgang` }, 400);
    if (items.some((x) => !/^gid:\/\/shopify\/Product\/\d+$/.test(String(x.id ?? "")))) return json({ error: "Ugyldig produkt-ID i lista" }, 400);
    if (!rollback && items.some((x) => !/^97[89]\d{10}$/.test(String(x.isbn ?? "")))) return json({ error: "Ugyldig ISBN i lista" }, 400);

    // Sikring 1: riktig butikk
    const shop = (await getShopDomain()).trim().toLowerCase();
    if (shop !== String(body.expectedShop ?? "").trim().toLowerCase()) {
      return json({ error: "Aktiv butikk er ikke den lista er laget for. Ingenting er gjort." }, 409);
    }
    // Sikring 2: hemmelig nøkkel for skriving
    if (mode === "publish") {
      const secret = Deno.env.get("PUBLISH_BOOKS_TOKEN") ?? "";
      if (!secret || req.headers.get("x-publish-token") !== secret) return json({ error: "Mangler gyldig x-publish-token." }, 403);
    }

    await ensureProtectedMembers(0); // stopper hvis samlingen wrendale mangler
    const storeId = await onlineStoreId();
    const products = await loadProducts(items.map((x) => x.id!));
    const supabase = getSupabase();
    const deadline = Date.now() + DEADLINE_MS;
    const action = rollback ? "unpublish_online_store" : "publish_online_store";

    const results: Array<{ id: string; outcome: string; message: string }> = [];
    const logs: JobLogRow[] = [];
    const counts = { publisert: 0, uendret: 0, hoppet_over: 0, feil: 0, ikke_behandlet: 0 };

    const handle = async (item: { id?: string; isbn?: string }) => {
      const product = products.get(item.id!) ?? null;
      const base: LogBase = { isbn: item.isbn ?? null, title: product?.title ?? null, action, shopify_id: item.id, job_id: runId, user_id: null };
      try {
        let decision: PublishDecision;
        if (rollback) {
          decision = decideUnpublish(product, storeId);
        } else {
          const [xml, dup] = product && product.status === "ACTIVE" ? await Promise.all([freshOnix(item.isbn!), sameIsbnCount(item.isbn!)]) : [null, 0];
          decision = decidePublish({ expectedIsbn: item.isbn!, product, sameIsbnCount: dup, onixXml: xml, onlineStoreId: storeId });
        }
        if (decision.action === "publish") {
          if (mode === "publish") {
            const err = rollback
              ? await sendMutation(UNPUBLISH_MUTATION, UNPUBLISH_ONLY_MUTATION, item.id!, storeId!)
              : await sendMutation(PUBLISH_MUTATION, PUBLISH_ONLY_MUTATION, item.id!, storeId!);
            if (err) { counts.feil++; logs.push(errorRow(base, `Feil: ${err}`)); results.push({ id: item.id!, outcome: "feil", message: err }); return; }
            counts.publisert++;
            logs.push(changedRow(base, rollback ? "Avpublisert fra Online Store" : "Publisert i Online Store", ["publisert"]));
            results.push({ id: item.id!, outcome: "publisert", message: decision.message });
          } else {
            counts.publisert++;
            logs.push(changedRow(base, `Ville ${rollback ? "avpublisert" : "publisert"}: ${decision.message}`, ["publisert"]));
            results.push({ id: item.id!, outcome: "ville_publisert", message: decision.message });
          }
        } else if (decision.action === "unchanged") {
          counts.uendret++; logs.push(unchangedRow(base, decision.message)); results.push({ id: item.id!, outcome: "uendret", message: decision.message });
        } else if (decision.action === "skip") {
          counts.hoppet_over++;
          logs.push(decision.reason ? skipRow(base, decision.reason, decision.message) : logRow(base, "hoppet_over", decision.message, { reason: null }));
          results.push({ id: item.id!, outcome: "hoppet_over", message: decision.message });
        } else {
          counts.feil++; logs.push(errorRow(base, decision.message)); results.push({ id: item.id!, outcome: "feil", message: decision.message });
        }
      } catch (e) {
        counts.feil++;
        const msg = String((e as Error)?.message ?? e).slice(0, 300);
        logs.push(errorRow(base, `Feil: ${msg}`)); results.push({ id: item.id!, outcome: "feil", message: msg });
      }
    };

    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        if (Date.now() > deadline) return;
        const i = next++;
        if (i >= items.length) return;
        await handle(items[i]);
      }
    }));
    counts.ikke_behandlet = Math.max(0, items.length - results.length);
    if (logs.length) await supabase.from("sync_log").insert(logs);

    const done = new Set(results.map((r) => r.id));
    return json({ mode, rollback, counts, results, notProcessed: items.map((x) => x.id).filter((id) => !done.has(id!)) });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return json({ error: msg.slice(0, 400) }, msg.startsWith("Shopify-sperre") ? 403 : 500);
  }
});
