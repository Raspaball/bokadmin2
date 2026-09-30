/* @ts-self-types="./handle-migration.d.ts" */
// supabase/functions/_shared/handle-migration.js
// Planlegging av handle-migrering: ISBN-handle → tittel-forfatter-ISBN.
//
// Ren funksjon uten API-kall. Brukes av BÅDE shopify-funksjonen
// (POST /shopify/handles/analyze og /migrate) og scripts/migrate-handles.mjs,
// slik at nettsiden og skriptet lager nøyaktig samme plan.
//
// Handle-regelen ligger i handle.js, ISBN-regelen i isbn.js.

import { buildBookHandle } from "./handle.js";
import { BOK_ISBN_FIELD, extractIsbn } from "./isbn.js";

/** Butikker migreringen alltid kan kjøres mot. Andre krever eksplisitt samtykke. */
export const SAFE_STORES = ["testbutikk-9434.myshopify.com"];

/** Produktspørring med alle feltene planen trenger. Variabel: $cursor. */
export const MIGRATION_PRODUCTS_QUERY = `
query Products($cursor: String) {
  products(first: 250, after: $cursor, query: "status:active OR status:draft OR status:archived") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title productType status
      forfatter: metafield(namespace: "bok", key: "forfatter") { value }
      ${BOK_ISBN_FIELD}
      variants(first: 1) { nodes { barcode sku } }
    }
  }
}`;

/** Mutasjonen hver planrad utføres med (direkte eller i en bulk-operasjon). */
export const HANDLE_UPDATE_MUTATION = `
mutation ($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id handle }
    userErrors { field message }
  }
}`;

export const FLAG_MISSING_AUTHOR = "mangler forfatter";
export const FLAG_LONG_HANDLE = "lang handle";
export const FLAG_DUPLICATE_ISBN = "DUPLIKAT: samme ISBN på flere produkter";
export const FLAG_DUPLICATE_IN_PLAN = "DUPLIKAT i planen";
export const FLAG_HANDLE_TAKEN = "handle finnes allerede";

/** Merknader som stopper en rad: duplikat-ISBN og kollisjoner. */
export function isBlockingFlag(flag) {
  return flag.startsWith("DUPLIKAT") || flag === FLAG_HANDLE_TAKEN;
}

/** @param {{ flags: string[] }} row */
export function isBlockedRow(row) {
  return row.flags.some(isBlockingFlag);
}

/** Handle som bare er et ISBN (produkter opprettet av eldre Bokadmin). */
export function isIsbnHandle(handle) {
  return /^\d{10,13}$/.test(handle ?? "");
}

/**
 * Lager planen for hvilke produkter som skal få ny handle.
 *
 * @param {any[]} products Produkter fra MIGRATION_PRODUCTS_QUERY (nodes).
 * @param {{ includeCustom?: boolean, limit?: number }} [options]
 *   includeCustom: ta med produkter som har egendefinert handle (ikke ISBN).
 * @returns {{
 *   total: number,
 *   plan: Array<{ id: string, status: string, title: string, author: string, isbn: string,
 *                 oldHandle: string, newHandle: string, flags: string[], setIsbn: boolean }>,
 *   skipped: { ingenIsbn: number, alleredeRiktig: number, egendefinert: number },
 *   counts: { planned: number, withFlags: number, blocked: number, missingAuthor: number, ready: number },
 * }}
 */
export function planHandleMigration(products, { includeCustom = false, limit = Infinity } = {}) {
  const existing = new Set(products.map((p) => p.handle));
  const plan = [];
  const skipped = { ingenIsbn: 0, alleredeRiktig: 0, egendefinert: 0 };

  // ISBN per produkt, og hvor mange produkter som deler hvert ISBN
  const isbnById = new Map();
  const byIsbn = new Map();
  for (const p of products) {
    const isbn = extractIsbn(p);
    isbnById.set(p.id, isbn);
    if (isbn) byIsbn.set(isbn, (byIsbn.get(isbn) ?? 0) + 1);
  }

  for (const p of products) {
    if (plan.length >= limit) break;
    const isbn = isbnById.get(p.id);
    if (!isbn) { skipped.ingenIsbn++; continue; }
    const authors = p.forfatter?.value || p.productType;
    const newHandle = buildBookHandle({ title: p.title, authors, isbn });
    if (!newHandle || newHandle === p.handle) { skipped.alleredeRiktig++; continue; }
    if (!isIsbnHandle(p.handle) && !includeCustom) { skipped.egendefinert++; continue; }
    const flags = [];
    if (!authors) flags.push(FLAG_MISSING_AUTHOR);
    if (newHandle.length > 120) flags.push(FLAG_LONG_HANDLE);
    if (byIsbn.get(isbn) > 1) flags.push(FLAG_DUPLICATE_ISBN);
    plan.push({
      id: p.id, status: p.status, title: p.title, author: authors || "", isbn,
      oldHandle: p.handle, newHandle, flags,
      // bok.isbn settes i samme kall, slik at eksporten finner produktet på ISBN
      setIsbn: !p.bokIsbn?.value,
    });
  }

  // Kollisjoner: to rader med samme nye handle, eller ny handle som allerede er i bruk
  const seen = new Map();
  for (const row of plan) {
    const first = seen.get(row.newHandle);
    if (first) {
      if (!row.flags.includes(FLAG_DUPLICATE_IN_PLAN)) row.flags.push(FLAG_DUPLICATE_IN_PLAN);
      if (!first.flags.includes(FLAG_DUPLICATE_IN_PLAN)) first.flags.push(FLAG_DUPLICATE_IN_PLAN);
    } else {
      seen.set(row.newHandle, row);
    }
    if (existing.has(row.newHandle)) row.flags.push(FLAG_HANDLE_TAKEN);
  }

  const blocked = plan.filter(isBlockedRow).length;
  return {
    total: products.length,
    plan,
    skipped,
    counts: {
      planned: plan.length,
      withFlags: plan.filter((r) => r.flags.length).length,
      blocked,
      missingAuthor: plan.filter((r) => r.flags.includes(FLAG_MISSING_AUTHOR)).length,
      ready: plan.length - blocked,
    },
  };
}

/**
 * Input til productUpdate for én planrad. Gammel adresse får 301 til ny
 * (redirectNewHandle). bok.isbn settes hvis produktet mangler det.
 * @param {{ id: string, newHandle: string, isbn: string, setIsbn?: boolean }} row
 */
export function handleUpdateInput(row) {
  const product = { id: row.id, handle: row.newHandle, redirectNewHandle: true };
  if (row.setIsbn) product.metafields = [{ namespace: "bok", key: "isbn", value: row.isbn }];
  return product;
}
