// supabase/functions/_shared/duplicates.ts
// Duplikater: samme ISBN på flere produkter (pakke D del 3b). Rene funksjoner
// (Deno og Node, testes i scripts/duplicates.test.mjs):
//   - DuplicateScan: teller ISBN over hele katalogen, side for side (kan fortsette over pulser)
//   - groupDuplicates: ISBN med mer enn ett produkt
//   - decideDuplicate: hvilket som beholdes (ordrer, ellers eldst) og hvilke som skal bort
//   - tagsToMerge: tagger fra duplikatet som legges til på produktet som beholdes
// Jobbene hopper over ISBN i duplikatlisten til de er ryddet («Hoppet over: DUPLIKAT …»).
// Bokadmin sletter aldri produkter; det gjør Eirik i Shopify admin.

import { extractIsbn } from "./isbn.js";
import { cleanBookTags } from "./book-tags.ts";
import { protectedTag } from "./protected.ts";

/** Felt skanningen trenger per produkt (id, handle og ISBN-feltene). */
export const DUPLICATE_SCAN_FIELDS = `id handle bokIsbn: metafield(namespace: "bok", key: "isbn") { value } variants(first: 1) { nodes { barcode sku } }`;

export interface DuplicateScanState {
  cursor: string | null;
  done: boolean;
  /** ISBN → antall produkter (bare så lenge skanningen pågår) */
  counts: Record<string, number>;
}

export function emptyDuplicateScan(): DuplicateScanState {
  return { cursor: null, done: false, counts: {} };
}

/** Legger én side produkter inn i skanningen. */
export function addToScan(state: DuplicateScanState, products: Array<Record<string, unknown>>, endCursor: string | null, hasNextPage: boolean): void {
  for (const p of products) {
    const isbn = extractIsbn(p);
    if (isbn) state.counts[isbn] = (state.counts[isbn] ?? 0) + 1;
  }
  state.cursor = endCursor;
  state.done = !hasNextPage;
}

/** ISBN → antall produkter, bare for ISBN med mer enn ett produkt. */
export function duplicateCounts(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [isbn, n] of Object.entries(counts)) if (n > 1) out[isbn] = n;
  return out;
}

// deno-lint-ignore no-explicit-any
type Gql = (query: string, variables?: Record<string, unknown>) => Promise<{ data: any }>;

/**
 * Skanner katalogen side for side til `deadline` (ms). Kan fortsette i neste
 * puls med samme state. `gql` er shopifyGraphQL (Deno) eller en tilsvarende funksjon.
 */
export async function runDuplicateScan(gql: Gql, state: DuplicateScanState, deadline: number, pageSize = 250): Promise<void> {
  while (!state.done && Date.now() < deadline) {
    const { data } = await gql(
      `query ($first: Int!, $after: String) { products(first: $first, after: $after, query: "status:active OR status:draft OR status:archived") { pageInfo { hasNextPage endCursor } nodes { ${DUPLICATE_SCAN_FIELDS} } } }`,
      { first: pageSize, after: state.cursor },
    );
    addToScan(state, data.products.nodes, data.products.pageInfo.endCursor, data.products.pageInfo.hasNextPage);
  }
}

/** «Hoppet over: DUPLIKAT (samme ISBN på 2 produkter)» */
export function duplicateMessage(count: number): string {
  return `Hoppet over: DUPLIKAT (samme ISBN på ${count} produkter)`;
}

export interface DuplicateProduct {
  id: string;
  handle: string;
  title: string;
  status: string;
  createdAt: string | null;
  productType?: string | null;
  tags: string[];
  forfatter?: string[];
  /** Antall ordrer, eller null når appen ikke kan lese ordrer */
  orders: number | null;
}

export interface DuplicateGroup<P> {
  isbn: string;
  products: P[];
}

/** Grupper produkter på ISBN; bare ISBN med mer enn ett produkt. */
export function groupDuplicates<P extends Record<string, unknown>>(products: P[]): DuplicateGroup<P>[] {
  const by = new Map<string, P[]>();
  for (const p of products) {
    const isbn = extractIsbn(p);
    if (!isbn) continue;
    if (!by.has(isbn)) by.set(isbn, []);
    by.get(isbn)!.push(p);
  }
  return [...by].filter(([, ps]) => ps.length > 1).map(([isbn, ps]) => ({ isbn, products: ps }));
}

export interface DuplicateDecision {
  keepId: string | null;
  deleteIds: string[];
  /** Hvorfor, og ting Eirik må se på */
  reason: string;
  flags: string[];
  /** false: ingenting gjøres automatisk (beskyttet produkt i gruppen) */
  automatic: boolean;
}

const time = (p: DuplicateProduct) => (p.createdAt ? Date.parse(p.createdAt) : Number.POSITIVE_INFINITY);

/**
 * Regel (foreslått, Eirik bekrefter): behold produktet med ordrer; har ingen
 * ordrer (eller ordrene er ukjente), behold det eldste. Er et av produktene
 * beskyttet, gjøres ingenting automatisk.
 */
export function decideDuplicate(products: DuplicateProduct[]): DuplicateDecision {
  const flags: string[] = [];
  const prot = products.filter((p) => protectedTag(p.tags));
  if (prot.length) {
    return {
      keepId: null, deleteIds: [], automatic: false,
      reason: `beskyttet (tagg: ${protectedTag(prot[0].tags)}): Eirik avgjør`,
      flags: ["beskyttet"],
    };
  }
  const byAge = [...products].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
  const known = products.every((p) => p.orders !== null);
  // Uten dato (f.eks. fra en CSV-eksport) og uten ordrer finnes det ikke noe grunnlag
  if (!known && products.some((p) => !p.createdAt)) {
    return { keepId: null, deleteIds: [], automatic: false, reason: "dato og ordrer ukjent: Eirik avgjør", flags: ["dato ukjent", "ordrer ukjent"] };
  }
  let keep: DuplicateProduct;
  let reason: string;
  if (!known) {
    keep = byAge[0];
    reason = "eldst (ordrer ukjent)";
    flags.push("ordrer ukjent");
  } else {
    const withOrders = products.filter((p) => (p.orders ?? 0) > 0);
    if (withOrders.length === 0) {
      keep = byAge[0];
      reason = "eldst (ingen har ordrer)";
    } else {
      keep = [...withOrders].sort((a, b) => (b.orders! - a.orders!) || (time(a) - time(b)))[0];
      reason = withOrders.length > 1 ? `flest ordrer (${keep.orders})` : `har ordrer (${keep.orders})`;
      if (withOrders.length > 1) flags.push("flere har ordrer");
    }
  }
  if (products.filter((p) => p.status === "ACTIVE").length > 1) flags.push("flere er aktive");
  return { keepId: keep.id, deleteIds: products.filter((p) => p.id !== keep.id).map((p) => p.id), reason, flags, automatic: true };
}

/**
 * Tagger fra duplikatet som legges til på produktet som beholdes: bkg-* og andre
 * egne tagger, men ikke tittel- og forfatterbiter (samme regel som cleanBookTags).
 * Bare tillegg: ingenting fjernes fra produktet som beholdes.
 */
export function tagsToMerge(keep: DuplicateProduct, other: DuplicateProduct): string[] {
  const authorTexts = [keep.productType, other.productType].filter((s): s is string => !!s);
  const { tags: kept } = cleanBookTags(other.tags, { title: other.title, authors: keep.forfatter ?? [], authorTexts });
  // Tittelen på produktet som beholdes kan være en annen skrivemåte
  const { tags: kept2 } = cleanBookTags(kept, { title: keep.title, authors: other.forfatter ?? [], authorTexts });
  const have = new Set(keep.tags.map((t) => t.trim().toLowerCase()));
  return kept2.filter((t) => !have.has(t.trim().toLowerCase()) && !protectedTag([t]));
}
