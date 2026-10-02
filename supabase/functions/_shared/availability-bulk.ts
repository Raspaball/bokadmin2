// supabase/functions/_shared/availability-bulk.ts
// Bulk-modus for tilgjengelighetssjekken (pakke E del 5). Rene funksjoner uten
// API-kall (testes i scripts/availability-bulk.test.mjs):
//   - AVAILABILITY_BULK_QUERY: hele katalogen med bulkOperationRunQuery
//   - availabilityBulkLines: JSONL-linjer for ett produkt ut fra planen
//     (planAvailability i availability.ts): productVariantsBulkUpdate for
//     CONTINUE og productUpdate for status + metafelt
// Driveren er runBulkJob() i bulk-job.ts. Beskyttede produkter gir aldri en linje.

import { ALL_PRODUCT_STATUSES } from "./shopify.ts";
import { availabilityMetafields, type AvailabilityPlan, type AvailabilityRule } from "./availability.ts";
import { protectedTag } from "./protected.ts";

export const AVAILABILITY_BULK_QUERY = `{
  products(query: "${ALL_PRODUCT_STATUSES}") {
    edges { node {
      __typename id title handle status tags
      bokIsbn: metafield(namespace: "bok", key: "isbn") { value }
      tilgjengelighet: metafield(namespace: "bok", key: "tilgjengelighet") { value }
      utgivelsesdato: metafield(namespace: "bok", key: "utgivelsesdato") { value }
      egenTilgjengelighet: metafield(namespace: "bok", key: "egen_tilgjengelighet") { value }
      variants(first: 1) { edges { node { __typename id barcode sku inventoryPolicy inventoryItem { tracked } } } }
    } }
  }
}`;

/** Feltene ONIX-fasen trenger (ISBN, beskyttet, arkivert) */
export const AVAILABILITY_SLIM_FIELDS = ["id", "handle", "status", "tags", "bokIsbn"] as const;

export const AVAILABILITY_BULK_PRODUCT_MUTATION = `mutation availabilityBulkProduct($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id } userErrors { field message } }
}`;

export const AVAILABILITY_BULK_VARIANT_MUTATION = `mutation availabilityBulkVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } }
}`;

export interface AvailabilityBulkLines {
  /** inventoryPolicy CONTINUE (kjøres før produktlinjen, slik at boka er kjøpbar når den blir aktiv) */
  variant: { productId: string; variants: Array<{ id: string; inventoryPolicy: "CONTINUE" }> } | null;
  /** status og bok.tilgjengelighet / bok.utgivelsesdato i samme productUpdate */
  product: { product: Record<string, unknown> } | null;
}

/**
 * JSONL-linjene for ett produkt. Bare feltene i plan.changes skrives (med egen
 * tilgjengelighet er det bare utgivelsesdatoen). Beskyttet → ingen linjer.
 */
export function availabilityBulkLines(
  product: { id: string; tags?: readonly string[] | null; variants?: { nodes: Array<{ id?: string }> } },
  rule: AvailabilityRule,
  date: string | null,
  plan: AvailabilityPlan,
): AvailabilityBulkLines {
  const none = { variant: null, product: null };
  if (protectedTag(product.tags)) return none;
  const c = plan.changes;
  const variantId = product.variants?.nodes?.[0]?.id;
  const variant = c.continuePolicy && variantId
    ? { productId: product.id, variants: [{ id: variantId, inventoryPolicy: "CONTINUE" as const }] }
    : null;
  const metafields = availabilityMetafields(product.id, rule, c.utgivelsesdato ? date : null, !!c.tilgjengelighet)
    .map(({ ownerId: _o, ...m }) => m);
  const fields: Record<string, unknown> = {
    ...(c.status ? { status: c.status.to } : {}),
    ...(metafields.length ? { metafields } : {}),
  };
  return { variant, product: Object.keys(fields).length ? { product: { id: product.id, ...fields } } : null };
}
