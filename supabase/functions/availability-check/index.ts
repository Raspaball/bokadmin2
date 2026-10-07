// supabase/functions/availability-check/index.ts
// Deploy: supabase functions deploy availability-check --no-verify-jwt

import { resumableJobFilter } from "../_shared/job-resume.ts";
import { currentShopDomain, stopIfShopChanged } from "../_shared/job-shop.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { ALL_PRODUCT_STATUSES, shopifyGraphQL } from "../_shared/shopify.ts";
import { getCaller, scheduledUserId } from "../_shared/auth.ts";
import { BOKBASEN_ONIX_URL, getBokbasenToken } from "../_shared/bokbasen-auth.ts";
import { BOK_ISBN_FIELD, extractIsbn } from "../_shared/isbn.js";
import { extractAvailabilityCode, extractReplacedBy, resolvePublication } from "../_shared/onix.js";
import { isFatalJobError, protectedProduct, protectedProductMessage } from "../_shared/protected.ts";
import { ensureProtectedMembers } from "../_shared/protected-load.ts";
import { extractProductForm } from "../_shared/onix.js";
import { bookFormat, isBookForm, notBookMessage, notBookSkip, NOT_IN_BOKBASEN_MESSAGE } from "../_shared/book-format.ts";
import { bokgruppeFromTags } from "../_shared/bokgruppe.ts";
import {
  applyRedirectOps, chooseRedirectTarget, findActiveReplacement, handlePath, loadCollectionHandles, loadHandleRedirects, loadRedirectsFor,
  planRedirect, planRemoveRedirect, wantsRedirect, type RedirectOp, type RedirectRow,
} from "../_shared/redirects.ts";
import { channelsToPublish, getAllPublicationIds, PUBLISH_BULK_MUTATION, publishBulkLine, publishSummary } from "../_shared/publish.ts";
import {
  changedRow, errorRow, NO_ISBN_MESSAGE, skipRow, unchangedRow, type JobLogRow, type LogBase,
} from "../_shared/job-log.ts";
import { ensureDuplicates } from "../_shared/duplicate-scan.ts";
import { duplicateMessage } from "../_shared/duplicates.ts";
import { emptyBulkJobState, runBulkJob, summarizeBulkStats, type BulkJobContext, type BulkJobSpec, type BulkRef } from "../_shared/bulk-job.ts";
import {
  AVAILABILITY_BULK_PRODUCT_MUTATION, AVAILABILITY_BULK_QUERY, AVAILABILITY_BULK_VARIANT_MUTATION, AVAILABILITY_SLIM_FIELDS,
  availabilityBulkLines,
} from "../_shared/availability-bulk.ts";
import {
  ARCHIVED_MESSAGE, availabilityDescription, availabilityLogMessage, availabilityMetafields, availabilityRule, availabilitySkip,
  EGEN_TILGJENGELIGHET_FIELD, planAvailability,
  type AvailabilityChanges, type AvailabilityPlan, type AvailabilityRule, type StatusChangeRow,
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
  title: string;
  status: string;
  handle: string;
  tags: string[];
  vendor?: string | null;
  totalInventory?: number | null;
  bokIsbn?: { value: string } | null;
  tilgjengelighet?: { value: string } | null;
  utgivelsesdato?: { value: string } | null;
  egenTilgjengelighet?: { value: string } | null;
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
            title
            status
            handle
            tags
            vendor
            totalInventory
            ${BOK_ISBN_FIELD}
            tilgjengelighet: metafield(namespace: "bok", key: "tilgjengelighet") { value }
            utgivelsesdato: metafield(namespace: "bok", key: "utgivelsesdato") { value }
            ${EGEN_TILGJENGELIGHET_FIELD}
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
  /** ProductForm (List 150): bare bøker behandles (B*, A*, E*) */
  form: string | null;
  code: string | null;
  /** Utgivelsesdato som YYYY-MM-DD, eller null */
  date: string | null;
  /** Usikker dato i ONIX (rolle 11 to år eller mer fra rolle 01): en bok.utgivelsesdato som står, slettes */
  dateCheck: boolean;
}

/** Tilgjengelighetskode og utgivelsesdato fra Bokbasen, eller null når oppslaget feiler. */
async function fetchBokbasenAvailability(isbn: string, userId: string | null): Promise<OnixAvailability | null> {
  const token = await getBokbasenToken(userId);
  const res = await fetch(`${BOKBASEN_ONIX_URL}/${isbn}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const xml = await res.text();
  const pub = resolvePublication(xml);
  return { form: extractProductForm(xml).form, code: extractAvailabilityCode(xml), date: pub.date, dateCheck: pub.check };
}

const METAFIELDS_DELETE = `
  mutation availabilityDeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { deletedMetafields { key namespace ownerId } userErrors { field message } }
  }
`;

/** Sletter bok.utgivelsesdato på produktene (usikker dato i ONIX). Kaster med Shopifys melding ved feil. */
async function deleteUtgivelsesdato(ownerIds: string[]): Promise<void> {
  for (let i = 0; i < ownerIds.length; i += 25) {
    const { data } = await shopifyGraphQL<{ metafieldsDelete: { userErrors: Array<{ message: string }> } }>(METAFIELDS_DELETE, {
      metafields: ownerIds.slice(i, i + 25).map((ownerId) => ({ ownerId, namespace: "bok", key: "utgivelsesdato" })),
    });
    const e = (data.metafieldsDelete?.userErrors ?? []).map((x) => x.message).join(", ");
    if (e) throw new Error(`slette utgivelsesdato: ${e}`);
  }
}

// Hva som skal endres (også egen tilgjengelighet): planAvailability() i
// _shared/availability.ts, felles med push.

/** Gjør endringene i Shopify. Kaster med Shopifys feilmelding hvis noe feiler. */
async function applyAvailabilityChanges(
  product: ShopifyProduct,
  rule: AvailabilityRule,
  date: string | null,
  c: AvailabilityChanges,
): Promise<void> {
  // Bare feltene i c skrives: med egen tilgjengelighet er det bare utgivelsesdatoen
  const errs = (list: Array<{ message: string }> | undefined) => (list ?? []).map((e) => e.message).join(", ");

  if (c.continuePolicy || c.untrack) {
    const variantId = product.variants.edges[0].node.id;
    const { data } = await shopifyGraphQL<{ productVariantsBulkUpdate: { userErrors: Array<{ message: string }> } }>(
      `mutation variantPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id inventoryPolicy }
          userErrors { field message }
        }
      }`,
      {
        productId: product.id,
        variants: [{
          id: variantId,
          ...(c.continuePolicy ? { inventoryPolicy: "CONTINUE" } : {}),
          ...(c.untrack ? { inventoryItem: { tracked: false } } : {}),
        }],
      },
    );
    const e = errs(data.productVariantsBulkUpdate?.userErrors);
    if (e) throw new Error(`inventoryPolicy/sporing: ${e}`);
  }

  if (c.deleteDate) await deleteUtgivelsesdato([product.id]);

  if (c.tilgjengelighet || c.utgivelsesdato) {
    const { data } = await shopifyGraphQL<{ metafieldsSet: { userErrors: Array<{ message: string }> } }>(
      `mutation availabilityMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key value }
          userErrors { field message }
        }
      }`,
      { metafields: availabilityMetafields(product.id, rule, c.utgivelsesdato ? date : null, !!c.tilgjengelighet) },
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
  if (await stopIfShopChanged(supabase, job)) return;
  // Bulk-modus (pakke E del 5): hele katalogen med Shopify Bulk Operations og onix_cache
  if (job.config?.bulk) return runBulkJob(supabase, jobId, AVAILABILITY_BULK_SPEC, loadAvailabilityCounts);

  await supabase.from("jobs").update({
    status: "running",
    started_at: job.started_at || new Date().toISOString(),
  }).eq("id", jobId);

  // Produktene i de beskyttede samlingene (wrendale), hentet på nytt hver puls. Mangler samlingen: jobben stopper
  try {
    await ensureProtectedMembers(0);
  } catch (err) {
    await supabase.from("jobs").update({ status: "failed", error_message: String(err), completed_at: new Date().toISOString() }).eq("id", jobId);
    return;
  }

  // ISBN med flere produkter (pakke D del 3b): skannes én gang per jobb, så hoppes de over
  const duplicates = await ensureDuplicates(supabase, job, startTime + 30_000);
  if (!duplicates) return; // skanningen fortsetter i neste puls

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
  const duplicateAtStart: number = job.config?.skipped_duplicate || 0;
  let skippedDuplicate = duplicateAtStart;
  // Egen tilgjengelighet: regelen ville endret status/tilgjengelighet/lager, men det står
  const ownAtStart: number = job.config?.skipped_own || 0;
  let skippedOwn = ownAtStart;
  const archivedAtStart: number = job.config?.skipped_archived || 0;
  let skippedArchived = archivedAtStart;
  // Statusrapporten (pakke E del 4): alle som ville fått (eller fikk) ny status
  const statusChangesAtStart: StatusChangeRow[] = job.config?.status_changes || [];
  const statusChanges: StatusChangeRow[] = [...statusChangesAtStart];

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
          config: { ...job.config, shopify_cursor: cursor, page_start_index: i, skipped_protected: skippedProtected, skipped_duplicate: skippedDuplicate, skipped_own: skippedOwn, skipped_archived: skippedArchived, status_changes: statusChanges },
        }).eq("id", jobId);
        return;
      }

      const isbn = extractIsbn(product);

      await supabase.from("jobs").update({
        current_isbn: isbn || product.handle,
        processed,
      }).eq("id", jobId);

      // Én loggrad per produkt (pakke F del 3.1)
      const base: LogBase = { isbn, title: product.handle, action: mode === "update" ? "availability_update" : "availability_check", shopify_id: product.id, job_id: jobId, user_id: userId };
      const log = (row: JobLogRow) => supabase.from("sync_log").insert(row);

      // Beskyttet (tagg, leverandør Wrendale eller samling wrendale): status og metafelt røres aldri
      if (protectedProduct(product)) {
        await log(skipRow(base, "beskyttet", protectedProductMessage(product)));
        skippedProtected++;
        processed++;
        continue;
      }

      // Arkivert (ARCHIVED): endres aldri av tilgjengelighetsjobben, ingen ONIX-oppslag
      if (availabilitySkip(product) === "arkivert") {
        await log(skipRow(base, "arkivert", ARCHIVED_MESSAGE));
        skippedArchived++;
        processed++;
        continue;
      }

      if (!isbn) {
        await log(skipRow(base, "ingen_isbn", NO_ISBN_MESSAGE));
        skipped++;
        processed++;
        continue;
      }

      if (duplicates[isbn]) {
        await log(skipRow(base, "duplikat", duplicateMessage(duplicates[isbn])));
        skippedDuplicate++;
        processed++;
        continue;
      }

      try {
        const bokbasenAvailability = await fetchBokbasenAvailability(isbn, userId);

        if (bokbasenAvailability === null) {
          failed++;
          await log(skipRow(base, "ikke_i_bokbasen", `${NOT_IN_BOKBASEN_MESSAGE} (kunne ikke hente tilgjengelighet)`));
          processed++;
          continue;
        }
        // Bare bøker (pakke F del 2.2)
        if (!isBookForm(bokbasenAvailability.form)) {
          await log(skipRow(base, "ikke_bok", notBookMessage(bokbasenAvailability.form)));
          skipped++;
          processed++;
          continue;
        }

        const rule = availabilityRule(bokbasenAvailability.code);
        const date = bokbasenAvailability.date;
        // Egen tilgjengelighet (bok.egen_tilgjengelighet): status, bok.tilgjengelighet
        // og inventoryPolicy står; bare utgivelsesdatoen kan endres. På lager: aldri
        // utkast/arkivert, inventoryPolicy står
        const plan = planAvailability({ ...product, variant: product.variants?.edges?.[0]?.node }, rule, date, bokbasenAvailability.dateCheck);
        const changes = plan.changes;
        if (Object.keys(plan.heldBack).length || Object.keys(plan.stockKept).length) skippedOwn++;
        const statusChange = plan.changes.status ?? plan.heldBack.status;
        if (statusChange) {
          statusChanges.push({
            id: product.id, handle: product.handle, title: product.title, isbn, code: rule.code,
            from: statusChange.from, to: statusChange.to, tilgjengelighet: rule.tilgjengelighet, own: plan.ownAvailability,
          });
        }

        if (Object.keys(changes).length === 0 || mode === "analyze") {
          await log(availabilityPlanRow(base, plan, rule, date, false));
          if (Object.keys(changes).length) succeeded++;
          else skipped++;
        } else {
          let error: string | null = null;
          try {
            await applyAvailabilityChanges(product, rule, date, changes);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          const what = availabilityLogMessage(plan, rule, date, "Endret")!;
          await log(error ? errorRow(base, `Endring feilet: ${what.replace(/^Endret: /, "")}. ${error}`) : availabilityPlanRow(base, plan, rule, date, true));
          if (error) failed++;
          else succeeded++;
        }
      } catch (err) {
        failed++;
        console.error(`Error processing ${isbn}:`, err);
        await log(errorRow(base, err instanceof Error ? err.message : String(err)));
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
        skipped_duplicate: skippedDuplicate,
        skipped_own: skippedOwn,
        skipped_archived: skippedArchived,
        status_changes: statusChanges,
      },
      ...(isComplete ? {
        completed_at: new Date().toISOString(),
        total_items: processed,
        result: { total: processed, processed, succeeded, failed, skipped, skippedProtected, skippedDuplicate, skippedOwnAvailability: skippedOwn, skippedArchived,
          statusChanges, shopDomain: Deno.env.get("SHOPIFY_SHOP_DOMAIN") ?? null,
        },
      } : {}),
    }).eq("id", jobId);

  } catch (err) {
    console.error("Batch processing error:", err);
    const errMsg = String(err);
    // Fatal auth/config errors (og manglende beskyttet samling) → fail permanently to avoid infinite retry loop.
    // Transient errors (network, throttle) → stay paused so pg_cron retries.
    const isFatal = isFatalJobError(errMsg);
    await supabase.from("jobs").update({
      status: isFatal ? "failed" : "paused",
      error_message: errMsg,
      processed,
      succeeded,
      failed,
      skipped,
      config: { ...job.config, shopify_cursor: cursor, page_start_index: pageStartIndex, skipped_protected: protectedAtStart, skipped_duplicate: duplicateAtStart, skipped_own: ownAtStart, skipped_archived: archivedAtStart, status_changes: statusChangesAtStart },
    }).eq("id", jobId);
  }
}

// ── Bulk-modus (pakke E del 5) ──────────────────────────────────────────────
// Samme regel (availabilityRule + planAvailability), men katalogen leses med
// bulkOperationRunQuery, ONIX kommer fra onix_cache (hentes i forkant, høyst
// 2 timer gammel), og endringene sendes som JSONL: først
// productVariantsBulkUpdate (CONTINUE), så productUpdate (status + metafelt).
// Driveren er runBulkJob() i _shared/bulk-job.ts. Beskyttede, arkiverte og
// duplikater hoppes over; egen tilgjengelighet som i side-for-side-modus.

interface AvailabilityCounts {
  changed: number; unchanged: number; errors: number;
  skippedNoIsbn: number; skippedNoOnix: number; skippedProtected: number; skippedDuplicate: number;
  skippedOwnAvailability: number; skippedArchived: number; skippedNotBook: number; keptInStock: number; untracked: number;
  /** Bøker som blir aktive og publiseres på kanaler de mangler (pakke H del 2), og antall kanaler til sammen */
  publishProducts: number; publishChannels: number;
  /** Videresending for arkiverte bøker (pakke H del 3b): per måltype, uten mål, og fjernet fordi boka er aktiv igjen */
  redirectReplacement: number; redirectCollection: number; redirectNone: number; redirectRemoved: number;
  /** Bøker som blir ARCHIVED på kode 41, 47 og 48 (pakke H: tidligere DRAFT) */
  archive41: number; archive47: number; archive48: number;
}

function loadAvailabilityCounts(raw: unknown): AvailabilityCounts {
  const r = (raw ?? {}) as Partial<AvailabilityCounts>;
  const n = (k: keyof AvailabilityCounts) => Number(r[k]) || 0;
  return {
    changed: n("changed"), unchanged: n("unchanged"), errors: n("errors"), skippedNoIsbn: n("skippedNoIsbn"),
    skippedNoOnix: n("skippedNoOnix"), skippedProtected: n("skippedProtected"), skippedDuplicate: n("skippedDuplicate"),
    skippedOwnAvailability: n("skippedOwnAvailability"), skippedArchived: n("skippedArchived"),
    skippedNotBook: n("skippedNotBook"), keptInStock: n("keptInStock"), untracked: n("untracked"),
    publishProducts: n("publishProducts"), publishChannels: n("publishChannels"),
    redirectReplacement: n("redirectReplacement"), redirectCollection: n("redirectCollection"), redirectNone: n("redirectNone"), redirectRemoved: n("redirectRemoved"),
    archive41: n("archive41"), archive47: n("archive47"), archive48: n("archive48"),
  };
}

/** «12 ville endret, 420 uendret, hoppet over 10 (6 beskyttet, 1 arkivert, …), 1 egen tilgjengelighet, 2 status beholdt (på lager), 0 feil» */
function summarizeAvailability(c: AvailabilityCounts, mode: "analyze" | "update"): string {
  const skipped = c.skippedProtected + c.skippedArchived + c.skippedDuplicate + c.skippedNoIsbn + c.skippedNoOnix + c.skippedNotBook;
  return `${c.changed} ${mode === "update" ? "endret" : "ville endret"}, ${c.unchanged} uendret, hoppet over ${skipped} ` +
    `(${c.skippedProtected} beskyttet, ${c.skippedArchived} arkivert, ${c.skippedDuplicate} DUPLIKAT, ${c.skippedNoIsbn} uten ISBN, ` +
    `${c.skippedNoOnix} fant ikke boka i Bokbasen, ${c.skippedNotBook} ikke bok), ${c.skippedOwnAvailability} egen tilgjengelighet, ` +
    `${c.keptInStock} status beholdt (på lager), ${c.untracked} med sporing av beholdning slått av, ${c.publishProducts ? `${publishSummary(c.publishProducts, c.publishChannels, mode === "update")}, ` : ""}${c.archive41 + c.archive47 + c.archive48 ? `${mode === "update" ? "arkivert" : "ville blitt arkivert"} på kode 41/47/48: ${c.archive41}/${c.archive47}/${c.archive48}, ` : ""}${redirectSummary(c, mode === "update")}${c.errors} feil`;
}

/** «videresending: 3 til ny utgave, 10 til samling, 2 uten mål, 1 fjernet, » (tom når ingen) */
function redirectSummary(c: AvailabilityCounts, update: boolean): string {
  if (!(c.redirectReplacement + c.redirectCollection + c.redirectNone + c.redirectRemoved)) return "";
  return `videresending${update ? "" : " (ville bli)"}: ${c.redirectReplacement} til ny utgave, ${c.redirectCollection} til samling, ${c.redirectNone} uten mål, ${c.redirectRemoved} fjernet (aktiv igjen), `;
}

/** Feltnavnene i loggen (sync_log.fields) */
function availabilityFields(c: AvailabilityChanges): string[] {
  return [
    ...(c.status ? ["status"] : []), ...(c.tilgjengelighet ? ["bok.tilgjengelighet"] : []),
    ...(c.utgivelsesdato || c.deleteDate ? ["bok.utgivelsesdato"] : []), ...(c.continuePolicy ? ["inventoryPolicy"] : []), ...(c.untrack ? ["sporing"] : []),
  ];
}

/**
 * Loggraden for et produkt med plan (felles for side-for-side og bulk). Ingen endring:
 * hoppet over (egen tilgjengelighet / på lager) når regelen ble holdt tilbake, ellers uendret.
 */
function availabilityPlanRow(base: LogBase, plan: AvailabilityPlan, rule: AvailabilityRule, date: string | null, update: boolean): JobLogRow {
  const message = availabilityLogMessage(plan, rule, date, update ? "Endret" : "Ville endret");
  if (Object.keys(plan.changes).length) return changedRow(base, message!, availabilityFields(plan.changes));
  if (Object.keys(plan.heldBack).length) return skipRow(base, "egen_tilgjengelighet", message!);
  if (Object.keys(plan.stockKept).length) return skipRow(base, "paa_lager", message!);
  return unchangedRow(base, `Uendret: ${availabilityDescription(rule, date)}`);
}

type ShopifyProductLike = { id: string; handle: string; status?: string | null; tags?: unknown; vendor?: string | null; bokgruppe?: { value?: string } | null };

/**
 * Videresending for én bok (pakke H del 3b), eller null når boka ikke skal røres. I oppdateringsmodus
 * gjøres endringene direkte (få, ikke bulk); i sjekkmodus bare leses det. Teller bare det som trenger en endring.
 * Aktive bøker som har en videresending fra handlen får den slettet (og ISBN-adressen peker tilbake til boka).
 */
async function redirectForBook(
  ctx: BulkJobContext<AvailabilityCounts>, p: ShopifyProductLike, isbn: string | null, code: string | null,
  statusAfter: string, xml: string | null, update: boolean, examples: string[],
): Promise<string | null> {
  const c = ctx.counts;
  if (protectedProduct(p)) return null;
  if (statusAfter === "ACTIVE") {
    const known = (ctx.state.extra.handleRedirects ?? {}) as Record<string, RedirectRow>;
    if (!known[handlePath(p.handle)]) return null;
    const ops = planRemoveRedirect(p.handle, isbn, await loadRedirectsFor(p.handle, isbn));
    if (!ops.length) return null;
    c.redirectRemoved++;
    if (update) await applyRedirectOps(ops);
    return `${update ? "videresending fjernet" : "videresendingen ville blitt fjernet"} fra ${handlePath(p.handle)} (boka er aktiv igjen)`;
  }
  if (!wantsRedirect(p, code, statusAfter)) return null;
  const replacement = code === "41" && xml ? await findActiveReplacement(extractReplacedBy(xml)) : null;
  const t = chooseRedirectTarget(code, replacement, p.bokgruppe?.value || bokgruppeFromTags(p.tags), new Set<string>(ctx.state.extra.collectionHandles ?? []));
  if (!t.target) { c.redirectNone++; return `ingen videresending (${t.note})`; }
  const ops: RedirectOp[] = planRedirect(p.handle, isbn, t.target, await loadRedirectsFor(p.handle, isbn));
  const line = `${handlePath(p.handle)} → ${t.target}`;
  if (!ops.length) return `videresending finnes: ${line}`;
  if (t.kind === "erstatning") c.redirectReplacement++; else c.redirectCollection++;
  if (examples.length < 10) examples.push(`${line} (${t.kind === "erstatning" ? "ny utgave" : "samling"})`);
  if (update) await applyRedirectOps(ops);
  return `${update ? "videresending" : "ville videresendt"} ${line}`;
}

const AVAILABILITY_BULK_SPEC: BulkJobSpec<AvailabilityCounts> = {
  name: "availability-check (bulk)",
  query: AVAILABILITY_BULK_QUERY,
  slimFields: AVAILABILITY_SLIM_FIELDS,
  // Tilgjengelighet endrer seg i løpet av dagen (Testbutikk 02.10.2026: ONIX fra natten
  // ville rullet tilbake 4 endringer fra Bokbasen samme dag). Cachen brukes bare når den
  // er under 2 timer gammel, f.eks. rett etter bokdata-jobben ved overgangen.
  onixMaxAgeDays: 2 / 24,

  async onixIsbns(products, ctx) {
    // Til videresendingene (pakke H del 3b): samlingene som finnes, og videresendingene fra handle-adresser
    // (til å finne bøker som er aktive igjen). ISBN-adressene (8 000+) slås opp per bok.
    ctx.state.extra.collectionHandles = await loadCollectionHandles();
    ctx.state.extra.handleRedirects = await loadHandleRedirects();
    return products
      .filter((p) => !protectedProduct(p) && !availabilitySkip(p as { status?: string }))
      .map((p) => extractIsbn(p))
      .filter((i): i is string => !!i);
  },

  async planChunk(products, ctx) {
    const c = ctx.counts;
    const statusChanges: StatusChangeRow[] = (ctx.state.extra.statusChanges ??= []);
    const eligible = products.filter((p) => !protectedProduct(p) && !availabilitySkip(p as { status?: string }));
    const xmlByIsbn = await ctx.loadXml(eligible.map((p) => extractIsbn(p)).filter((i): i is string => !!i && !ctx.state.duplicates?.[i]));
    const logs: Record<string, unknown>[] = [];
    const variantLines: unknown[] = [], variantRefs: BulkRef[] = [];
    const productLines: unknown[] = [], productRefs: BulkRef[] = [];
    const publishLines: unknown[] = [], publishRefs: BulkRef[] = [];
    const dateDeletes: BulkRef[] = [];
    const update = ctx.mode === "update";
    // Videresending for arkiverte bøker (pakke H del 3b): legger teksten på loggraden. Feil blir egen feilrad, resten går videre.
    const redirectExamples: string[] = (ctx.state.extra.redirectExamples ??= []);
    const addRedirect = async (row: JobLogRow, base: LogBase, p: ShopifyProductLike, isbn: string | null, code: string | null, statusAfter: string, xml: string | null) => {
      try {
        const msg = await redirectForBook(ctx, p, isbn, code, statusAfter, xml, update, redirectExamples);
        if (msg) { row.message = `${row.message} + ${msg}`; row.fields = [...(row.fields ?? []), "videresending"]; }
      } catch (e) {
        c.errors++;
        logs.push(errorRow(base, `Feil ved videresending: ${String(e)}`));
      }
    };
    const allChannels = await getAllPublicationIds(); // kanalene appen publiserer på (_shared/publish.ts)

    // Én loggrad per produkt (pakke F del 3.1)
    for (const product of products) {
      // deno-lint-ignore no-explicit-any
      const p = product as any;
      const isbn = extractIsbn(product);
      const base = { isbn, title: product.handle, action: update ? "availability_update" : "availability_check", shopify_id: product.id, job_id: ctx.jobId, user_id: ctx.userId };
      if (protectedProduct(product)) {
        c.skippedProtected++;
        logs.push(skipRow(base, "beskyttet", protectedProductMessage(product)));
        continue;
      }
      if (availabilitySkip(p) === "arkivert") {
        c.skippedArchived++;
        const archivedRow = skipRow(base, "arkivert", ARCHIVED_MESSAGE);
        logs.push(archivedRow);
        // Arkivert av Bokadmin (bok.tilgjengelighet = utgatt: kode 43, 46 eller 49): videresending til samlingen
        await addRedirect(archivedRow, base, p, isbn, p.tilgjengelighet?.value === "utgatt" ? "43" : null, "ARCHIVED", null);
        continue;
      }
      if (!isbn) { c.skippedNoIsbn++; logs.push(skipRow(base, "ingen_isbn", NO_ISBN_MESSAGE)); continue; }
      const dup = ctx.state.duplicates?.[isbn];
      if (dup) {
        c.skippedDuplicate++;
        logs.push(skipRow(base, "duplikat", duplicateMessage(dup)));
        continue;
      }
      const xml = xmlByIsbn.get(isbn);
      if (!xml) {
        c.skippedNoOnix++;
        logs.push(skipRow(base, "ikke_i_bokbasen", NOT_IN_BOKBASEN_MESSAGE));
        continue;
      }
      const notBook = notBookSkip(xml);
      if (notBook) {
        c.skippedNotBook++;
        logs.push(skipRow(base, "ikke_bok", notBook));
        continue;
      }
      const rule = availabilityRule(extractAvailabilityCode(xml));
      const pub = resolvePublication(xml);
      const date = pub.date;
      const plan = planAvailability({ ...p, variant: p.variants?.nodes?.[0] }, rule, date, pub.check);
      const statusChange = plan.changes.status ?? plan.heldBack.status;
      if (statusChange) {
        statusChanges.push({
          id: product.id, handle: product.handle, title: p.title ?? product.handle, isbn, code: rule.code,
          from: statusChange.from, to: statusChange.to, tilgjengelighet: rule.tilgjengelighet, own: plan.ownAvailability,
        });
      }
      if (Object.keys(plan.heldBack).length) c.skippedOwnAvailability++;
      if (Object.keys(plan.stockKept).length) c.keptInStock++;
      if (plan.changes.untrack) c.untracked++;
      const row = availabilityPlanRow(base, plan, rule, date, update);
      logs.push(row);
      if (plan.changes.status?.to === "ARCHIVED" && ["41", "47", "48"].includes(rule.code)) c[`archive${rule.code}` as "archive41" | "archive47" | "archive48"]++;
      await addRedirect(row, base, p, isbn, rule.code, plan.changes.status?.to ?? p.status ?? "DRAFT", xml);
      // Blir boka aktiv, publiseres den på kanalene den mangler (bare bøker; lydbøker, e-bøker og beskyttede røres ikke)
      if (plan.changes.status?.to === "ACTIVE") {
        const form = extractProductForm(xml);
        const missing = channelsToPublish(allChannels, p, bookFormat(form.form, form.details).productType, true);
        if (missing.length) {
          c.publishProducts++;
          c.publishChannels += missing.length;
          row.message = `${row.message ?? ""} + ${publishSummary(1, missing.length, update)}`.trim();
          row.fields = [...(row.fields ?? []), "publisering"];
          if (update) { publishLines.push(publishBulkLine(product.id, missing)); publishRefs.push({ id: product.id, isbn, handle: product.handle }); }
        }
      }
      if (!Object.keys(plan.changes).length) { c.unchanged++; continue; }
      c.changed++;
      if (!update) continue;
      const lines = availabilityBulkLines(p, rule, date, plan);
      const ref = { id: product.id, isbn, handle: product.handle };
      if (plan.changes.deleteDate) dateDeletes.push({ id: product.id, isbn, handle: product.handle });
      if (lines.variant) { variantLines.push(lines.variant); variantRefs.push(ref); }
      if (lines.product) { productLines.push(lines.product); productRefs.push(ref); }
    }
    // Usikker utgivelsesdato (pakke H): metafeltet slettes direkte, ikke i bulk-filene (få produkter)
    if (dateDeletes.length) {
      try {
        await deleteUtgivelsesdato(dateDeletes.map((d) => d.id));
      } catch (e) {
        c.errors += dateDeletes.length;
        for (const d of dateDeletes) {
          logs.push(errorRow(
            { isbn: d.isbn, title: d.handle, action: "availability_update", shopify_id: d.id, job_id: ctx.jobId, user_id: ctx.userId },
            `Feil (utgivelsesdato slettes): ${e instanceof Error ? e.message : String(e)}`,
          ));
        }
      }
    }
    return {
      logs,
      ops: [
        // CONTINUE først: blir boka aktiv, er den da allerede kjøpbar
        { kind: "variant", mutation: AVAILABILITY_BULK_VARIANT_MUTATION, field: "productVariantsBulkUpdate", lines: variantLines, refs: variantRefs, filename: "availability-variants.jsonl" },
        { kind: "product", mutation: AVAILABILITY_BULK_PRODUCT_MUTATION, field: "productUpdate", lines: productLines, refs: productRefs, filename: "availability-products.jsonl" },
        // Publisering sist: boka er aktiv og kjøpbar når den kommer på kanalene
        { kind: "publish", mutation: PUBLISH_BULK_MUTATION, field: "publishablePublish", lines: publishLines, refs: publishRefs, filename: "availability-publish.jsonl" },
      ],
    };
  },

  onLineError(ctx, kind, ref, error) {
    // Én bok kan ha to linjer (variant og produkt): telles som én feil
    const failed: string[] = (ctx.state.extra.failedIds ??= []);
    if (!failed.includes(ref.id)) {
      failed.push(ref.id);
      ctx.counts.errors++;
      ctx.counts.changed = Math.max(0, ctx.counts.changed - 1);
    }
    return errorRow(
      { isbn: ref.isbn, title: ref.handle, action: "availability_update", shopify_id: ref.id, job_id: ctx.jobId, user_id: ctx.userId },
      `Feil i bulk (${kind === "variant" ? "salg uten lager / sporing" : kind === "publish" ? "publisering på kanaler" : "status/metafelt"}): ${error}`,
    );
  },

  totals(ctx: BulkJobContext<AvailabilityCounts>) {
    const c = ctx.counts;
    return { succeeded: c.changed, skipped: c.unchanged + c.skippedNoIsbn + c.skippedNoOnix + c.skippedNotBook, failed: c.errors };
  },

  result(ctx) {
    const c = ctx.counts;
    return {
      counts: c,
      skippedProtected: c.skippedProtected, skippedDuplicate: c.skippedDuplicate,
      skippedOwnAvailability: c.skippedOwnAvailability, skippedArchived: c.skippedArchived,
      skippedNotBook: c.skippedNotBook, keptInStock: c.keptInStock, untracked: c.untracked,
      publishProducts: c.publishProducts, publishChannels: c.publishChannels,
      redirectReplacement: c.redirectReplacement, redirectCollection: c.redirectCollection, redirectNone: c.redirectNone, redirectRemoved: c.redirectRemoved,
      redirectExamples: ctx.state.extra.redirectExamples ?? [],
      archive41: c.archive41, archive47: c.archive47, archive48: c.archive48,
      statusChanges: ctx.state.extra.statusChanges ?? [], shopDomain: Deno.env.get("SHOPIFY_SHOP_DOMAIN") ?? null,
      summary: `${summarizeAvailability(c, ctx.mode)}. ${summarizeBulkStats(ctx.state.stats)}`,
    };
  },
};

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
      const mode = body.mode === "update" ? "update" : "analyze";
      // Bulk er standard (pakke E del 5); bulk: false gir side-for-side-modus
      const bulk = body.bulk !== false;

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
          shop_domain: currentShopDomain(),
          started_at: new Date().toISOString(),
          total_items: totalProducts,
          config: { mode, shopify_cursor: null, ...(bulk ? { bulk: emptyBulkJobState(), counts: {} } : {}) },
        })
        .select()
        .single();

      if (error || !job) {
        return new Response(JSON.stringify({ error: "Kunne ikke opprette jobb" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const response = new Response(JSON.stringify({ jobId: job.id, status: "running", mode, bulk }), {
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
        .or(resumableJobFilter())
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
