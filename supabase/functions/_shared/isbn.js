/* @ts-self-types="./isbn.d.ts" */
// supabase/functions/_shared/isbn.js
// Felles regel for å finne ISBN på et Shopify-produkt.
//
// Brukes av price-update, availability-check, sjangre-sync, shopify
// (samlingsanalyse/sync-collections og handle-migrering) og
// scripts/migrate-handles.mjs. Handle kan ikke lenger brukes som ISBN, fordi
// nye produkter har handle på formen tittel-forfatter-ISBN.
//
// Rekkefølge: metafeltet bok.isbn → strekkode → SKU → handle (bare hvis
// handle i seg selv er et gyldig ISBN, slik eldre produkter har).
// Returnerer alltid ISBN-13 (bare sifre), eller null.

import { normalizeIsbn } from "./handle.js";

/**
 * GraphQL-felt som extractIsbn leser metafeltet fra. Ta det med i
 * products-spørringer: `node { id handle ${BOK_ISBN_FIELD} variants … }`.
 */
export const BOK_ISBN_FIELD = `bokIsbn: metafield(namespace: "bok", key: "isbn") { value }`;

/** Handle som bare består av et ISBN (eldre produkter), f.eks. 9788203461392. */
const ISBN_ONLY = /^[\dXx-]{10,17}$/;

/**
 * @param {any} product Shopify-produkt med `bokIsbn`, `handle` og
 *   `variants` (enten `{ edges: [{ node }] }` eller `{ nodes: [...] }`).
 *   Varianten kan ha `barcode`, `sku` og/eller `inventoryItem { sku }`.
 * @returns {string | null}
 */
export function extractIsbn(product) {
  if (!product) return null;
  const variant = product.variants?.edges?.[0]?.node ?? product.variants?.nodes?.[0] ?? null;
  const handle = product.handle && ISBN_ONLY.test(product.handle) ? product.handle : null;
  return normalizeIsbn(product.bokIsbn?.value)
    || normalizeIsbn(variant?.barcode)
    || normalizeIsbn(variant?.sku)
    || normalizeIsbn(variant?.inventoryItem?.sku)
    || normalizeIsbn(handle);
}
