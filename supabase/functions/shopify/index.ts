// supabase/functions/shopify/index.ts
// Deploy: supabase functions deploy shopify --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { ALL_PRODUCT_STATUSES, getShopDomain, shopifyGraphQL } from "../_shared/shopify.ts";
import { getCaller } from "../_shared/auth.ts";
import { BOKBASEN_ONIX_URL, type BokbasenCredentials, getBokbasenCredentials, getBokbasenToken } from "../_shared/bokbasen-auth.ts";
import { buildBookHandle, normalizeIsbn } from "../_shared/handle.js";
import { BOK_ISBN_FIELD, extractIsbn } from "../_shared/isbn.js";
import { extractAvailabilityCode, extractBokgruppekode, extractDescription, extractPublishingDate } from "../_shared/onix.js";
import {
  availabilityDescription, availabilityMetafields, availabilityRule, EGEN_TILGJENGELIGHET_FIELD, needsContinuePolicy,
  OWN_AVAILABILITY_MESSAGE, ownAvailability, type AvailabilityRule,
} from "../_shared/availability.ts";
import { chooseValidPrice } from "../_shared/price.ts";
import { csvPriceAndStatus, decidePushPrice, validPrice, type PushPriceDecision } from "../_shared/push-price.ts";
import { approvalMessage, checkPriceChange } from "../_shared/price-guard.ts";
import { getMaxPriceChangePct, recordPendingApproval } from "../_shared/price-approvals.ts";
import { EGEN_PRIS_FIELD, priceLock, priceLockMessage } from "../_shared/price-lock.ts";
import { bokgruppeTagsForKode } from "../_shared/bokgruppe.ts";
import { COLLECTION_CREATE_MUTATION, COLLECTION_UPDATE_MUTATION, collectionTitleFix, tagSources } from "../_shared/collections.ts";
import { COLLECTION_NAMES } from "../_shared/collection-names.ts";
import { bookDescription, bookFieldsFromOnix, bookMetafields, type BookFields } from "../_shared/book-standard.ts";
import { CATEGORY_IDS, CATEGORY_NAMES } from "../_shared/book-format.ts";
import { bookSeo, decideSeo, legacySeo, parseSeoAuto, seoMetafields } from "../_shared/book-seo.ts";
import { coverAlt, coverChanges, coverFilename, type CoverChange } from "../_shared/book-cover.ts";
import { cleanBookTags } from "../_shared/book-tags.ts";
import { protectedMessage, protectedTag } from "../_shared/protected.ts";
import { BULK_ACTIVE, startBulkMutation } from "../_shared/shopify-bulk.ts";
import { duplicateCounts, duplicateMessage } from "../_shared/duplicates.ts";
import { getOnixCached } from "../_shared/onix-cache.ts";
import {
  SAFE_STORES, MIGRATION_PRODUCTS_QUERY, HANDLE_UPDATE_MUTATION,
  planHandleMigration, isBlockedRow, handleUpdateInput, type HandlePlanRow,
} from "../_shared/handle-migration.js";

// Felt extractIsbn trenger (bok.isbn, strekkode, SKU) — handle er ikke lenger ISBN
const PRODUCT_ISBN_FIELDS = `${BOK_ISBN_FIELD} variants(first: 1) { nodes { barcode sku } }`;

// ── Bokbasen auth (for ISBN → bokgruppekode lookup during catalog sync) ───────
// Shopify-tilgangen er felles for hele serveren (se _shared/shopify.ts).
// Kun Bokbasen kan fortsatt settes per bruker i user_settings (se _shared/bokbasen-auth.ts).

interface PublicationsCacheEntry {
  ids: string[];
  expiry: number;
}

const publicationsCache = new Map<string, PublicationsCacheEntry>();

// Bokgruppekode for ett ISBN (skjema 37, se _shared/onix.js)
async function fetchBokgruppekode(isbn: string, credentials: BokbasenCredentials | null): Promise<string | null> {
  try {
    const token = await getBokbasenToken(credentials);
    const res = await fetch(`${BOKBASEN_ONIX_URL}/${isbn}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return extractBokgruppekode(await res.text());
  } catch {
    return null;
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Convert plain text (newline-separated paragraphs) to HTML for Shopify body_html
interface BookMetadata {
  isbn: string;
  title: string;
  author: string;
  authors?: string[] | null; // «Fornavn Etternavn» i rekkefølge (importen og books.authors)
  productType?: string | null; // Bok / Lydbok / E-bok fra importen (brukes i CSV)
  publisher: string;
  year: string;
  format: string;
  price: number | null;
  priceReason?: string | null; // årsak fra choosePrice når price mangler (fra bokbasen-oppslaget)
  description: string;
  imageUrl: string;
  image_url?: string;
  genre: string;
  bokgruppe: string;
  bokgruppekode?: string;
  vekt: number | null;
  // Tilgjengelighet (ONIX List 65): `availability` fra importen, `availability_code` fra books-raden
  availability?: string | null;
  availability_code?: string | null;
  // Utgivelsesdato YYYY-MM-DD fra importen (extractPublishingDate)
  publishingDate?: string | null;
}

// Bokgruppekode → samlingsnavn: COLLECTION_NAMES i _shared/collection-names.ts

// bkg-taggene for en bokgruppekode: bokgruppeTagsForKode() i _shared/bokgruppe.ts

// ── Product mutations ────────────────────────────────────────────────────────

// Felt pushOneBook trenger fra et eksisterende produkt
const PUSH_PRODUCT_FIELDS = `
  id title handle tags
  ${EGEN_PRIS_FIELD}
  ${EGEN_TILGJENGELIGHET_FIELD}
  variants(first: 1) { edges { node { id sku price compareAtPrice inventoryPolicy inventoryItem { tracked } } } }
  media(first: 1) { edges { node { id alt ... on MediaImage { image { url } } } } }
  seoTitleMf: metafield(namespace: "global", key: "title_tag") { value }
  seoDescMf: metafield(namespace: "global", key: "description_tag") { value }
  seoAuto: metafield(namespace: "bokadmin", key: "seo_auto") { value }
`;

const PRODUCT_BY_ID_QUERY = `
  query productById($id: ID!) {
    product(id: $id) { ${PUSH_PRODUCT_FIELDS} }
  }
`;

const PRODUCT_BY_ISBN_QUERY = `
  query productByIsbn($isbn: String!) {
    productByIdentifier(identifier: { customId: { namespace: "bok", key: "isbn", value: $isbn } }) { ${PUSH_PRODUCT_FIELDS} }
  }
`;

// Reserve for customId: søk på strekkode/SKU (settes av pushOneBook). Treffet
// kontrolleres med extractIsbn, siden søket ikke er et eksakt oppslag.
const PRODUCTS_BY_ISBN_SEARCH_QUERY = `
  query productsByIsbn($q: String!) {
    products(first: 5, query: $q) {
      nodes {
        id title handle tags
        ${BOK_ISBN_FIELD}
        ${EGEN_PRIS_FIELD}
        ${EGEN_TILGJENGELIGHET_FIELD}
        variants(first: 1) { edges { node { id sku price compareAtPrice barcode inventoryPolicy inventoryItem { tracked } } } }
        media(first: 1) { edges { node { id alt ... on MediaImage { image { url } } } } }
        seoTitleMf: metafield(namespace: "global", key: "title_tag") { value }
        seoDescMf: metafield(namespace: "global", key: "description_tag") { value }
        seoAuto: metafield(namespace: "bokadmin", key: "seo_auto") { value }
      }
    }
  }
`;

// Shopify godtar customId-oppslag bare når metafeltdefinisjonen har typen «id».
// Er bok.isbn definert med en annen type, huskes det og søket over brukes i stedet.
let customIdUnsupported = false;

const PRODUCT_BY_HANDLE_QUERY = `
  query productByIdentifier($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) { ${PUSH_PRODUCT_FIELDS} }
  }
`;

const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id title handle
        variants(first: 1) { edges { node { id sku price } } }
      }
      userErrors { field message }
    }
  }
`;

const PRODUCT_UPDATE_MUTATION = `
  mutation productUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id title handle
        variants(first: 1) { edges { node { id sku price } } }
      }
      userErrors { field message }
    }
  }
`;

const VARIANT_UPDATE_MUTATION = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price }
      userErrors { field message }
    }
  }
`;

const INVENTORY_ITEM_UPDATE = `
  mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id sku }
      userErrors { field message }
    }
  }
`;

// productCreateMedia er utfaset — bilder legges til via productUpdate(media:)
const PRODUCT_IMAGE_MUTATION = `
  mutation productAddMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]!) {
    productUpdate(product: $product, media: $media) {
      product { id media(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }
`;

// Endrer filnavn og/eller alt-tekst på et bilde (MediaImage er en fil) uten ny
// opplasting. Et nytt bilde er ofte ikke ferdig behandlet med en gang; da
// prøves det igjen noen ganger. Kaster med Shopifys melding hvis det ikke går.
const FILE_UPDATE_MUTATION = `
  mutation coverFileUpdate($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files { id alt fileStatus }
      userErrors { field message code }
    }
  }
`;

async function updateCoverFile(mediaId: string, change: CoverChange): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await shopifyGraphQL(FILE_UPDATE_MUTATION, { files: [{ id: mediaId, ...change }] });
    const errs = (r.data?.fileUpdate?.userErrors ?? []) as { message: string; code?: string }[];
    if (!errs.length) return;
    const notReady = errs.some((e) => /READY|PROCESSING|not ready|processing/i.test(`${e.code ?? ""} ${e.message}`));
    if (!notReady || attempt === 5) throw new Error(errs.map((e) => e.message).join(", "));
    await new Promise((res) => setTimeout(res, 1500));
  }
}

const PUBLICATIONS_QUERY = `
  query GetPublications {
    publications(first: 25) {
      edges { node { id } }
    }
  }
`;

const PUBLISHABLE_PUBLISH_MUTATION = `
  mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

// Sales channels ("publications") a product must be published to so it doesn't
// sit at "0 salgskanaler" after export. Cached per shop for the life of the
// function instance — the set of channels rarely changes.
async function getAllPublicationIds(): Promise<string[]> {
  const shopDomain = getShopDomain();
  const cached = publicationsCache.get(shopDomain);
  if (cached && Date.now() < cached.expiry) return cached.ids;

  const result = await shopifyGraphQL(PUBLICATIONS_QUERY, {});
  const ids = ((result.data?.publications?.edges as { node: { id: string } }[]) || []).map((e) => e.node.id);
  publicationsCache.set(shopDomain, { ids, expiry: Date.now() + 30 * 60 * 1000 });
  return ids;
}

async function publishToAllChannels(productId: string): Promise<void> {
  const publicationIds = await getAllPublicationIds();
  if (!publicationIds.length) return;
  await shopifyGraphQL(PUBLISHABLE_PUBLISH_MUTATION, {
    id: productId,
    input: publicationIds.map((publicationId) => ({ publicationId })),
  });
}

// ── Collection mutations ─────────────────────────────────────────────────────

const COLLECTION_BY_HANDLE_QUERY = `
  query collectionByIdentifier($handle: String!) {
    collectionByIdentifier(identifier: { handle: $handle }) {
      id title handle
    }
  }
`;

const ALL_PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "${ALL_PRODUCT_STATUSES}") {
      edges {
        cursor
        node { id handle tags ${PRODUCT_ISBN_FIELDS} }
      }
      pageInfo { hasNextPage }
    }
  }
`;

const CATALOG_PRODUCTS_QUERY = `
  query GetCatalogProducts($first: Int!, $after: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
    products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, query: "${ALL_PRODUCT_STATUSES}") {
      edges {
        cursor
        node {
          id handle title productType vendor status
          descriptionHtml tags createdAt
          featuredMedia { preview { image { url altText } } }
          variants(first: 1) {
            edges { node { id price compareAtPrice sku barcode inventoryPolicy } }
          }
          seoTitleMf: metafield(namespace: "global", key: "title_tag") { value }
          seoDescMf: metafield(namespace: "global", key: "description_tag") { value }
          collections(first: 10) { edges { node { title } } }
          ${BOK_ISBN_FIELD}
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ── Push one book ────────────────────────────────────────────────────────────

// Supabase REST med service-nøkkelen
function supabaseRest(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function getStoredShopifyId(isbn: string): Promise<string | null> {
  try {
    const res = await supabaseRest(`books?isbn=eq.${encodeURIComponent(isbn)}&shopify_id=not.is.null&select=shopify_id&limit=1`);
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.shopify_id ?? null;
  } catch {
    return null;
  }
}

async function saveShopifyIdToBooks(isbn: string, shopifyId: string, handle: string, variantId?: string): Promise<void> {
  try {
    await supabaseRest(`books?isbn=eq.${encodeURIComponent(isbn)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        shopify_id: shopifyId,
        shopify_handle: handle,
        shopify_variant_id: variantId ?? null,
        synced_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error(`[push ${isbn}] Kunne ikke lagre shopify_id i books: ${String(e)}`);
  }
}

// Handle bygges fra forfatterlisten. Teksten i `author` (gamle books-rader uten
// authors) brukes bare som reserve, via firstAuthor() i _shared/handle.js.
function newBookHandle(book: BookMetadata, isbn: string): string {
  const authors = book.authors?.length ? book.authors : book.author;
  return buildBookHandle({ title: book.title, authors, isbn }) ?? isbn;
}

// Oppslag på ISBN via customId på bok.isbn (krever at definisjonen har typen «id»).
// null hvis ingen treff, eller hvis Shopify avviser customId-oppslaget.
async function findProductByCustomId(isbn: string): Promise<Record<string, unknown> | null> {
  if (customIdUnsupported) return null;
  try {
    const r = await shopifyGraphQL(PRODUCT_BY_ISBN_QUERY, { isbn });
    return r.data?.productByIdentifier?.id ? r.data.productByIdentifier : null;
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("Shopify GraphQL errors")) throw e; // nettverk, HTTP 401/403 osv.
    // Feil type huskes; andre GraphQL-feil (f.eks. «Metafields have not completed
    // migrating» rett etter at definisjonen er laget på nytt) gjelder bare dette kallet.
    if (msg.includes("type 'id' is required")) customIdUnsupported = true;
    console.warn(`customId-oppslag på bok.isbn feilet, prøver strekkode/SKU: ${msg.slice(0, 200)}`);
    return null;
  }
}

// Reserve: søk på strekkode/SKU med eksakt ISBN-kontroll.
async function findProductByBarcodeOrSku(isbn: string): Promise<Record<string, unknown> | null> {
  const r = await shopifyGraphQL(PRODUCTS_BY_ISBN_SEARCH_QUERY, {
    q: `(barcode:${isbn} OR sku:${isbn}) AND (${ALL_PRODUCT_STATUSES})`,
  });
  const nodes: Record<string, unknown>[] = r.data?.products?.nodes ?? [];
  return nodes.find((n) => extractIsbn(n) === isbn) ?? null;
}

// Alle produkter med dette ISBN-et (strekkode/SKU, bok.isbn og handle = ISBN).
// Mer enn ett: duplikat (pakke D del 3b), og push stopper til de er ryddet.
async function productIdsWithIsbn(isbn: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const r = await shopifyGraphQL(PRODUCTS_BY_ISBN_SEARCH_QUERY, { q: `(barcode:${isbn} OR sku:${isbn}) AND (${ALL_PRODUCT_STATUSES})` });
  for (const n of (r.data?.products?.nodes ?? []) as Record<string, unknown>[]) if (extractIsbn(n) === isbn) ids.add(n.id as string);
  const byCustom = await findProductByCustomId(isbn);
  if (byCustom?.id) ids.add(byCustom.id as string);
  const byHandle = await shopifyGraphQL(PRODUCT_BY_HANDLE_QUERY, { handle: isbn });
  if (byHandle.data?.productByIdentifier?.id) ids.add(byHandle.data.productByIdentifier.id);
  return ids;
}

// Finner et eksisterende produkt for boka, i denne rekkefølgen:
//   a. shopify_id lagret i books
//   b. customId: metafeltet bok.isbn (typen «id»)
//   c. strekkode/SKU (produkter uten bok.isbn, eller hvis customId avvises)
//   d. handle = ISBN (eldre produkter)
//   e. handle = ny handle (migrerte produkter som ennå ikke har bok.isbn)
// Returnerer null hvis boka ikke finnes, og da opprettes et nytt produkt.
async function findExistingProduct(book: BookMetadata, isbn: string): Promise<Record<string, unknown> | null> {
  const storedId = await getStoredShopifyId(isbn);
  if (storedId) {
    try {
      const r = await shopifyGraphQL(PRODUCT_BY_ID_QUERY, { id: storedId });
      if (r.data?.product?.id) return r.data.product;
    } catch (_) { /* slettet eller ugyldig ID — prøv neste */ }
  }

  const byIsbn = await findProductByCustomId(isbn) ?? await findProductByBarcodeOrSku(isbn);
  if (byIsbn) return byIsbn;

  const lookups: Array<[string, Record<string, unknown>]> = [
    [PRODUCT_BY_HANDLE_QUERY, { handle: isbn }],
    [PRODUCT_BY_HANDLE_QUERY, { handle: newBookHandle(book, isbn) }],
  ];
  for (const [query, variables] of lookups) {
    const r = await shopifyGraphQL(query, variables);
    if (r.data?.productByIdentifier?.id) return r.data.productByIdentifier;
  }
  return null;
}

// Årsak til at en bok mangler pris, slått opp i Bokbasen med samme regel som
// importen (choosePrice). Brukes når push får en bok uten pris og uten årsak
// (f.eks. «Push alle» fra books). null hvis oppslaget feiler.
// Rå ONIX for én bok (ONIX-cachen, ellers Bokbasen), eller null når den ikke finnes.
// Push bruker samme cache som jobben «Oppdater eksisterende bøker» (_shared/onix-cache.ts).
async function fetchOnixXml(isbn: string, credentials: BokbasenCredentials | null): Promise<string | null> {
  return (await getOnixCached(isbn, credentials)).xml;
}

function missingPriceReasonFromOnix(xml: string | null): string | null {
  if (!xml) return null;
  const { price, reason } = chooseValidPrice(xml);
  return price !== null
    ? `Bokbasen har nå ${price} kr, men boka i arbeidslista mangler pris – importer den på nytt`
    : reason;
}

async function pushOneBook(
  book: BookMetadata,
  bokbasenCredentials: BokbasenCredentials | null = null,
  userId: string | null = null,
): Promise<{ shopifyId: string; handle: string; variantId?: string; created: boolean; warning?: string; priceNote?: string; approvalRequired?: boolean; availabilityNote?: string; status?: string; seoNote?: string; descriptionNote?: string; tagNote?: string; protectedNote?: string }> {
  // Tagger: bare bokgruppekode-hierarkiet (bkg-N, bkg-NN, bkg-NNN). Forfatter og
  // tittel er ikke lenger tagger (pakke B del 7, _shared/book-tags.ts).
  const bkgTags = book.bokgruppekode ? bokgruppeTagsForKode(book.bokgruppekode) : [];

  const isbn = normalizeIsbn(book.isbn);
  if (!isbn) throw new Error(`Ugyldig ISBN: ${book.isbn}`);

  // ONIX hentes én gang per push: bokfeltene (pakke B, _shared/book-standard.ts),
  // og prisårsak/tilgjengelighet når de mangler i boka vi fikk. null = Bokbasen svarte ikke.
  const onixXml = await fetchOnixXml(isbn, bokbasenCredentials);
  const getOnix = async () => onixXml;
  const fields: BookFields | null = onixXml ? bookFieldsFromOnix(onixXml) : null;
  // Gamle books-rader uten forfatterliste: listen fra ONIX (handle og bok.forfatter)
  if (!book.authors?.length && fields?.authors.length) book = { ...book, authors: fields.authors };

  // Duplikat (samme ISBN på flere produkter): ingenting skrives før de er ryddet
  const sameIsbn = await productIdsWithIsbn(isbn);
  if (sameIsbn.size > 1) throw new Error(`${duplicateMessage(sameIsbn.size)}. Rydd duplikatene først (scripts/duplicates.mjs)`);

  // Step 1: Finn eksisterende produkt (se findExistingProduct), ellers opprett.
  // Handle settes bare ved opprettelse — eksisterende produkter beholder sin.
  const existing = await findExistingProduct(book, isbn);
  // Beskyttet (tagg gave/lokal/lokalhistorie/lokallitteratur, _shared/protected.ts):
  // ingenting skrives, verken produkt, pris, metafelt, bilde eller publisering.
  if (existing && protectedTag(existing.tags as string[] | undefined)) {
    const protectedNote = protectedMessage(existing.tags as string[]);
    console.warn(`[push ${isbn}] ${protectedNote}`);
    return { shopifyId: existing.id as string, handle: existing.handle as string, created: false, protectedNote };
  }
  let product: Record<string, unknown> | null = existing;
  const isUpdate = !!existing;
  const alreadyHasImage = ((existing?.media as { edges: unknown[] } | undefined)?.edges?.length ?? 0) > 0;

  // Egen pris (bok.egen_pris) eller tilbud (compareAtPrice) på en eksisterende
  // bok: prisen sendes ikke. Alt annet oppdateres som før (se _shared/price-lock.ts).
  const existingVariantNode = (existing?.variants as { edges: { node: { compareAtPrice?: string | null } }[] } | undefined)?.edges?.[0]?.node;
  const lock = isUpdate ? priceLock(existing?.egenPris, existingVariantNode?.compareAtPrice) : null;

  // Pris: aldri 0. Mangler godkjent pris, opprettes en ny bok som utkast uten
  // pris, og en eksisterende bok beholder prisen sin (se _shared/push-price.ts).
  const missingReason = !lock && validPrice(book.price) === null
    ? book.priceReason ?? missingPriceReasonFromOnix(await getOnix())
    : null;
  const priceDecision: PushPriceDecision = lock
    ? { price: null, draft: false, note: priceLockMessage(lock) }
    : decidePushPrice(book.price, !isUpdate, missingReason);

  // Sperre mot store prishopp for eksisterende bøker (se _shared/price-guard.ts):
  // over grensen sendes ikke prisen, og endringen legges til godkjenning.
  let approvalRequired = false;
  if (isUpdate && existing && priceDecision.price !== null) {
    const existingVariant = (existing.variants as { edges: { node: { id: string; price: string } }[] })?.edges?.[0]?.node;
    const change = checkPriceChange(existingVariant?.price, Number(priceDecision.price), await getMaxPriceChangePct(userId));
    if (change.action === "approval" && existingVariant) {
      await recordPendingApproval({
        isbn,
        title: book.title,
        shopify_product_id: existing.id as string,
        shopify_variant_id: existingVariant.id,
        old_price: parseFloat(existingVariant.price),
        new_price: Number(priceDecision.price),
        change_pct: change.pct,
        source: "push",
        user_id: userId,
      });
      priceDecision.note = approvalMessage(existingVariant.price, Number(priceDecision.price), change.pct!);
      priceDecision.price = null;
      approvalRequired = true;
    }
  }

  // Tilgjengelighet (ONIX List 65) → status, bok.tilgjengelighet og kjøpbarhet
  // etter _shared/availability.ts. Mangler kode eller dato, hentes ONIX.
  let availCode = book.availability ?? book.availability_code ?? null;
  let pubDate = book.publishingDate ?? null;
  let availKnown = !!availCode;
  if (!availCode || !pubDate) {
    const xml = await getOnix();
    if (xml) {
      availCode = availCode || extractAvailabilityCode(xml);
      pubDate = pubDate || extractPublishingDate(xml);
      availKnown = true;
    }
  }
  // null = ukjent (Bokbasen svarte ikke og boka hadde ingen kode)
  const availRule: AvailabilityRule | null = availKnown ? availabilityRule(availCode) : null;
  // Egen tilgjengelighet (bok.egen_tilgjengelighet) på en eksisterende bok: status,
  // inventoryPolicy og bok.tilgjengelighet står. Alt annet oppdateres som før.
  const ownAvail = isUpdate && ownAvailability(existing?.egenTilgjengelighet);
  const availabilityNote = ownAvail
    ? `${OWN_AVAILABILITY_MESSAGE}${availRule ? ` (regelen: ${availabilityDescription(availRule, pubDate)})` : ""}`
    : availRule
    ? availabilityDescription(availRule, pubDate)
    : (isUpdate ? "Tilgjengelighet ukjent (Bokbasen svarte ikke): status ikke endret" : "Tilgjengelighet ukjent (Bokbasen svarte ikke): opprettet som utkast");

  // Status: ny bok uten godkjent pris → alltid utkast (pakke A2). Ellers etter
  // regelen. Ukjent tilgjengelighet eller egen tilgjengelighet: eksisterende bok
  // beholder statusen, ny blir utkast.
  const status = priceDecision.draft ? "DRAFT" : ownAvail ? null : availRule ? availRule.status : (isUpdate ? null : "DRAFT");

  // Beskrivelse: forlagsteksten med avsnitt (<p>), ellers reservebeskrivelse fra
  // feltene (_shared/book-standard.ts). Forlagsteksten fra ONIX går foran boka vi fikk.
  const descText = (onixXml ? extractDescription(onixXml) : "") || book.description || "";
  const desc = bookDescription(descText, book.title, {
    authors: book.authors?.length ? book.authors : fields?.authors ?? [],
    format: fields?.format ?? null,
    pages: fields?.pages ?? null,
    year: fields?.year ?? (parseInt(book.year, 10) || null),
  }, book.publisher);
  const descriptionNote = desc.fallback ? "Mangler forlagstekst: reservebeskrivelse brukt" : undefined;

  // Tagger: eksisterende produkt beholder alle tagger unntatt forfatter/tittel,
  // og får bkg-*. Nytt produkt får bare bkg-*.
  const tagResult = cleanBookTags(
    isUpdate ? ((existing?.tags as string[] | undefined) ?? []) : [],
    { title: book.title, authors: book.authors?.length ? book.authors : fields?.authors ?? [], authorTexts: [book.author] },
    bkgTags,
  );
  const tags = tagResult.tags;
  const tagNote = tagResult.removed.length ? `Fjernet tagger: ${tagResult.removed.join(", ")}` : undefined;

  const productInput: Record<string, unknown> = {
    title: book.title,
    descriptionHtml: desc.html,
    vendor: book.publisher || "",
    // Bok / Lydbok / E-bok ut fra formatet (ikke lenger forfatter). Uten ONIX:
    // ny bok blir «Bok», eksisterende beholder sin
    ...(fields ? { productType: fields.productType } : isUpdate ? {} : { productType: "Bok" }),
    // Produktkategori (Print Books / Audiobooks / E-Books) ut fra formatet
    ...(fields ? { category: fields.category } : isUpdate ? {} : { category: CATEGORY_IDS.Bok }),
    tags,
    ...(status ? { status } : {}),
  };

  if (isUpdate && product) {
    productInput.id = product.id;
    const updateResult = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, { product: productInput });
    const { product: updated, userErrors } = updateResult.data?.productUpdate || {};
    if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
    if (updated) product = updated;
  } else {
    productInput.handle = newBookHandle(book, isbn);
    const createResult = await shopifyGraphQL(PRODUCT_CREATE_MUTATION, { product: productInput });
    const { product: created, userErrors } = createResult.data?.productCreate || {};
    if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
    product = created;
  }

  if (!product?.id) throw new Error("Product create/update returned no product");

  // Publish to every available sales channel — productCreate does not do this
  // on its own, so a freshly exported product would otherwise sit at "0
  // salgskanaler" until someone publishes it manually in Shopify Admin.
  try {
    await publishToAllChannels(product.id as string);
  } catch (_) { /* non-critical — product still exists, just unpublished */ }

  const variantId = (product.variants as { edges: { node: { id: string } }[] })?.edges?.[0]?.node?.id;

  // Step 2: Update variant price + barcode
  if (variantId) {
    await shopifyGraphQL(VARIANT_UPDATE_MUTATION, {
      productId: product.id,
      variants: [{
        id: variantId,
        barcode: isbn,
        // Uten godkjent pris sendes ikke pris: eksisterende pris blir stående
        ...(priceDecision.price !== null ? { price: priceDecision.price } : {}),
        // Kjøpbar uansett lager: sporet lager med DENY får CONTINUE (beholdningen røres ikke)
        ...(availRule && !ownAvail && needsContinuePolicy(availRule, existingVariantNode as Parameters<typeof needsContinuePolicy>[1])
          ? { inventoryPolicy: "CONTINUE" } : {}),
        taxable: false,
      }],
    });

    // Step 2b: Update inventory item (SKU + weight)
    try {
      const variantQuery = `{ productVariant(id: "${variantId}") { inventoryItem { id } } }`;
      const variantData = await shopifyGraphQL(variantQuery, {});
      const inventoryItemId = variantData.data?.productVariant?.inventoryItem?.id;
      if (inventoryItemId) {
        const invInput: Record<string, unknown> = { sku: isbn };
        if (book.vekt) invInput.measurement = { weight: { value: book.vekt, unit: "GRAMS" } };
        await shopifyGraphQL(INVENTORY_ITEM_UPDATE, { id: inventoryItemId, input: invInput });
      }
    } catch (_) { /* non-critical */ }
  }

  // Step 3: SEO-tittel og metabeskrivelse (_shared/book-seo.ts). Et felt skrives
  // bare når det er tomt, lik det Bokadmin sist genererte (bokadmin.seo_auto)
  // eller lik den gamle automatikken; manuelle endringer står.
  const seoNotes: string[] = [];
  try {
    const seoText = onixXml ? extractDescription(onixXml) : "";
    const wantedSeo = bookSeo({
      title: book.title,
      authors: book.authors?.length ? book.authors : fields?.authors ?? [],
      format: fields?.format ?? null,
      year: fields?.year ?? (parseInt(book.year, 10) || null),
      description: seoText || book.description || "",
    });
    const decision = decideSeo(
      { title: (existing?.seoTitleMf as { value?: string } | null)?.value, description: (existing?.seoDescMf as { value?: string } | null)?.value },
      wantedSeo,
      parseSeoAuto((existing?.seoAuto as { value?: string } | null)?.value),
      legacySeo(book.title, book.description),
    );
    seoNotes.push(...decision.notes);
    const seoInput = seoMetafields(product.id as string, decision, wantedSeo);
    if (seoInput.length) {
      await shopifyGraphQL(`
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id key value }
            userErrors { field message }
          }
        }
      `, { metafields: seoInput });
    }
  } catch (_) { /* non-critical */ }

  // Step 3b: bok.isbn — brukes til oppslag ved neste push (customId). Eget kall,
  // slik at en feil her ikke stopper SEO-feltene over. Typen kommer fra
  // metafeltdefinisjonen i butikken.
  let warning: string | undefined;
  try {
    const mf = await shopifyGraphQL(`
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }
    `, { metafields: [{ ownerId: product.id, namespace: "bok", key: "isbn", value: isbn }] });
    const errs = mf.data?.metafieldsSet?.userErrors as { message: string }[] | undefined;
    if (errs?.length) warning = `bok.isbn ble ikke satt: ${errs.map(e => e.message).join(", ")}`;
  } catch (e) {
    warning = `bok.isbn ble ikke satt: ${String(e)}`;
  }
  // Step 3d: bokfeltene (bok.forfatter, format, sider, utgivelsesaar, spraak,
  // serie, alder, thema) fra ONIX. Felt uten verdi i ONIX røres ikke.
  if (fields) {
    const wanted = bookMetafields(fields).map((m) => ({ ownerId: product!.id as string, ...m }));
    if (wanted.length) {
      try {
        const mf = await shopifyGraphQL(`
          mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id }
              userErrors { field message }
            }
          }
        `, { metafields: wanted });
        const errs = mf.data?.metafieldsSet?.userErrors as { message: string }[] | undefined;
        if (errs?.length) warning = [warning, `Bokfelt ble ikke satt: ${errs.map(e => e.message).join(", ")}`].filter(Boolean).join(". ");
      } catch (e) {
        warning = [warning, `Bokfelt ble ikke satt: ${String(e)}`].filter(Boolean).join(". ");
      }
    }
  }

  // Step 3c: bok.tilgjengelighet og bok.utgivelsesdato (bare når tilgjengeligheten er kjent).
  // Egen tilgjengelighet: bare utgivelsesdatoen.
  const availFields = availRule ? availabilityMetafields(product.id as string, availRule, pubDate, !ownAvail) : [];
  if (availFields.length) {
    try {
      const mf = await shopifyGraphQL(`
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }
      `, { metafields: availFields });
      const errs = mf.data?.metafieldsSet?.userErrors as { message: string }[] | undefined;
      if (errs?.length) warning = [warning, `Tilgjengelighet ble ikke satt: ${errs.map(e => e.message).join(", ")}`].filter(Boolean).join(". ");
    } catch (e) {
      warning = [warning, `Tilgjengelighet ble ikke satt: ${String(e)}`].filter(Boolean).join(". ");
    }
  }
  if (warning) console.error(`[push ${isbn}] ${warning}`);

  // Step 4: Omslag (_shared/book-cover.ts). Nytt bilde lastes bare opp når
  // produktet ikke har et. Alt-tekst «Omslag: {Hovedtittel} av {Forfatter}» og
  // filnavn «{handle}-omslag.jpg» settes på nye og eksisterende bilder.
  const imageUrl = book.imageUrl || book.image_url;
  const wantedAlt = coverAlt(book.title, book.authors?.length ? book.authors : fields?.authors ?? []);
  const handleForFile = product.handle as string;
  try {
    if (imageUrl && !alreadyHasImage) {
      const r = await shopifyGraphQL(PRODUCT_IMAGE_MUTATION, {
        product: { id: product.id },
        media: [{ originalSource: imageUrl, alt: wantedAlt, mediaContentType: "IMAGE" }],
      });
      const mediaId = r.data?.productUpdate?.product?.media?.nodes?.[0]?.id as string | undefined;
      if (mediaId) await updateCoverFile(mediaId, { filename: coverFilename(handleForFile, imageUrl) });
    } else if (alreadyHasImage) {
      const node = (existing?.media as { edges: { node: { id: string; alt?: string | null; image?: { url: string } | null } }[] })?.edges?.[0]?.node;
      if (node?.image) {
        const change = coverChanges({ alt: node.alt, url: node.image.url }, { alt: wantedAlt, filename: coverFilename(handleForFile, node.image.url) });
        if (Object.keys(change).length) await updateCoverFile(node.id, change);
      }
    }
  } catch (e) {
    warning = [warning, `Omslag: ${e instanceof Error ? e.message : String(e)}`].filter(Boolean).join(". ");
  }

  // Step 5: Lagre produkt-ID i books, slik at neste push finner produktet direkte
  await saveShopifyIdToBooks(isbn, product.id as string, product.handle as string, variantId);

  const priceNote = priceDecision.note ?? undefined;
  if (priceNote) console.warn(`[push ${isbn}] ${priceNote}`);
  return {
    shopifyId: product.id as string, handle: product.handle as string, variantId, created: !isUpdate,
    warning, priceNote, approvalRequired, availabilityNote, status: status ?? undefined,
    seoNote: seoNotes.length ? seoNotes.join(". ") : undefined,
    descriptionNote,
    tagNote,
  };
}

// ── Sync Smart Collections ────────────────────────────────────────────────────

interface CollectionSyncDetail {
  code: string;
  level: number;
  title: string;
  status: "created" | "existing" | "error";
  id?: string;
  error?: string;
}

interface CollectionSyncResult {
  created: number;
  existing: number;
  errors: number;
  total: number;
  details: CollectionSyncDetail[];
}

interface FullSyncResult {
  products: {
    total: number;
    updated: number;
    alreadyTagged: number;
    noKode: number;
    tagErrors: number;
    /** Beskyttet tagg (_shared/protected.ts): aldri tagget */
    skippedProtected: number;
    /** Samme ISBN på flere produkter: aldri tagget før de er ryddet */
    skippedDuplicate: number;
  };
  collections: CollectionSyncResult;
}

interface AnalyzeResult {
  totalProducts: number;
  alreadyTagged: number;   // har bkg-NNN tag allerede
  needsTagging: number;    // mangler bkg-NNN men har ISBN (bok.isbn/strekkode/SKU) → kan fikses
  unplaceable: number;     // mangler bkg-tag og er ikke ISBN → kan ikke plasseres automatisk
  collections: {
    existing: number;      // bkg-* collections som allerede finnes i Shopify
    toCreate: number;      // bkg-* collections som vil bli opprettet
    total: number;         // totalt antall i COLLECTION_NAMES
  };
}

async function analyzeCollections(): Promise<AnalyzeResult> {
  // Hent alle produkter (handle, tags og ISBN-feltene)
  const allProducts: Array<{ handle: string; tags: string[] }> = [];
  let after: string | null = null;

  while (true) {
    const variables: Record<string, unknown> = { first: 250 };
    if (after) variables.after = after;
    const result = await shopifyGraphQL(`
      query($first: Int!, $after: String) {
        products(first: $first, after: $after, query: "${ALL_PRODUCT_STATUSES}") {
          pageInfo { hasNextPage endCursor }
          edges { cursor node { handle tags ${PRODUCT_ISBN_FIELDS} } }
        }
      }
    `, variables);
    const edges: Array<{ cursor: string; node: { handle: string; tags: string[] } }> =
      result.data?.products?.edges ?? [];
    for (const edge of edges) {
      allProducts.push(edge.node);
      after = edge.cursor;
    }
    if (!result.data?.products?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 200));
  }

  // Analyser tags — finn koder som faktisk brukes i katalogen
  let alreadyTagged = 0, needsTagging = 0, unplaceable = 0;
  const koderInUse = new Set<string>(); // 3-digit koder som faktisk finnes
  for (const product of allProducts) {
    const tag3 = product.tags.find(t => /^bkg-\d{3}$/.test(t));
    if (tag3) {
      alreadyTagged++;
      koderInUse.add(tag3.slice(4)); // strip "bkg-"
    } else if (extractIsbn(product)) {
      needsTagging++;
    } else {
      unplaceable++;
    }
  }

  // Bygg ut alle koder som faktisk vil bli opprettet (1+2+3-sifret for brukte koder)
  const codesNeeded = new Set<string>();
  for (const kode of koderInUse) {
    if (kode.length >= 1) codesNeeded.add(kode[0]);
    if (kode.length >= 2) codesNeeded.add(kode.slice(0, 2));
    if (kode.length >= 3) codesNeeded.add(kode);
  }

  // Hent eksisterende bkg-* collections (batch 250)
  const existingBkgHandles = new Set<string>();
  let colAfter: string | null = null;
  while (true) {
    const variables: Record<string, unknown> = { first: 250 };
    if (colAfter) variables.after = colAfter;
    const result = await shopifyGraphQL(`
      query($first: Int!, $after: String) {
        collections(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { cursor node { handle } }
        }
      }
    `, variables);
    const edges: Array<{ cursor: string; node: { handle: string } }> =
      result.data?.collections?.edges ?? [];
    for (const edge of edges) {
      if (edge.node.handle.startsWith("bkg-")) existingBkgHandles.add(edge.node.handle);
      colAfter = edge.cursor;
    }
    if (!result.data?.collections?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const needed = [...codesNeeded];
  const existing = needed.filter(k => existingBkgHandles.has(`bkg-${k}`)).length;
  const total = needed.length;

  return {
    totalProducts: allProducts.length,
    alreadyTagged,
    needsTagging,
    unplaceable,
    collections: { existing, toCreate: total - existing, total },
  };
}

async function ensureCollections(
  koder: Set<string>
): Promise<CollectionSyncResult> {
  // Expand each 3-digit code to 1-digit, 2-digit, and 3-digit codes
  const allCodes = new Set<string>();
  for (const kode of koder) {
    if (!kode || kode === "ukjent") continue;
    const k = kode.trim();
    if (k.length >= 1) allCodes.add(k[0]);
    if (k.length >= 2) allCodes.add(k.slice(0, 2));
    if (k.length >= 3) allCodes.add(k.slice(0, 3));
  }

  // Sort: 1-digit first, then 2-digit, then 3-digit
  const sortedCodes = [...allCodes].sort((a, b) => a.length - b.length || a.localeCompare(b));

  let created = 0, existing = 0, errors = 0;
  const details: CollectionSyncDetail[] = [];

  for (const code of sortedCodes) {
    const handle = `bkg-${code}`;
    const title = COLLECTION_NAMES[code] ?? `Bokgruppe ${code}`;
    const tag = `bkg-${code}`;
    const level = code.length;

    try {
      const lookupResult = await shopifyGraphQL(COLLECTION_BY_HANDLE_QUERY, { handle });
      const existingCol = lookupResult.data?.collectionByIdentifier;

      if (existingCol?.id) {
        existing++;
        // Feil navn på en eksisterende samling: rett tittelen (handle endres ikke)
        const fixed = collectionTitleFix(existingCol.title, COLLECTION_NAMES[code]);
        if (fixed) {
          const ur = await shopifyGraphQL(COLLECTION_UPDATE_MUTATION, { collection: { id: existingCol.id, title: fixed } });
          const ue = ur.data?.collectionUpdate?.userErrors as { message: string }[] | undefined;
          if (ue?.length) throw new Error(ue.map((e) => e.message).join(", "));
          details.push({ code, level, title, status: "renamed", id: existingCol.id });
        } else {
          details.push({ code, level, title, status: "existing", id: existingCol.id });
        }
      } else {
        const createResult = await shopifyGraphQL(COLLECTION_CREATE_MUTATION, {
          collection: { title, handle, sources: tagSources(tag) },
        });
        const { collection, userErrors } = createResult.data?.collectionCreate || {};
        if (userErrors?.length) {
          throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
        }
        created++;
        details.push({ code, level, title, status: "created", id: collection?.id });
      }
    } catch (e) {
      errors++;
      details.push({ code, level, title, status: "error", error: String(e) });
    }

    await new Promise(r => setTimeout(r, 250));
  }

  return { created, existing, errors, total: sortedCodes.length, details };
}

async function fullSyncCollections(
  bokbasenCredentials: BokbasenCredentials | null,
): Promise<FullSyncResult> {
  // ── Step 1: Fetch all Shopify products (paginated) ─────────────────────────
  const allProducts: Array<{ id: string; handle: string; tags: string[] }> = [];
  let after: string | null = null;

  while (true) {
    const variables: Record<string, unknown> = { first: 50 };
    if (after) variables.after = after;

    const result = await shopifyGraphQL(ALL_PRODUCTS_QUERY, variables);
    const edges: Array<{ cursor: string; node: { id: string; handle: string; tags: string[] } }> =
      result.data?.products?.edges ?? [];
    const pageInfo: { hasNextPage: boolean } = result.data?.products?.pageInfo ?? {};

    for (const edge of edges) {
      allProducts.push(edge.node);
      after = edge.cursor;
    }

    if (!pageInfo.hasNextPage) break;
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Step 2: Determine bokgruppekode for each product ──────────────────────
  // If a product already has a 3-digit bkg-NNN tag, we know its kode.
  // Otherwise look it up from Bokbasen by ISBN (bok.isbn / strekkode / SKU / ISBN-handle).
  const productToKode = new Map<string, string>(); // product.id → kode
  const needsLookup: Array<{ id: string; isbn: string }> = [];
  // Beskyttede produkter (tagg gave/lokal/lokalhistorie/lokallitteratur) får aldri nye tagger
  const isProtectedProduct = (p: { tags: string[] }) => protectedTag(p.tags) !== null;
  const skippedProtected = allProducts.filter(isProtectedProduct).length;
  // ISBN med flere produkter (pakke D del 3b) tagges ikke før de er ryddet
  const perIsbn: Record<string, number> = {};
  for (const p of allProducts) { const i = extractIsbn(p); if (i) perIsbn[i] = (perIsbn[i] ?? 0) + 1; }
  const duplicates = duplicateCounts(perIsbn);
  const isDuplicate = (p: { tags: string[] }) => { const i = extractIsbn(p); return !!i && !!duplicates[i]; };
  const skippedDuplicate = allProducts.filter((p) => !isProtectedProduct(p) && isDuplicate(p)).length;

  for (const product of allProducts) {
    if (isProtectedProduct(product) || isDuplicate(product)) continue;
    const existing = product.tags.find(t => /^bkg-\d{3}$/.test(t));
    if (existing) {
      productToKode.set(product.id, existing.slice(4)); // strip "bkg-"
    } else {
      const isbn = extractIsbn(product);
      if (isbn) needsLookup.push({ id: product.id, isbn });
    }
  }

  // Batch Bokbasen lookups (10 parallel)
  const batchSize = 10;
  for (let i = 0; i < needsLookup.length; i += batchSize) {
    const batch = needsLookup.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (p) => {
        const kode = await fetchBokgruppekode(p.isbn, bokbasenCredentials);
        if (!kode) throw new Error("no_kode");
        return { id: p.id, kode };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") productToKode.set(r.value.id, r.value.kode);
    }
    if (i + batchSize < needsLookup.length) await new Promise(r => setTimeout(r, 150));
  }

  // ── Step 3: Tag products that are missing bkg-* tags ──────────────────────
  let updated = 0, alreadyTagged = 0, noKode = 0, tagErrors = 0;
  const koderFound = new Set<string>();

  for (const product of allProducts) {
    if (isProtectedProduct(product)) {
      console.warn(`[sync-collections ${product.handle}] ${protectedMessage(product.tags)}`);
      continue;
    }
    if (isDuplicate(product)) {
      console.warn(`[sync-collections ${product.handle}] ${duplicateMessage(duplicates[extractIsbn(product)!])}`);
      continue;
    }
    const kode = productToKode.get(product.id);
    if (!kode) { noKode++; continue; }

    koderFound.add(kode);
    const requiredTags = bokgruppeTagsForKode(kode);
    const missingTags = requiredTags.filter(t => !product.tags.includes(t));

    if (missingTags.length === 0) { alreadyTagged++; continue; }

    try {
      const updateResult = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, {
        product: { id: product.id, tags: [...product.tags, ...missingTags] },
      });
      const { userErrors } = updateResult.data?.productUpdate ?? {};
      if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
      updated++;
    } catch (_e) {
      tagErrors++;
    }

    await new Promise(r => setTimeout(r, 250));
  }

  // ── Step 4: Create / verify Smart Collections ──────────────────────────────
  const collections = await ensureCollections(koderFound);

  return {
    products: { total: allProducts.length, updated, alreadyTagged, noKode, tagErrors, skippedProtected, skippedDuplicate },
    collections,
  };
}

// ── CSV export ───────────────────────────────────────────────────────────────

function escapeCSV(val: string | number | null | undefined): string {
  const str = String(val ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function booksToShopifyCSV(books: BookMetadata[]): string {
  const headers = [
    "URL handle", "Title", "Description", "Vendor", "Type", "Tags",
    "Published on online store", "Status", "Option1 name", "Option1 value",
    "SKU", "Barcode", "Price", "Charge tax", "Product category",
    "Continue selling when out of stock", "Inventory tracker",
    "Weight value (grams)", "Weight unit for display", "Fulfillment service",
    "Requires shipping", "Gift card", "Product image URL",
    "SEO title", "SEO description",
    "Google Shopping / Google product category", "Google Shopping / Condition",
  ];

  const rows = books.map(book => {
    // Bare bkg-tagger (pakke B del 7): forfatter og tittel er ikke tagger
    const tags = (book.bokgruppekode ? bokgruppeTagsForKode(book.bokgruppekode) : []).join(", ");
    const imageUrl = book.imageUrl || book.image_url || "";

    const isbn = normalizeIsbn(book.isbn);
    // Uten godkjent pris: Status = draft og tom pris, aldri 0. Ellers status
    // etter tilgjengelighetsregelen (kommer/midlertidig utsolgt = active)
    const { price, status } = csvPriceAndStatus(book.price, book.availability ?? book.availability_code ?? null);
    return [
      isbn ? newBookHandle(book, isbn) : book.isbn, book.title, book.description || "", book.publisher || "",
      book.productType || "Bok", tags, "TRUE", status, "Title", "Default Title",
      book.isbn, book.isbn, price, "FALSE",
      CATEGORY_NAMES[(book.productType as keyof typeof CATEGORY_NAMES) ?? "Bok"] ?? CATEGORY_NAMES.Bok,
      "continue", "", book.vekt ?? "", "g", "manual", "TRUE", "FALSE",
      imageUrl, book.title, (book.description || "").slice(0, 320),
      "Media > Books", "New",
    ].map(escapeCSV).join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

// ── Megameny — dynamisk fra COLLECTION_NAMES ─────────────────────────────────
// Bygger 3-nivå struktur (bkg-N → bkg-NN → bkg-NNN) direkte fra COLLECTION_NAMES
// slik at menyen alltid er i sync med alle definerte koder.

interface MenuItemInput {
  title: string;
  url: string;
  items?: MenuItemInput[];
}

// Fetch bkg-* collections that have at least 1 product
async function getActiveBkgCodes(): Promise<Set<string>> {
  const activeCodes = new Set<string>();
  let colAfter: string | null = null;
  while (true) {
    const variables: Record<string, unknown> = { first: 50 };
    if (colAfter) variables.after = colAfter;
    const result = await shopifyGraphQL(`
      query($first: Int!, $after: String) {
        collections(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges {
            cursor
            node {
              handle
              products(first: 1) { edges { node { id } } }
            }
          }
        }
      }
    `, variables);
    const edges: Array<{ cursor: string; node: { handle: string; products: { edges: unknown[] } } }> =
      result.data?.collections?.edges ?? [];
    for (const edge of edges) {
      const { handle, products } = edge.node;
      if (handle.startsWith("bkg-") && products.edges.length > 0) {
        activeCodes.add(handle.slice(4)); // strip "bkg-"
      }
      colAfter = edge.cursor;
    }
    if (!result.data?.collections?.pageInfo?.hasNextPage) break;
    await new Promise(r => setTimeout(r, 200));
  }
  return activeCodes;
}

// Build menu tree only from codes that are active (have products), plus their ancestors
function buildMenuStructureFromCodes(activeCodes: Set<string>, maxDepth: 2 | 3): MenuItemInput[] {
  const codes = Object.keys(COLLECTION_NAMES);

  const is2digitActive = (code2: string) =>
    activeCodes.has(code2) ||
    codes.some(k => k.length === 3 && k.startsWith(code2) && activeCodes.has(k));

  return codes
    .filter(k => k.length === 1)
    .sort()
    .flatMap(code1 => {
      const level2 = codes
        .filter(k => k.length === 2 && k[0] === code1 && is2digitActive(k))
        .sort()
        .map(code2 => {
          if (maxDepth === 2) {
            return { title: COLLECTION_NAMES[code2], url: `/collections/bkg-${code2}` } as MenuItemInput;
          }
          const level3 = codes
            .filter(k => k.length === 3 && k.startsWith(code2) && activeCodes.has(k))
            .sort()
            .map(code3 => ({ title: COLLECTION_NAMES[code3], url: `/collections/bkg-${code3}` }));
          return {
            title: COLLECTION_NAMES[code2],
            url: `/collections/bkg-${code2}`,
            ...(level3.length ? { items: level3 } : {}),
          } as MenuItemInput;
        });
      if (level2.length === 0) return [];
      return [{
        title: COLLECTION_NAMES[code1],
        url: `/collections/bkg-${code1}`,
        items: level2,
      } as MenuItemInput];
    });
}

// maxDepth: 2 = 1-digit → 2-digit only (for nesting under a parent item like "Nettbutikk", total 3 levels)
//           3 = 1-digit → 2-digit → 3-digit (for standalone menus, total 3 levels)
function buildMenuStructure(maxDepth: 2 | 3 = 2): MenuItemInput[] {
  const codes = Object.keys(COLLECTION_NAMES);
  return codes
    .filter(k => k.length === 1)
    .sort()
    .map(code1 => {
      const level2 = codes
        .filter(k => k.length === 2 && k[0] === code1)
        .sort()
        .map(code2 => {
          if (maxDepth === 2) {
            return {
              title: COLLECTION_NAMES[code2],
              url: `/collections/bkg-${code2}`,
            };
          }
          const level3 = codes
            .filter(k => k.length === 3 && k.startsWith(code2))
            .sort()
            .map(code3 => ({
              title: COLLECTION_NAMES[code3],
              url: `/collections/bkg-${code3}`,
            }));
          return {
            title: COLLECTION_NAMES[code2],
            url: `/collections/bkg-${code2}`,
            ...(level3.length ? { items: level3 } : {}),
          };
        });
      return {
        title: COLLECTION_NAMES[code1],
        url: `/collections/bkg-${code1}`,
        ...(level2.length ? { items: level2 } : {}),
      };
    });
}


async function buildMegaMenu(
  menuHandle: string,
): Promise<{ success: boolean; itemsCount?: number }> {
  menuHandle = menuHandle.toLowerCase().trim();

  interface ExistingMenuItem {
    id?: string;
    title: string;
    type?: string;
    url?: string;
    resourceId?: string;
    tags?: string[];
    items?: ExistingMenuItem[];
  }

  interface MenuUpdateItem {
    id?: string;
    title: string;
    type?: string;
    url?: string;
    resourceId?: string;
    tags?: string[];
    items?: MenuUpdateItem[];
  }

  // 1. List menyer inkl. eksisterende items, og finn riktig via handle
  const menuQuery = `
    query GetMenus {
      menus(first: 50) {
        edges {
          node {
            id
            title
            handle
            items {
              id
              title
              type
              url
              resourceId
              tags
              items {
                id
                title
                type
                url
                resourceId
                tags
                items {
                  id
                  title
                  type
                  url
                  resourceId
                  tags
                }
              }
            }
          }
        }
      }
    }
  `;
  const menuData = await shopifyGraphQL(menuQuery, {});
  const allMenus: Array<{ id: string; title: string; handle: string; items?: ExistingMenuItem[] }> =
    (menuData.data?.menus?.edges ?? []).map(
      (e: { node: { id: string; title: string; handle: string; items?: ExistingMenuItem[] } }) => e.node
    );
  const menu = allMenus.find(m => m.handle === menuHandle);
  if (!menu) {
    const available = allMenus.map(m => `"${m.handle}"`).join(", ");
    throw new Error(`Fant ikke meny med handle "${menuHandle}". Tilgjengelige: ${available || "ingen"}`);
  }

  // 2 levels under "Nettbutikk" = 3 total (Shopify max)
  // Only include categories that have actual products in Shopify
  const activeCodes = await getActiveBkgCodes();
  const menuStructure = activeCodes.size > 0
    ? buildMenuStructureFromCodes(activeCodes, 2)
    : buildMenuStructure(2); // fallback to full tree if no active codes found

  function generatedToUpdateItems(items: MenuItemInput[]): MenuUpdateItem[] {
    return items.map(item => ({
      type: "HTTP",
      title: item.title,
      url: item.url,
      ...(item.items?.length ? { items: generatedToUpdateItems(item.items) } : {}),
    }));
  }

  function existingToUpdateItems(items: ExistingMenuItem[]): MenuUpdateItem[] {
    return items.map(item => ({
      ...(item.id ? { id: item.id } : {}),
      title: item.title,
      ...(item.type ? { type: item.type } : {}),
      ...(item.url ? { url: item.url } : {}),
      ...(item.resourceId ? { resourceId: item.resourceId } : {}),
      ...(item.tags?.length ? { tags: item.tags } : {}),
      ...(item.items?.length ? { items: existingToUpdateItems(item.items) } : {}),
    }));
  }

  const generatedItems = generatedToUpdateItems(menuStructure);
  const existingTopLevel = existingToUpdateItems(menu.items ?? []);

  let foundNettbutikk = false;
  const mergedItems: MenuUpdateItem[] = existingTopLevel.map(item => {
    if (item.title.trim().toLowerCase() !== "nettbutikk") return item;
    foundNettbutikk = true;
    return {
      ...item,
      items: generatedItems,
    };
  });

  if (!foundNettbutikk) {
    mergedItems.push({
      title: "Nettbutikk",
      type: "HTTP",
      url: "/collections/all",
      items: generatedItems,
    });
  }

  // 2. Oppdater menyen med sammenslåtte items
  function toGQLInput(val: unknown, enumField = false): string {
    if (val === null || val === undefined) return "null";
    if (typeof val === "string") return enumField ? val : JSON.stringify(val);
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (Array.isArray(val)) return `[${val.map(v => toGQLInput(v)).join(", ")}]`;
    if (typeof val === "object") {
      const fields = Object.entries(val as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${toGQLInput(v, k === "type")}`).join(", ");
      return `{${fields}}`;
    }
    return String(val);
  }

  const itemsLiteral = toGQLInput(mergedItems);
  const updateMutation = `
    mutation {
      menuUpdate(id: ${JSON.stringify(menu.id)}, title: ${JSON.stringify(menu.title)}, items: ${itemsLiteral}) {
        menu {
          id
          title
          handle
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const updateData = await shopifyGraphQL(updateMutation, {});
  const { userErrors } = updateData.data?.menuUpdate ?? {};
  if (userErrors?.length) {
    throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
  }
  return { success: true, itemsCount: generatedItems.length };
}

// ── Credential helpers ────────────────────────────────────────────────────────

// Decode JWT payload without verification (server-side, acceptable)

// ── Feed (Manual Collection) management ──────────────────────────────────────

const FEEDS_LIST_QUERY = `
  query FeedsList($first: Int!, $query: String!) {
    collections(first: $first, sortKey: UPDATED_AT, reverse: true, query: $query) {
      edges {
        node {
          id title handle sortOrder
          productsCount { count }
          image { url altText }
          products(first: 4) {
            edges {
              node {
                featuredMedia { preview { image { url } } }
              }
            }
          }
        }
      }
    }
  }
`;

const FEED_GET_QUERY = `
  query FeedGet($id: ID!, $first: Int!) {
    collection(id: $id) {
      id title handle sortOrder
      productsCount { count }
      image { url altText }
      products(first: $first) {
        edges {
          node {
            id title handle productType vendor status createdAt
            featuredMedia { preview { image { url } } }
            variants(first: 1) { edges { node { id price } } }
          }
        }
      }
    }
  }
`;

const COLLECTION_DELETE_MUTATION = `
  mutation CollectionDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors { field message }
    }
  }
`;

const COLLECTION_ADD_PRODUCTS_MUTATION = `
  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id productsCount { count } }
      userErrors { field message }
    }
  }
`;

const COLLECTION_REMOVE_PRODUCTS_MUTATION = `
  mutation CollectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

const COLLECTION_REORDER_MUTATION = `
  mutation CollectionReorder($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      userErrors { field message }
    }
  }
`;

async function feedsList() {
  const result = await shopifyGraphQL(FEEDS_LIST_QUERY, { first: 100, query: "collection_type:custom" });
  const edges = result.data?.collections?.edges ?? [];
  return edges
    .filter((e: any) => !e.node.handle?.startsWith('bkg-'))
    .map((e: any) => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      sortOrder: e.node.sortOrder,
      productsCount: e.node.productsCount?.count ?? 0,
      image: e.node.image?.url ?? null,
      productImages: (e.node.products?.edges ?? [])
        .map((pe: any) => pe.node.featuredMedia?.preview?.image?.url)
        .filter(Boolean) as string[],
    }));
}

async function feedGet(collectionId: string) {
  const result = await shopifyGraphQL(FEED_GET_QUERY, { id: collectionId, first: 250 });
  const col = result.data?.collection;
  if (!col) throw new Error("Collection not found");
  const products = (col.products?.edges ?? []).map((e: any) => ({
    id: e.node.id,
    title: e.node.title,
    handle: e.node.handle,
    author: e.node.productType ?? "",
    vendor: e.node.vendor ?? "",
    status: e.node.status,
    createdAt: e.node.createdAt ?? "",
    image: e.node.featuredMedia?.preview?.image?.url ?? null,
    price: e.node.variants?.edges?.[0]?.node?.price ?? "0.00",
  }));
  return {
    collection: {
      id: col.id,
      title: col.title,
      handle: col.handle,
      sortOrder: col.sortOrder,
      productsCount: col.productsCount?.count ?? 0,
      image: col.image?.url ?? null,
    },
    products,
  };
}

async function feedCreate(title: string) {
  // Uten sources blir samlingen manuell
  const result = await shopifyGraphQL(COLLECTION_CREATE_MUTATION, {
    collection: { title },
  });
  const { collection, userErrors } = result.data?.collectionCreate ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
  return collection;
}

async function feedDelete(collectionId: string) {
  const result = await shopifyGraphQL(COLLECTION_DELETE_MUTATION, {
    input: { id: collectionId },
  });
  const { userErrors } = result.data?.collectionDelete ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

async function feedAddProducts(collectionId: string, productIds: string[]) {
  const result = await shopifyGraphQL(COLLECTION_ADD_PRODUCTS_MUTATION, {
    id: collectionId,
    productIds,
  });
  const { userErrors } = result.data?.collectionAddProducts ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

async function feedRemoveProducts(collectionId: string, productIds: string[]) {
  const result = await shopifyGraphQL(COLLECTION_REMOVE_PRODUCTS_MUTATION, {
    id: collectionId,
    productIds,
  });
  const { userErrors } = result.data?.collectionRemoveProducts ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

async function feedUpdate(collectionId: string, updates: { sortOrder?: string }) {
  const collection: Record<string, unknown> = { id: collectionId };
  if (updates.sortOrder) collection.sortOrder = updates.sortOrder;
  const result = await shopifyGraphQL(COLLECTION_UPDATE_MUTATION, { collection });
  const { userErrors } = result.data?.collectionUpdate ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

async function feedReorderProducts(collectionId: string, moves: Array<{ id: string; newPosition: string }>) {
  const result = await shopifyGraphQL(COLLECTION_REORDER_MUTATION, {
    id: collectionId,
    moves,
  });
  const { userErrors } = result.data?.collectionReorderProducts ?? {};
  if (userErrors?.length) throw new Error(userErrors.map((e: any) => e.message).join(", "));
}

// ── Handle-migrering (Handles-siden) ─────────────────────────────────────────
// Planen lages av _shared/handle-migration.js (samme som scripts/migrate-handles.mjs).
// Utføring: én Shopify bulk-operasjon (bulkOperationRunMutation) per kjøring,
// registrert som jobb i jobs-tabellen. GET /handles/status/:jobId poller
// bulk-operasjonen og skriver resultatet til sync_log når den er ferdig.
// Angre kjøres i pulser på maks HANDLE_PULSE_MS fra nettleseren.

const HANDLE_JOB_TYPE = "handle_migration";
const HANDLE_LOG_MIGRATE = "handle_migrate";
const HANDLE_LOG_ROLLBACK = "handle_rollback";
const HANDLE_PULSE_MS = 40_000;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface HandleJobRow {
  id: string; oldHandle: string; newHandle: string; title: string; isbn: string;
}

// Migrering (endring av handles) er bare lov mot Testbutikk, eller når
// hemmeligheten ALLOW_HANDLE_MIGRATION=true er satt bevisst.
function handleMigrationAllowed(): boolean {
  return SAFE_STORES.includes(getShopDomain()) || Deno.env.get("ALLOW_HANDLE_MIGRATION") === "true";
}

function requireHandleMigrationAllowed(): void {
  if (!handleMigrationAllowed()) {
    throw new HttpError(403, `Endring av handles er ikke tillatt mot ${getShopDomain()}. ` +
      `Kun Testbutikk, eller med hemmeligheten ALLOW_HANDLE_MIGRATION=true.`);
  }
}

async function fetchMigrationProducts(): Promise<unknown[]> {
  const all: unknown[] = [];
  let cursor: string | null = null;
  do {
    const r: { data: { products?: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } =
      await shopifyGraphQL(MIGRATION_PRODUCTS_QUERY, { cursor });
    all.push(...(r.data?.products?.nodes ?? []));
    cursor = r.data?.products?.pageInfo?.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

// deno-lint-ignore no-explicit-any
async function restJson(pathAndQuery: string, init: RequestInit = {}): Promise<any> {
  const res = await supabaseRest(pathAndQuery, init);
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// deno-lint-ignore no-explicit-any
async function getHandleJob(jobId: string): Promise<any | null> {
  const rows = await restJson(`jobs?id=eq.${encodeURIComponent(jobId)}&type=eq.${HANDLE_JOB_TYPE}&select=*`);
  return rows?.[0] ?? null;
}

// deno-lint-ignore no-explicit-any
async function latestHandleJob(filter = ""): Promise<any | null> {
  const rows = await restJson(`jobs?type=eq.${HANDLE_JOB_TYPE}${filter}&select=*&order=created_at.desc&limit=1`);
  return rows?.[0] ?? null;
}

// Oppdaterer jobben. extraFilter (f.eks. "&status=eq.running") gjør oppdateringen
// betinget; returnerer de oppdaterte radene.
// deno-lint-ignore no-explicit-any
async function patchHandleJob(jobId: string, patch: Record<string, unknown>, extraFilter = ""): Promise<any[]> {
  return await restJson(`jobs?id=eq.${encodeURIComponent(jobId)}${extraFilter}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  }) ?? [];
}

async function insertSyncLog(entries: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < entries.length; i += 500) {
    await restJson("sync_log", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(entries.slice(i, i + 500)),
    });
  }
}

// Endringer fra en kjøring som fortsatt gjelder (migrert og ikke angret),
// lest fra sync_log. message har formen "<gammel> -> <ny>".
async function activeHandleChanges(jobId: string): Promise<Array<{ id: string; oldHandle: string; newHandle: string; isbn: string; title: string }>> {
  // deno-lint-ignore no-explicit-any
  const entries: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await restJson(
      `sync_log?job_id=eq.${encodeURIComponent(jobId)}&status=eq.success` +
      `&action=in.(${HANDLE_LOG_MIGRATE},${HANDLE_LOG_ROLLBACK})` +
      `&select=action,message,shopify_id,isbn,title,created_at&order=created_at.asc&limit=1000&offset=${offset}`);
    entries.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  const active = new Map<string, { id: string; oldHandle: string; newHandle: string; isbn: string; title: string }>();
  for (const e of entries) {
    if (e.action === HANDLE_LOG_ROLLBACK) { active.delete(e.shopify_id); continue; }
    const [oldHandle, newHandle] = String(e.message ?? "").split(" -> ");
    if (e.shopify_id && oldHandle && newHandle) {
      active.set(e.shopify_id, { id: e.shopify_id, oldHandle, newHandle, isbn: e.isbn ?? "", title: e.title ?? "" });
    }
  }
  return [...active.values()];
}

async function startHandleBulk(rows: HandlePlanRow[]): Promise<string> {
  const jsonl = rows.map((r) => JSON.stringify({ product: handleUpdateInput(r) })).join("\n");
  return await startBulkMutation(HANDLE_UPDATE_MUTATION, jsonl, "handles.jsonl");
}

// POST /handles/migrate
async function startHandleMigration(productIds: string[] | undefined, skipFlagged: boolean, userId: string | null) {
  requireHandleMigrationAllowed();
  const running = await latestHandleJob("&status=in.(running,finalizing)");
  if (running) throw new HttpError(409, "En handle-migrering kjører allerede. Vent til den er ferdig.");

  // Lag planen på nytt her — stol ikke på handles fra nettleseren
  const { plan } = planHandleMigration(await fetchMigrationProducts());
  const wanted = productIds?.length ? new Set(productIds) : null;
  let rows = wanted ? plan.filter((r) => wanted.has(r.id)) : plan;
  const blocked = rows.filter(isBlockedRow);
  if (blocked.length && !skipFlagged) {
    throw new HttpError(400, `${blocked.length} rader har duplikat eller kollisjon. Kryss av for å hoppe over dem.`);
  }
  rows = rows.filter((r) => !isBlockedRow(r));
  if (!rows.length) throw new HttpError(400, "Ingen produkter å endre.");

  const jobRows: HandleJobRow[] = rows.map((r) => ({ id: r.id, oldHandle: r.oldHandle, newHandle: r.newHandle, title: r.title, isbn: r.isbn }));
  const [job] = await restJson("jobs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      type: HANDLE_JOB_TYPE,
      status: "running",
      total_items: rows.length,
      skipped: blocked.length,
      user_id: userId,
      started_at: new Date().toISOString(),
      config: { shop: getShopDomain(), rows: jobRows, skippedBlocked: blocked.length },
    }),
  });

  try {
    const bulkOperationId = await startHandleBulk(rows);
    await patchHandleJob(job.id, { config: { ...job.config, bulkOperationId } });
  } catch (e) {
    await patchHandleJob(job.id, { status: "failed", error_message: String(e), completed_at: new Date().toISOString() });
    throw e;
  }
  return { jobId: job.id, total: rows.length, skippedBlocked: blocked.length };
}

// Poller bulk-operasjonen; når den er ferdig skrives hver endring til sync_log.
// deno-lint-ignore no-explicit-any
async function refreshHandleJob(job: any): Promise<any> {
  if (job?.status !== "running" || !job.config?.bulkOperationId) return job;

  const r = await shopifyGraphQL(
    `query ($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode objectCount url partialDataUrl } } }`,
    { id: job.config.bulkOperationId });
  const op = r.data?.node;
  if (!op) return job;
  if (BULK_ACTIVE.includes(op.status)) {
    const processed = Number(op.objectCount ?? 0);
    if (processed !== job.processed) await patchHandleJob(job.id, { processed });
    return { ...job, processed, bulkStatus: op.status };
  }

  // Lås: bare ett kall får skrive resultatet
  const locked = await patchHandleJob(job.id, { status: "finalizing" }, "&status=eq.running");
  if (!locked.length) return await getHandleJob(job.id);

  try {
    const rows: HandleJobRow[] = job.config.rows ?? [];
    const outcome = new Map<number, { handle?: string; error?: string }>();
    const resultUrl = op.url || op.partialDataUrl;
    if (resultUrl) {
      const text = await (await fetch(resultUrl)).text();
      for (const line of text.split("\n").filter(Boolean)) {
        const res = JSON.parse(line);
        const n = Number(res.__lineNumber);
        const upd = res.data?.productUpdate;
        if (res.errors?.length) outcome.set(n, { error: res.errors.map((e: { message: string }) => e.message).join("; ") });
        else if (upd?.userErrors?.length) outcome.set(n, { error: upd.userErrors.map((e: { message: string }) => e.message).join("; ") });
        else if (upd?.product?.handle) outcome.set(n, { handle: upd.product.handle });
      }
    }

    const now = new Date().toISOString();
    let succeeded = 0, failed = 0;
    const mismatched: Array<{ id: string; planned: string; actual: string }> = [];
    const log = rows.map((row, i) => {
      const o = outcome.get(i) ?? { error: `Ingen resultat fra Shopify (bulk-status ${op.status}${op.errorCode ? `, ${op.errorCode}` : ""})` };
      if (o.handle) {
        succeeded++;
        if (o.handle !== row.newHandle) mismatched.push({ id: row.id, planned: row.newHandle, actual: o.handle });
      } else {
        failed++;
      }
      return {
        isbn: row.isbn, title: row.title, action: HANDLE_LOG_MIGRATE,
        status: o.handle ? "success" : "error",
        message: o.handle ? `${row.oldHandle} -> ${o.handle}` : `${row.oldHandle}: ${o.error}`,
        shopify_id: row.id, job_id: job.id, user_id: job.user_id ?? null, created_at: now,
      };
    });
    await insertSyncLog(log);

    const [updated] = await patchHandleJob(job.id, {
      status: op.status === "COMPLETED" || succeeded > 0 ? "completed" : "failed",
      processed: rows.length, succeeded, failed,
      error_message: op.status === "COMPLETED" ? null : `Bulk-operasjonen endte med ${op.status}${op.errorCode ? ` (${op.errorCode})` : ""}`,
      result: { changed: succeeded, errors: failed, mismatched, bulkStatus: op.status },
      completed_at: now,
    });
    return updated;
  } catch (e) {
    await patchHandleJob(job.id, { status: "running" }); // lås opp, prøv igjen ved neste poll
    throw e;
  }
}

// GET /handles/verify — sjekker urlRedirects (og storefront-svaret for noen få)
async function verifyHandleJob(jobId: string | null) {
  const job = jobId ? await getHandleJob(jobId) : await latestHandleJob("&status=eq.completed");
  if (!job) throw new HttpError(404, "Fant ingen utført handle-migrering.");
  const changes = await activeHandleChanges(job.id);
  const step = Math.max(1, Math.ceil(changes.length / 50));
  const sample = changes.filter((_, i) => i % step === 0);

  let storefront: string | null = null;
  try {
    const s = await shopifyGraphQL(`{ shop { primaryDomain { url } } }`);
    storefront = s.data?.shop?.primaryDomain?.url ?? null;
  } catch { /* hopp over storefront-sjekken */ }

  const results = [];
  let ok = 0;
  for (const [i, c] of sample.entries()) {
    const path = `/products/${c.oldHandle}`;
    const r = await shopifyGraphQL(`query ($q: String!) { urlRedirects(first: 5, query: $q) { nodes { id path target } } }`, { q: `path:${path}` });
    const hit = (r.data?.urlRedirects?.nodes ?? []).find((n: { path: string }) => n.path === path);
    const good = !!hit && String(hit.target).endsWith(`/products/${c.newHandle}`);
    if (good) ok++;
    // Selve nettsiden for de første fem: forventet 301 med Location til ny adresse
    let http: { status: number; location: string | null } | null = null;
    if (storefront && i < 5) {
      try {
        const res = await fetch(`${storefront}${path}`, { redirect: "manual" });
        await res.body?.cancel();
        http = { status: res.status, location: res.headers.get("location") };
      } catch { /* nettverksfeil — vis uten http */ }
    }
    results.push({ oldHandle: c.oldHandle, newHandle: c.newHandle, target: hit?.target ?? null, ok: good, http });
  }
  return { jobId: job.id, total: changes.length, checked: sample.length, ok, storefront, results };
}

// POST /handles/rollback — setter tilbake fra sync_log, i pulser
async function rollbackHandleJob(jobId: string | null, userId: string | null) {
  requireHandleMigrationAllowed();
  const job = jobId
    ? await getHandleJob(jobId)
    : await latestHandleJob("&status=eq.completed&result->>rolledBackAt=is.null");
  if (!job) throw new HttpError(404, "Fant ingen kjøring å angre.");
  if (job.status !== "completed" && job.status !== "failed") throw new HttpError(409, "Kjøringen er ikke ferdig ennå.");

  const pending = await activeHandleChanges(job.id);
  const started = Date.now();
  let restored = 0, failed = 0, skippedProtected = 0, timedOut = false;
  // Beskyttede produkter som beholder ny handle (og videresendingen) — kjøringen blir «delvis angret»
  const protectedKept: Array<{ id: string; title: string; isbn: string; handle: string; oldHandle: string; tag: string }> = [];
  const errors: string[] = [];
  const log: Record<string, unknown>[] = [];

  for (const c of pending) {
    if (Date.now() - started > HANDLE_PULSE_MS) { timedOut = true; break; }
    const path = `/products/${c.oldHandle}`;
    try {
      const cur = await shopifyGraphQL(`query ($id: ID!) { product(id: $id) { handle tags } }`, { id: c.id });
      const handle = cur.data?.product?.handle;
      if (!handle) throw new Error("produktet finnes ikke lenger");
      // Beskyttet nå (tagg gave/lokal/…): verken handle eller videresending røres.
      // Logges som info, så endringen står som aktiv i sync_log.
      if (protectedTag(cur.data.product.tags)) {
        skippedProtected++;
        protectedKept.push({ id: c.id, title: c.title, isbn: c.isbn, handle: c.newHandle, oldHandle: c.oldHandle, tag: protectedTag(cur.data.product.tags)! });
        log.push({ isbn: c.isbn, title: c.title, action: HANDLE_LOG_ROLLBACK, status: "info", message: `${c.newHandle}: ${protectedMessage(cur.data.product.tags)}`, shopify_id: c.id, job_id: job.id, user_id: userId });
        continue;
      }
      if (handle !== c.oldHandle) {
        if (handle !== c.newHandle) throw new Error(`handle er endret siden migreringen (nå ${handle})`);
        // Videresendingen fra gammel sti må bort før produktet kan få stien tilbake
        const r = await shopifyGraphQL(`query ($q: String!) { urlRedirects(first: 5, query: $q) { nodes { id path target } } }`, { q: `path:${path}` });
        for (const n of (r.data?.urlRedirects?.nodes ?? []).filter((n: { path: string }) => n.path === path)) {
          await shopifyGraphQL(`mutation ($id: ID!) { urlRedirectDelete(id: $id) { deletedUrlRedirectId userErrors { field message } } }`, { id: n.id });
        }
        const u = await shopifyGraphQL(HANDLE_UPDATE_MUTATION, { product: { id: c.id, handle: c.oldHandle, redirectNewHandle: false } });
        const errs = u.data?.productUpdate?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e: { message: string }) => e.message).join("; "));
      }
      restored++;
      log.push({ isbn: c.isbn, title: c.title, action: HANDLE_LOG_ROLLBACK, status: "success", message: `${c.newHandle} -> ${c.oldHandle}`, shopify_id: c.id, job_id: job.id, user_id: userId });
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${c.newHandle}: ${msg}`);
      log.push({ isbn: c.isbn, title: c.title, action: HANDLE_LOG_ROLLBACK, status: "error", message: `${c.newHandle}: ${msg}`, shopify_id: c.id, job_id: job.id, user_id: userId });
    }
  }
  await insertSyncLog(log);

  // Beskyttede produkter blir stående med ny handle; de regnes ikke som gjenstående.
  // Siste puls ser alle som gjenstår, så protectedKept er da hele listen.
  const remaining = pending.length - restored - skippedProtected;
  const rollbackStatus = protectedKept.length ? "partial" : "full";
  if (!timedOut && remaining === 0) {
    await patchHandleJob(job.id, { result: {
      ...(job.result ?? {}), rolledBackAt: new Date().toISOString(), rollbackStatus, protectedKept,
    } });
  }
  return { jobId: job.id, total: pending.length, restored, failed, skippedProtected, protectedKept, rollbackStatus, remaining, timedOut, errors: errors.slice(0, 20) };
}

// Katalogprodukt til frontend (katalog, katalogsøk). isbn kommer fra extractIsbn —
// handle er ikke lenger ISBN for nye og migrerte bøker.
function toCatalogProduct(node: Record<string, unknown>) {
  const variant = (node.variants as { edges: { node: Record<string, unknown> }[] })?.edges?.[0]?.node ?? {};
  return {
    isbn: extractIsbn(node),
    id: node.id as string,
    handle: node.handle as string,
    title: node.title as string,
    productType: (node.productType as string) ?? "",
    vendor: (node.vendor as string) ?? "",
    status: node.status as string,
    descriptionHtml: (node.descriptionHtml as string) ?? "",
    tags: (node.tags as string[]) ?? [],
    createdAt: (node.createdAt as string) ?? "",
    price: (variant.price as string) ?? "",
    compareAtPrice: (variant.compareAtPrice as string | null) ?? null,
    sku: (variant.sku as string) ?? "",
    barcode: (variant.barcode as string) ?? "",
    variantId: (variant.id as string) ?? "",
    imageUrl: ((node.featuredMedia as { preview?: { image?: { url: string } | null } } | null)?.preview?.image?.url) ?? "",
    seoTitle: ((node.seoTitleMf as { value: string } | null)?.value) ?? "",
    seoDescription: ((node.seoDescMf as { value: string } | null)?.value) ?? "",
    collections: ((node.collections as { edges: { node: { title: string } }[] })?.edges ?? []).map(e => e.node.title),
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/shopify\/?/, "");
    const body = req.method !== "GET" ? await req.json().catch(() => ({})) : {};

    // Verifisert bruker (auth.getUser i _shared/auth.ts), aldri lest rett fra tokenet
    const userId = (await getCaller(req)).userId;
    const bokbasen = await getBokbasenCredentials(userId);

    // POST /shopify/test — verify the server's Shopify connection (Dev Dashboard app,
    // credentials from Supabase secrets). Returns shop name, domain and product count.
    if (path === "test" && req.method === "POST") {
      const result = await shopifyGraphQL(`{ shop { name myshopifyDomain } productsCount(query: "${ALL_PRODUCT_STATUSES}") { count } }`, {});
      return new Response(JSON.stringify({
        success: true,
        shopName: result.data?.shop?.name,
        shopDomain: result.data?.shop?.myshopifyDomain,
        productsCount: result.data?.productsCount?.count ?? 0,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // /shopify/handles/* — handle-migrering (Handles-siden)
    if (path.startsWith("handles/")) {
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      try {
        // GET /handles/status[/:jobId] — butikk, om migrering er tillatt, og siste (eller gitt) kjøring
        if (path.startsWith("handles/status") && req.method === "GET") {
          const jobId = path.split("/")[2] || null;
          const job = jobId ? await getHandleJob(jobId) : await latestHandleJob();
          const shop = await shopifyGraphQL(`{ shop { name myshopifyDomain } }`);
          const refreshed = job ? await refreshHandleJob(job) : null;
          // Radlisten i config er stor og trengs ikke i nettleseren
          if (refreshed?.config) refreshed.config = { ...refreshed.config, rows: undefined };
          return json({
            shopDomain: shop.data?.shop?.myshopifyDomain ?? getShopDomain(),
            shopName: shop.data?.shop?.name ?? null,
            allowed: handleMigrationAllowed(),
            job: refreshed,
          });
        }

        // POST /handles/analyze — tørrkjøring, endrer ingenting
        if (path === "handles/analyze" && req.method === "POST") {
          const result = planHandleMigration(await fetchMigrationProducts());
          return json({ shopDomain: getShopDomain(), allowed: handleMigrationAllowed(), ...result });
        }

        // POST /handles/migrate { productIds?: string[], skipFlagged?: boolean }
        if (path === "handles/migrate" && req.method === "POST") {
          return json(await startHandleMigration(body.productIds, !!body.skipFlagged, userId));
        }

        // GET /handles/verify?jobId=… — kontroller videresendinger
        if (path === "handles/verify" && req.method === "GET") {
          return json(await verifyHandleJob(url.searchParams.get("jobId")));
        }

        // POST /handles/rollback { jobId? } — angre (siste) kjøring, kall igjen så lenge timedOut er true
        if (path === "handles/rollback" && req.method === "POST") {
          return json(await rollbackHandleJob(body.jobId ?? null, userId));
        }
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        throw e;
      }
    }

    // POST /shopify/push — push one book
    if (path === "push" && req.method === "POST") {
      const book: BookMetadata = body.book;
      if (!book?.isbn) return new Response(JSON.stringify({ error: "Missing book data" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const result = await pushOneBook(book, bokbasen, userId);
      return new Response(JSON.stringify({ success: true, ...result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/push-bulk — push multiple books
    if (path === "push-bulk" && req.method === "POST") {
      const books: BookMetadata[] = body.books || [];
      const results = [];
      for (const book of books) {
        try {
          const result = await pushOneBook(book, bokbasen, userId);
          results.push({ isbn: book.isbn, success: true, shopifyId: result.shopifyId, handle: result.handle, created: result.created, warning: result.warning, priceNote: result.priceNote, approvalRequired: result.approvalRequired, availabilityNote: result.availabilityNote, status: result.status, seoNote: result.seoNote, descriptionNote: result.descriptionNote, tagNote: result.tagNote, protectedNote: result.protectedNote });
        } catch (e) {
          results.push({ isbn: book.isbn, success: false, error: String(e) });
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /shopify/analyze-collections — les-bare analyse: tagger, collections, plassering
    if (path === "analyze-collections" && req.method === "GET") {
      const result = await analyzeCollections();
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/sync-collections — tag all Shopify products + create Smart Collections
    if (path === "sync-collections" && req.method === "POST") {
      const result = await fullSyncCollections(bokbasen);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /shopify/count — hent totalt antall produkter med én query
    if (path === "count" && req.method === "GET") {
      const result = await shopifyGraphQL(`{ productsCount(query: "${ALL_PRODUCT_STATUSES}") { count } }`, {});
      const count: number = result.data?.productsCount?.count ?? 0;
      return new Response(JSON.stringify({ count }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/catalog — hent én side av Shopify-katalogen
    if (path === "catalog" && req.method === "POST") {
      const after: string | undefined = body.after || undefined;
      const first = Math.min(body.first || 50, 250);
      const sortKey: string = body.sortKey || "CREATED_AT";
      const reverse: boolean = body.reverse !== undefined ? Boolean(body.reverse) : true;
      const variables: Record<string, unknown> = { first, sortKey, reverse };
      if (after) variables.after = after;

      const result = await shopifyGraphQL(CATALOG_PRODUCTS_QUERY, variables);
      const edges: Array<{ cursor: string; node: Record<string, unknown> }> =
        result.data?.products?.edges ?? [];
      const pageInfo: { hasNextPage: boolean; endCursor: string } =
        result.data?.products?.pageInfo ?? {};

      const products = edges.map(({ node }) => toCatalogProduct(node));

      return new Response(JSON.stringify({ products, pageInfo }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/catalog/search — søk i Shopify-katalogen (tittel, forfatter, ISBN)
    if (path === "catalog/search" && req.method === "POST") {
      const searchQuery: string = (body.query || "").trim();
      if (!searchQuery) {
        return new Response(JSON.stringify({ error: "Mangler søkeord (query)" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Build Shopify search query — title, product_type (author), vendor, handle, and ISBN via barcode/SKU
      const escaped = searchQuery.replace(/"/g, '\\"');
      const shopifyQuery = `(title:*${escaped}* OR product_type:*${escaped}* OR vendor:*${escaped}* OR handle:*${escaped}* OR barcode:${escaped} OR sku:${escaped}) AND (${ALL_PRODUCT_STATUSES})`;
      const after: string | undefined = body.after || undefined;
      const first = Math.min(body.first || 50, 100);

      const SEARCH_QUERY = `
        query SearchProducts($first: Int!, $after: String, $query: String!) {
          products(first: $first, after: $after, query: $query) {
            edges {
              cursor
              node {
                id handle title productType vendor status
                descriptionHtml tags createdAt
                featuredMedia { preview { image { url altText } } }
                variants(first: 1) {
                  edges { node { id price compareAtPrice sku barcode inventoryPolicy } }
                }
                seoTitleMf: metafield(namespace: "global", key: "title_tag") { value }
                seoDescMf: metafield(namespace: "global", key: "description_tag") { value }
                collections(first: 10) { edges { node { title } } }
                ${BOK_ISBN_FIELD}
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `;

      const variables: Record<string, unknown> = { first, query: shopifyQuery };
      if (after) variables.after = after;

      const result = await shopifyGraphQL(SEARCH_QUERY, variables);
      const edges: Array<{ cursor: string; node: Record<string, unknown> }> =
        result.data?.products?.edges ?? [];
      const pageInfo: { hasNextPage: boolean; endCursor: string } =
        result.data?.products?.pageInfo ?? {};

      const products = edges.map(({ node }) => toCatalogProduct(node));

      return new Response(JSON.stringify({ products, pageInfo, query: searchQuery }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/catalog/update — push endringer (tittel, forfatter, pris) for valgte produkter
    if (path === "catalog/update" && req.method === "POST") {
      interface CatalogChange {
        productId: string;
        title?: string;
        productType?: string;
        vendor?: string;
        variantId?: string;
        price?: string;
      }
      const changes: CatalogChange[] = body.changes || [];
      const results: Array<{ productId: string; success: boolean; error?: string }> = [];

      for (const change of changes) {
        try {
          const { productId, title, productType, vendor, variantId, price } = change;

          // Beskyttet (tagg gave/lokal/lokalhistorie/lokallitteratur): heller ikke manuell redigering herfra
          const cur = await shopifyGraphQL(`query ($id: ID!) { product(id: $id) { tags } }`, { id: productId });
          if (!cur.data?.product) throw new Error("Produktet finnes ikke");
          if (protectedTag(cur.data.product.tags)) throw new Error(`${protectedMessage(cur.data.product.tags)}. Rediger i Shopify admin`);

          // Update title / productType / vendor if provided
          if (title !== undefined || productType !== undefined || vendor !== undefined) {
            const input: Record<string, unknown> = { id: productId };
            if (title !== undefined) input.title = title;
            if (productType !== undefined) input.productType = productType;
            if (vendor !== undefined) input.vendor = vendor;
            const updateResult = await shopifyGraphQL(PRODUCT_UPDATE_MUTATION, { product: input });
            const { userErrors } = updateResult.data?.productUpdate ?? {};
            if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
          }

          // Update price if provided — aldri 0 eller lavere
          if (price !== undefined && variantId) {
            if (validPrice(price) === null) throw new Error(`Ugyldig pris (${price}): må være over 0`);
            const varResult = await shopifyGraphQL(VARIANT_UPDATE_MUTATION, {
              productId,
              variants: [{ id: variantId, price }],
            });
            const { userErrors } = varResult.data?.productVariantsBulkUpdate ?? {};
            if (userErrors?.length) throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
          }

          results.push({ productId, success: true });
        } catch (e) {
          results.push({ productId: change.productId, success: false, error: String(e) });
        }

        await new Promise(r => setTimeout(r, 250));
      }

      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/export-csv
    if (path === "export-csv" && req.method === "POST") {
      const books: BookMetadata[] = body.books || [];
      if (!books.length) return new Response(JSON.stringify({ error: "No books provided" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      // Shopify-importen overskriver produktet med samme handle. Bøker der handlen
      // tilhører et beskyttet produkt (tagg gave/lokal/…) tas ikke med i fila.
      const allowed: BookMetadata[] = [];
      let protectedSkipped = 0;
      for (const book of books) {
        const isbn = normalizeIsbn(book.isbn);
        const handle = isbn ? newBookHandle(book, isbn) : book.isbn;
        const r = await shopifyGraphQL(`query ($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { tags } }`, { handle });
        const tags = r.data?.productByIdentifier?.tags;
        if (tags && protectedTag(tags)) {
          protectedSkipped++;
          console.warn(`[export-csv ${handle}] ${protectedMessage(tags)}`);
        } else {
          allowed.push(book);
        }
      }
      const csv = booksToShopifyCSV(allowed);
      return new Response(csv, {
        headers: {
          ...corsHeaders,
          "Access-Control-Expose-Headers": "X-Protected-Skipped",
          "X-Protected-Skipped": String(protectedSkipped),
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="shopify-products-${Date.now()}.csv"`,
        },
      });
    }

    // ── Feed management endpoints ──────────────────────────────────────────────

    // GET /shopify/feeds/list — list all manual collections
    if (path === "feeds/list" && req.method === "GET") {
      const collections = await feedsList();
      return new Response(JSON.stringify(collections), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/get — get collection with products
    if (path === "feeds/get" && req.method === "POST") {
      const { collectionId } = body;
      if (!collectionId) return new Response(JSON.stringify({ error: "collectionId er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const result = await feedGet(collectionId);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/create — create manual collection
    if (path === "feeds/create" && req.method === "POST") {
      const { title } = body;
      if (!title) return new Response(JSON.stringify({ error: "title er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const collection = await feedCreate(title);
      return new Response(JSON.stringify(collection), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/delete — delete collection
    if (path === "feeds/delete" && req.method === "POST") {
      const { collectionId } = body;
      if (!collectionId) return new Response(JSON.stringify({ error: "collectionId er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedDelete(collectionId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/add-products — add products to collection
    if (path === "feeds/add-products" && req.method === "POST") {
      const { collectionId, productIds } = body;
      if (!collectionId || !productIds?.length) return new Response(JSON.stringify({ error: "collectionId og productIds er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedAddProducts(collectionId, productIds);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/remove-products — remove products from collection
    if (path === "feeds/remove-products" && req.method === "POST") {
      const { collectionId, productIds } = body;
      if (!collectionId || !productIds?.length) return new Response(JSON.stringify({ error: "collectionId og productIds er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedRemoveProducts(collectionId, productIds);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/update — update collection (e.g. sortOrder)
    if (path === "feeds/update" && req.method === "POST") {
      const { collectionId, sortOrder } = body;
      if (!collectionId) return new Response(JSON.stringify({ error: "collectionId er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedUpdate(collectionId, { sortOrder });
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/feeds/reorder — reorder products in collection
    if (path === "feeds/reorder" && req.method === "POST") {
      const { collectionId, moves } = body;
      if (!collectionId || !moves?.length) return new Response(JSON.stringify({ error: "collectionId og moves er påkrevd" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      await feedReorderProducts(collectionId, moves);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /shopify/build-menu — bygg megameny i Shopify Navigation
    if (path === "build-menu" && req.method === "POST") {
      const menuHandle: string = body.menuHandle || "kategorier";
      const result = await buildMegaMenu(menuHandle);
      return new Response(JSON.stringify(result), {
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
