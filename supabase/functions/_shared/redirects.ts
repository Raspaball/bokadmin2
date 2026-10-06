// supabase/functions/_shared/redirects.ts
// Videresending for arkiverte bøker (pakke H del 3b). Shopify bruker en URL-videresending bare når
// adressen gir 404, så en videresending fra /products/{handle} gjør ingen skade hvis boka senere
// blir aktiv igjen (da slettes den uansett).
//
//   Kode 41 (erstattet): til den nye utgaven hvis ONIX har RelatedProduct 05 og den finnes som aktiv bok.
//   Ellers: til samlingen for bokas bokgruppe (bok.bokgruppe) hvis samlingen finnes.
//   Ellers: ingen videresending, bare liste.
//   Ingen kjeder: /products/{ISBN} (fra handle-migreringen) peker rett til det nye målet.
//   Beskyttede røres aldri. Utkast uten disse kodene (40, 42, 44) får ikke videresending.
//
// Rene funksjoner øverst (testes i scripts/redirects.test.mjs), Shopify-kallene nederst.

import { shopifyGraphQL } from "./shopify.ts";
import { protectedProduct, type ProtectableProduct } from "./protected.ts";

/** ONIX List 65-koder som gir videresending (kode 41 = erstattet av ny utgave) */
export const REDIRECT_CODES: readonly string[] = Object.freeze(["41", "43", "46", "47", "48", "49"]);

export type RedirectKind = "erstatning" | "samling" | "ingen";

export interface RedirectTarget {
  kind: RedirectKind;
  /** «/products/{handle}» eller «/collections/bkg-{kode}»; null når kind er «ingen» */
  target: string | null;
  /** Hvorfor «ingen» (eller hva målet er), til loggen */
  note: string;
}

export interface RedirectCandidate extends ProtectableProduct {
  id: string;
  handle: string;
  status?: string | null;
}

/** Skal denne boka ha en videresending fra handlen? (kode fra ONIX, status etter jobben) */
export function wantsRedirect(product: RedirectCandidate, code: string | null | undefined, statusAfter: string): boolean {
  if (protectedProduct(product)) return false;
  if (statusAfter === "ACTIVE") return false;
  return REDIRECT_CODES.includes(String(code ?? "").trim());
}

/**
 * Målet for en bok som ikke lenger selges.
 * @param replacement handle til den nye utgaven når den finnes som aktiv bok i butikken, ellers null
 * @param bokgruppe bok.bokgruppe («417»)
 * @param collections handler til samlingene som finnes i butikken
 */
export function chooseRedirectTarget(
  code: string | null | undefined,
  replacement: string | null,
  bokgruppe: string | null | undefined,
  collections: ReadonlySet<string>,
): RedirectTarget {
  if (String(code ?? "").trim() === "41" && replacement) {
    return { kind: "erstatning", target: `/products/${replacement}`, note: "ny utgave" };
  }
  const kode = String(bokgruppe ?? "").trim();
  if (!kode) return { kind: "ingen", target: null, note: "mangler bokgruppe" };
  const handle = `bkg-${kode}`;
  if (!collections.has(handle)) return { kind: "ingen", target: null, note: `samlingen ${handle} finnes ikke` };
  return { kind: "samling", target: `/collections/${handle}`, note: handle };
}

export interface RedirectRow { id: string; path: string; target: string }

export type RedirectOp =
  | { op: "create"; path: string; target: string }
  | { op: "update"; id: string; path: string; target: string; from: string }
  | { op: "delete"; id: string; path: string; from: string };

/** ISBN-adressen fra handle-migreringen: /products/{ISBN-13} */
export const isbnPath = (isbn: string) => `/products/${isbn}`;
export const handlePath = (handle: string) => `/products/${handle}`;

/**
 * Hva som må gjøres for at handlen og ISBN-adressen begge peker rett til `target` (ingen kjeder):
 * handle-adressen opprettes eller oppdateres, en eksisterende ISBN-videresending oppdateres.
 * @param existing videresendingene som finnes for handle- og ISBN-adressen (andre ignoreres)
 */
export function planRedirect(handle: string, isbn: string | null, target: string, existing: readonly RedirectRow[]): RedirectOp[] {
  const ops: RedirectOp[] = [];
  const byPath = new Map(existing.map((r) => [r.path, r]));
  const h = byPath.get(handlePath(handle));
  if (!h) ops.push({ op: "create", path: handlePath(handle), target });
  else if (h.target !== target) ops.push({ op: "update", id: h.id, path: h.path, target, from: h.target });
  const i = isbn ? byPath.get(isbnPath(isbn)) : undefined;
  if (i && i.target !== target) ops.push({ op: "update", id: i.id, path: i.path, target, from: i.target });
  return ops;
}

/**
 * Boka er aktiv igjen: videresendingen fra handlen slettes, og ISBN-adressen peker tilbake til boka.
 */
export function planRemoveRedirect(handle: string, isbn: string | null, existing: readonly RedirectRow[]): RedirectOp[] {
  const ops: RedirectOp[] = [];
  const byPath = new Map(existing.map((r) => [r.path, r]));
  const h = byPath.get(handlePath(handle));
  if (h) ops.push({ op: "delete", id: h.id, path: h.path, from: h.target });
  const i = isbn ? byPath.get(isbnPath(isbn)) : undefined;
  if (i && i.target !== handlePath(handle)) ops.push({ op: "update", id: i.id, path: i.path, target: handlePath(handle), from: i.target });
  return ops;
}

/** «ISBN-adressen» og «handle-adressen» er de eneste videresendingene vi rører; resten av butikkens videresendinger står. */
export const isOwnPath = (path: string, handle: string, isbn: string | null) => path === handlePath(handle) || (!!isbn && path === isbnPath(isbn));

// ── Shopify ──────────────────────────────────────────────────────────────────

export const URL_REDIRECT_CREATE = `mutation redirectCreate($r: UrlRedirectInput!) {
  urlRedirectCreate(urlRedirect: $r) { urlRedirect { id } userErrors { field message code } }
}`;
export const URL_REDIRECT_UPDATE = `mutation redirectUpdate($id: ID!, $r: UrlRedirectInput!) {
  urlRedirectUpdate(id: $id, urlRedirect: $r) { urlRedirect { id } userErrors { field message code } }
}`;
export const URL_REDIRECT_DELETE = `mutation redirectDelete($id: ID!) {
  urlRedirectDelete(id: $id) { deletedUrlRedirectId userErrors { field message code } }
}`;
const REDIRECT_LOOKUP = `query redirectLookup($q: String!) {
  urlRedirects(first: 5, query: $q) { edges { node { id path target } } }
}`;
const ACTIVE_BY_ISBN = `query activeByIsbn($isbn: String!) {
  productByIdentifier(identifier: { customId: { namespace: "bok", key: "isbn", value: $isbn } }) { id handle status }
}`;
const COLLECTION_HANDLES = `query collectionHandles($after: String) {
  collections(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { handle } }
}`;

/** Handlene til alle samlinger i butikken (én side per 250). */
export async function loadCollectionHandles(): Promise<string[]> {
  const out: string[] = [];
  let after: string | null = null;
  do {
    const r = await shopifyGraphQL(COLLECTION_HANDLES, { after });
    for (const n of r.data?.collections?.nodes ?? []) out.push(n.handle);
    after = r.data?.collections?.pageInfo?.hasNextPage ? r.data.collections.pageInfo.endCursor : null;
  } while (after);
  return out;
}

/** Første av ISBN-ene som finnes som aktiv bok (bok.isbn) → handle, ellers null. */
export async function findActiveReplacement(isbns: readonly string[]): Promise<string | null> {
  for (const isbn of isbns) {
    const r = await shopifyGraphQL(ACTIVE_BY_ISBN, { isbn });
    const p = r.data?.productByIdentifier;
    if (p?.status === "ACTIVE" && p.handle) return p.handle as string;
  }
  return null;
}

/** Eksisterende videresendinger fra handle- og ISBN-adressen til boka. */
export async function loadRedirectsFor(handle: string, isbn: string | null): Promise<RedirectRow[]> {
  const out: RedirectRow[] = [];
  for (const path of [handlePath(handle), ...(isbn ? [isbnPath(isbn)] : [])]) {
    const r = await shopifyGraphQL(REDIRECT_LOOKUP, { q: `path:${path}` });
    for (const e of r.data?.urlRedirects?.edges ?? []) if (e.node.path === path) out.push(e.node);
  }
  return out;
}

/** Utfører operasjonene. Kaster med Shopifys feilmelding ved brukerfeil. */
export async function applyRedirectOps(ops: readonly RedirectOp[]): Promise<void> {
  for (const o of ops) {
    const r = o.op === "create"
      ? await shopifyGraphQL(URL_REDIRECT_CREATE, { r: { path: o.path, target: o.target } })
      : o.op === "update"
      ? await shopifyGraphQL(URL_REDIRECT_UPDATE, { id: o.id, r: { path: o.path, target: o.target } })
      : await shopifyGraphQL(URL_REDIRECT_DELETE, { id: o.id });
    const d = r.data?.urlRedirectCreate ?? r.data?.urlRedirectUpdate ?? r.data?.urlRedirectDelete;
    const errs = (d?.userErrors ?? []) as { message: string }[];
    if (errs.length) throw new Error(`videresending ${o.path}: ${errs.map((e) => e.message).join(", ")}`);
  }
}

/** Alle videresendinger fra en handle-adresse (ikke ISBN-adresse): bare de vi selv lager. Brukes til å finne reaktiverte bøker. */
export const ALL_REDIRECTS_PAGE = `query allRedirects($after: String) {
  urlRedirects(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id path target } }
}`;

/**
 * Videresendingene fra handle-adresser (alt som ikke er /products/{13 sifre}), path → rad.
 * Én gang per jobb: ISBN-adressene (8 000+) hentes ikke her, de slås opp per bok.
 */
export async function loadHandleRedirects(): Promise<Record<string, RedirectRow>> {
  const out: Record<string, RedirectRow> = {};
  let after: string | null = null;
  do {
    const r = await shopifyGraphQL(ALL_REDIRECTS_PAGE, { after });
    for (const n of r.data?.urlRedirects?.nodes ?? []) {
      if (/^\/products\/[^/]+$/.test(n.path) && !/^\/products\/\d{13}$/.test(n.path)) out[n.path] = n;
    }
    after = r.data?.urlRedirects?.pageInfo?.hasNextPage ? r.data.urlRedirects.pageInfo.endCursor : null;
  } while (after);
  return out;
}
