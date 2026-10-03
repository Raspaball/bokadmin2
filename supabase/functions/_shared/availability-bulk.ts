// supabase/functions/_shared/availability-bulk.ts
// Bulk-modus for tilgjengelighetssjekken (pakke E del 5). Rene funksjoner uten
// API-kall (testes i scripts/availability-bulk.test.mjs):
//   - AVAILABILITY_BULK_QUERY: hele katalogen med bulkOperationRunQuery
//   - availabilityBulkLines: JSONL-linjer for ett produkt ut fra planen
//     (planAvailability i availability.ts): productVariantsBulkUpdate for
//     CONTINUE / sporing av og productUpdate for status + metafelt
// Driveren er runBulkJob() i bulk-job.ts. Beskyttede produkter gir aldri en linje.

import { ALL_PRODUCT_STATUSES } from "./shopify.ts";
import { availabilityMetafields, type AvailabilityPlan, type AvailabilityRule } from "./availability.ts";
import { protectedProduct, type ProtectableProduct } from "./protected.ts";

export const AVAILABILITY_BULK_QUERY = `{
  products(query: "${ALL_PRODUCT_STATUSES}") {
    edges { node {
      __typename id title handle status tags vendor totalInventory
      bokIsbn: metafield(namespace: "bok", key: "isbn") { value }
      tilgjengelighet: metafield(namespace: "bok", key: "tilgjengelighet") { value }
      utgivelsesdato: metafield(namespace: "bok", key: "utgivelsesdato") { value }
      egenTilgjengelighet: metafield(namespace: "bok", key: "egen_tilgjengelighet") { value }
      variants(first: 1) { edges { node { __typename id barcode sku inventoryPolicy inventoryItem { tracked } } } }
    } }
  }
}`;

/** Feltene ONIX-fasen trenger (ISBN, beskyttet med tagg/leverandør/samling, arkivert) */
export const AVAILABILITY_SLIM_FIELDS = ["id", "handle", "status", "tags", "vendor", "bokIsbn"] as const;

export const AVAILABILITY_BULK_PRODUCT_MUTATION = `mutation availabilityBulkProduct($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id } userErrors { field message } }
}`;

export const AVAILABILITY_BULK_VARIANT_MUTATION = `mutation availabilityBulkVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } }
}`;

export interface AvailabilityBulkLines {
  /** inventoryPolicy CONTINUE og/eller sporing av (kjøres før produktlinjen, slik at boka er kjøpbar når den blir aktiv) */
  variant: { productId: string; variants: Array<{ id: string; inventoryPolicy?: "CONTINUE"; inventoryItem?: { tracked: false } }> } | null;
  /** status og bok.tilgjengelighet / bok.utgivelsesdato i samme productUpdate */
  product: { product: Record<string, unknown> } | null;
}

/**
 * JSONL-linjene for ett produkt. Bare feltene i plan.changes skrives (med egen
 * tilgjengelighet er det bare utgivelsesdatoen). Beskyttet → ingen linjer.
 */
export function availabilityBulkLines(
  product: ProtectableProduct & { id: string; variants?: { nodes: Array<{ id?: string }> } },
  rule: AvailabilityRule,
  date: string | null,
  plan: AvailabilityPlan,
): AvailabilityBulkLines {
  const none = { variant: null, product: null };
  if (protectedProduct(product)) return none;
  const c = plan.changes;
  const variantId = product.variants?.nodes?.[0]?.id;
  // CONTINUE og/eller sporing av i samme variantlinje (pakke G del 2: ingen bok spores)
  const variant = (c.continuePolicy || c.untrack) && variantId
    ? {
      productId: product.id,
      variants: [{
        id: variantId,
        ...(c.continuePolicy ? { inventoryPolicy: "CONTINUE" as const } : {}),
        ...(c.untrack ? { inventoryItem: { tracked: false as const } } : {}),
      }],
    }
    : null;
  const metafields = availabilityMetafields(product.id, rule, c.utgivelsesdato ? date : null, !!c.tilgjengelighet)
    .map(({ ownerId: _o, ...m }) => m);
  const fields: Record<string, unknown> = {
    ...(c.status ? { status: c.status.to } : {}),
    ...(metafields.length ? { metafields } : {}),
  };
  return { variant, product: Object.keys(fields).length ? { product: { id: product.id, ...fields } } : null };
}
