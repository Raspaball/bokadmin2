// supabase/functions/_shared/book-bulk.ts
// Bulk-modus for «Oppdater eksisterende bøker» (pakke D del 3). Rene funksjoner
// uten API-kall (testes i scripts/book-bulk.test.mjs):
//   - BULK_PRODUCTS_QUERY: hele katalogen med bulkOperationRunQuery
//   - BulkProductAssembler: JSONL-linjer fra bulk-spørringen → produkter i samme
//     form som book-update-jobben leser (media.nodes, variants.nodes, mf_*-aliaser)
//   - bulkUpdateLine / bulkCoverLine: én JSONL-linje per produkt til
//     bulkOperationRunMutation (productUpdate med metafelt, og fileUpdate for omslaget)
//   - parseBulkResult: resultatfila fra Shopify → ok/feil per linje
// Reglene ligger i planBookUpdate() (_shared/book-update.ts); her bygges bare filene.
// Beskyttede produkter (_shared/protected.ts) gir aldri en linje.

import { BOOK_METAFIELD_KEYS, type BookUpdatePlan, type ShopifyBookProduct } from "./book-update.ts";
import { protectedTag } from "./protected.ts";

/**
 * Bulk-spørring med de samme feltene som BOOK_UPDATE_PRODUCT_FIELDS + ISBN-feltene.
 * Bulk krever edges/node; nestede tilkoblinger kommer som egne linjer med __parentId.
 */
export const BULK_PRODUCTS_QUERY = `{
  products(query: "status:active OR status:draft OR status:archived") {
    edges { node {
      __typename id handle title productType tags descriptionHtml
      category { id }
      ${BOOK_METAFIELD_KEYS.map((k) => `mf_${k}: metafield(namespace: "bok", key: "${k}") { value }`).join("\n      ")}
      bokIsbn: metafield(namespace: "bok", key: "isbn") { value }
      seoTitleMf: metafield(namespace: "global", key: "title_tag") { value }
      seoDescMf: metafield(namespace: "global", key: "description_tag") { value }
      seoAuto: metafield(namespace: "bokadmin", key: "seo_auto") { value }
      media(first: 1) { edges { node { __typename id alt ... on MediaImage { image { url } } } } }
      variants(first: 1) { edges { node { __typename id barcode sku } } }
    } }
  }
}`;

export const BULK_PRODUCT_UPDATE_MUTATION = `mutation bookBulkProduct($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id } userErrors { field message } }
}`;

export const BULK_COVER_MUTATION = `mutation bookBulkCover($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) { files { id } userErrors { field message code } }
}`;

export type BulkProduct = ShopifyBookProduct & {
  bokIsbn?: { value: string } | null;
  variants: { nodes: Array<{ id?: string; barcode: string | null; sku: string | null }> };
  media: { nodes: Array<{ id: string; alt?: string | null; image?: { url: string } | null }> };
};

/**
 * Setter sammen produkter fra bulk-spørringens JSONL, linje for linje (strømming).
 * Barn (media, varianter) kommer etter forelderen. `keep(index)` avgjør hvilke
 * produkter som tas vare på (f.eks. bare en del av katalogen per puls), så
 * minnebruken holder seg lav for store kataloger.
 */
export class BulkProductAssembler {
  /** Antall produktlinjer sett så langt (indeks for neste produkt) */
  count = 0;
  readonly products: BulkProduct[] = [];
  private readonly byId = new Map<string, BulkProduct>();
  /**
   * @param keep hvilke produkter (indeks) som tas vare på
   * @param slim behold bare id, handle, tagger og ISBN-feltene (for ONIX-fasen)
   */
  private readonly keep: (index: number) => boolean;
  private readonly slim: boolean;
  constructor(keep: (index: number) => boolean = () => true, slim = false) {
    this.keep = keep;
    this.slim = slim;
  }

  add(line: string): void {
    const t = line.trim();
    if (!t) return;
    // deno-lint-ignore no-explicit-any
    const o = JSON.parse(t) as any;
    if (!o.__parentId) {
      const index = this.count++;
      if (!this.keep(index)) return;
      delete o.__typename;
      const base = this.slim ? { id: o.id, handle: o.handle, tags: o.tags, bokIsbn: o.bokIsbn } : o;
      const p = { ...base, media: { nodes: [] }, variants: { nodes: [] } } as BulkProduct;
      this.products.push(p);
      this.byId.set(p.id, p);
      return;
    }
    const parent = this.byId.get(o.__parentId);
    if (!parent) return;
    const { __parentId: _p, __typename: type, ...node } = o;
    if (type === "ProductVariant" || (!type && ("barcode" in node || "sku" in node))) {
      if (!parent.variants.nodes.length) parent.variants.nodes.push(node);
    } else if (!this.slim && !parent.media.nodes.length) {
      parent.media.nodes.push(node);
    }
  }
}

/** Alle linjene i en tekst (for tester og små filer). */
export function assembleBulkProducts(text: string, keep?: (index: number) => boolean): BulkProduct[] {
  const a = new BulkProductAssembler(keep);
  for (const line of text.split("\n")) a.add(line);
  return a.products;
}

/**
 * JSONL-linje til productUpdate: produktfeltene og metafeltene (bok.*, SEO,
 * bokadmin.seo_auto) i ett kall. null når planen ikke endrer noe på produktet,
 * eller produktet er beskyttet.
 */
export function bulkUpdateLine(product: { id: string; tags?: readonly string[] | null }, plan: BookUpdatePlan): { product: Record<string, unknown> } | null {
  if (protectedTag(product.tags)) return null;
  const metafields = plan.metafields.map(({ ownerId: _o, ...m }) => m);
  if (!Object.keys(plan.product).length && !metafields.length) return null;
  return { product: { id: product.id, ...plan.product, ...(metafields.length ? { metafields } : {}) } };
}

/** JSONL-linje til fileUpdate (alt-tekst/filnavn på omslaget), eller null. */
export function bulkCoverLine(product: { tags?: readonly string[] | null }, plan: BookUpdatePlan): { files: Array<Record<string, unknown>> } | null {
  if (protectedTag(product.tags) || !plan.cover) return null;
  return { files: [{ id: plan.cover.mediaId, ...plan.cover.change }] };
}

export interface BulkLineResult {
  line: number;
  ok: boolean;
  error?: string;
}

/**
 * Resultatfila fra en bulk-mutasjon: én linje per inndatalinje (__lineNumber, fra 0).
 * Linjer som mangler i fila (f.eks. ved partialDataUrl) regnes som feil av kalleren.
 */
export function parseBulkResult(text: string, field: "productUpdate" | "fileUpdate"): BulkLineResult[] {
  const out: BulkLineResult[] = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    // deno-lint-ignore no-explicit-any
    const o = JSON.parse(t) as any;
    const line = Number(o.__lineNumber);
    if (!Number.isInteger(line)) continue;
    const errs: Array<{ message: string }> = [
      ...(o.errors ?? []),
      ...(o.data?.[field]?.userErrors ?? []),
    ];
    if (!o.data?.[field] && !errs.length) errs.push({ message: "tomt svar" });
    out.push(errs.length ? { line, ok: false, error: errs.map((e) => e.message).join("; ") } : { line, ok: true });
  }
  return out;
}

/** Linjene som JSONL-tekst. */
export function toJsonl(lines: readonly unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}
