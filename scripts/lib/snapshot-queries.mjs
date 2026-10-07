// scripts/lib/snapshot-queries.mjs — bulk-spørringene til scripts/snapshot.mjs og scripts/live-eksport.mjs.
// Samme filformat leses av scripts/snapshot-diff.mjs, så de to må bruke de samme spørringene.
import { ALL_PRODUCT_STATUSES } from "../../supabase/functions/_shared/shopify.ts";

export const SNAPSHOT_PRODUCTS_QUERY = `{
  products(query: "${ALL_PRODUCT_STATUSES}") {
    edges { node {
      id handle title status vendor productType tags createdAt updatedAt publishedAt
      descriptionHtml templateSuffix totalInventory tracksInventory
      category { id fullName }
      seo { title description }
      resourcePublicationsCount { count }
      variants { edges { node {
        id title sku barcode price compareAtPrice inventoryPolicy inventoryQuantity taxable
        selectedOptions { name value }
        inventoryItem { id tracked requiresShipping measurement { weight { value unit } } }
      } } }
      metafields { edges { node { id namespace key type value } } }
      media { edges { node {
        id alt mediaContentType status
        ... on MediaImage { image { url } }
      } } }
    } }
  }
}`;

export const SNAPSHOT_COLLECTIONS_QUERY = `{
  collections {
    edges { node {
      id handle title updatedAt sortOrder templateSuffix descriptionHtml
      seo { title description }
      ruleSet { appliedDisjunctively rules { column relation condition } }
      products { edges { node { id } } }
    } }
  }
}`;

export const SNAPSHOT_REDIRECTS_QUERY = `{
  urlRedirects { edges { node { id path target } } }
}`;

