// supabase/functions/_shared/protected.ts
// Beskyttede produkter (fast regel fra 02.10.2026, oppgaver/regel-beskyttede-samlinger.md).
//
// Et produkt med minst én av taggene under skal Bokadmin aldri endre: ikke tittel,
// beskrivelse, handle, pris, status, tilgjengelighet, tagger, metafelt, SEO,
// kategori, productType, bilder eller videresendinger. Listen ligger fast her
// med vilje: ingen innstilling, knapp eller parameter skal kunne overstyre den.
//
// Hele taggen må være lik (etter trim, uten hensyn til store og små bokstaver,
// som i Shopify). «oppgaver», «gaveide» og «Lokallitteratur i Telemark» er ikke
// beskyttet. Ren TypeScript (Deno og Node 22, testes i scripts/protected.test.mjs).

export const PROTECTED_TAGS: readonly string[] = Object.freeze(["gave", "lokal", "lokalhistorie", "lokallitteratur"]);

const norm = (t: unknown) => String(t ?? "").trim().toLowerCase();
const PROTECTED_SET = new Set(PROTECTED_TAGS);

/** Den første beskyttede taggen slik den står på produktet, eller null. */
export function protectedTag(tags: readonly unknown[] | null | undefined): string | null {
  for (const t of tags ?? []) {
    if (PROTECTED_SET.has(norm(t))) return String(t).trim();
  }
  return null;
}

export function isProtected(tags: readonly unknown[] | null | undefined): boolean {
  return protectedTag(tags) !== null;
}

/** Er denne ene taggen en av de beskyttede? (Slike tagger fjernes aldri.) */
export function isProtectedTag(tag: unknown): boolean {
  return PROTECTED_SET.has(norm(tag));
}

/** «Hoppet over: beskyttet (tagg: Lokalhistorie)» */
export function protectedMessage(tags: readonly unknown[] | null | undefined): string {
  return `Hoppet over: beskyttet (tagg: ${protectedTag(tags) ?? "?"})`;
}

/**
 * Sikring for kode som setter et helt taggsett: legger tilbake beskyttede
 * tagger som mangler (et beskyttet produkt skal aldri nå hit, men en tagg
 * fra listen skal heller aldri forsvinne).
 */
export function keepProtectedTags(current: readonly string[], next: readonly string[]): string[] {
  const out = [...next];
  for (const t of current) {
    if (isProtectedTag(t) && !out.some((n) => norm(n) === norm(t))) out.push(t);
  }
  return out;
}

// ── Beskyttede samlinger og leverandører (tillegg 02.10.2026) ────────────────
//
// Bare tre samlinger er beskyttet (Eirik 02.10.2026): «Wrendale Designs» (manuell,
// handle wrendale), «Gaveartikler» (smart, tagg gave) og «Lokalhistorie» (smart,
// taggene over). De smarte dekkes av taggene. Den manuelle følger ikke med i
// produkteksporten, så produktene beskyttes på to måter i tillegg:
//   - leverandør: vendor inneholder «wrendale» (uten hensyn til store/små bokstaver)
//   - medlemskap: produktet står i en manuell samling med handle i
//     PROTECTED_COLLECTION_HANDLES. Lista hentes ved start av hver jobb/puls med
//     loadProtectedMembers(); finnes ikke samlingen, stopper jobben.
// Produktnivå: protectedProduct() (tagg → leverandør → samling). protectedTag()
// gjelder bare taggene og brukes der det er taggene som vurderes.

export const PROTECTED_VENDOR_WORDS: readonly string[] = Object.freeze(["wrendale"]);
export const PROTECTED_COLLECTION_HANDLES: readonly string[] = Object.freeze(["wrendale"]);

/** Leverandøren slik den står på produktet, når den er beskyttet; ellers null. */
export function protectedVendor(vendor: unknown): string | null {
  const v = String(vendor ?? "").trim();
  return v && PROTECTED_VENDOR_WORDS.some((w) => v.toLowerCase().includes(w)) ? v : null;
}

export const PROTECTED_MEMBERS_NOT_LOADED =
  "Beskyttede samlinger er ikke lastet (loadProtectedMembers). Stopper for sikkerhets skyld";

let loadedMembers: ReadonlyMap<string, string> | null = null;

/** Produkt-ID → samlingens handle. Settes av loadProtectedMembers() (og i tester). */
export function setProtectedMembers(members: ReadonlyMap<string, string> | Iterable<[string, string]> | null): void {
  loadedMembers = members === null ? null : members instanceof Map ? members : new Map(members);
}

export interface ProtectableProduct {
  id?: string | null;
  tags?: readonly unknown[] | string | null;
  vendor?: string | null;
}

/**
 * Hvorfor produktet er beskyttet, eller null: «tagg: Lokalhistorie»,
 * «leverandør: Wrendale Design ltd» eller «samling: wrendale».
 * Kaster hvis samlingslista ikke er lastet (heller stopp enn å endre et beskyttet produkt).
 */
export function protectedProduct(p: ProtectableProduct | null | undefined, members?: ReadonlyMap<string, string>): string | null {
  if (!p) return null;
  const tag = protectedTag(tagList(p.tags));
  if (tag) return `tagg: ${tag}`;
  const vendor = protectedVendor(p.vendor);
  if (vendor) return `leverandør: ${vendor}`;
  const m = members ?? loadedMembers;
  if (!m) throw new Error(PROTECTED_MEMBERS_NOT_LOADED);
  const handle = p.id ? m.get(p.id) : undefined;
  return handle ? `samling: ${handle}` : null;
}

/** «Hoppet over: beskyttet (samling: wrendale)» */
export function protectedProductMessage(p: ProtectableProduct | null | undefined, members?: ReadonlyMap<string, string>): string {
  return `Hoppet over: beskyttet (${protectedProduct(p, members) ?? "?"})`;
}

/**
 * Er samlingen selv beskyttet? Manuell: handle på lista. Smart: en regel
 * «Tag er lik» en beskyttet tagg (Gaveartikler, Lokalhistorie). Slike samlinger
 * skal ingen funksjon i Bokadmin endre, sortere, fylle, tømme eller slette.
 */
export function isProtectedCollection(c: {
  handle?: string | null;
  ruleSet?: { rules?: Array<{ column?: string | null; relation?: string | null; condition?: string | null }> | null } | null;
} | null | undefined): boolean {
  if (!c) return false;
  if (PROTECTED_COLLECTION_HANDLES.includes(String(c.handle ?? "").trim().toLowerCase())) return true;
  return (c.ruleSet?.rules ?? []).some((r) => r.column === "TAG" && isProtectedTag(r.condition));
}

export const PROTECTED_COLLECTION_MEMBERS_QUERY = `query protectedMembers($handle: String!, $after: String) {
  collectionByIdentifier(identifier: { handle: $handle }) {
    id handle
    products(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id } }
  }
}`;

/** Starten av feilmeldingen når samlingen mangler. Jobbene regner den som fatal (failed, ikke paused). */
export const PROTECTED_COLLECTION_MISSING = "Fant ikke den beskyttede samlingen";

/** Fatal feil for jobbene: HTTP 401/403 eller manglende beskyttet samling. Ellers pauses jobben og prøves igjen. */
export function isFatalJobError(message: string): boolean {
  return message.includes("HTTP 401") || message.includes("HTTP 403") || message.includes(PROTECTED_COLLECTION_MISSING);
}

// deno-lint-ignore no-explicit-any
type Gql = (query: string, variables?: Record<string, unknown>) => Promise<any>;

/**
 * Henter produktene i de beskyttede manuelle samlingene og setter lista som
 * protectedProduct() bruker. `gql` returnerer `data` (Deno: shopifyGraphQL(...).data).
 * Kaster når en samling mangler: da stopper jobben.
 */
export async function loadProtectedMembers(gql: Gql): Promise<Map<string, string>> {
  const members = new Map<string, string>();
  for (const handle of PROTECTED_COLLECTION_HANDLES) {
    let after: string | null = null;
    do {
      const data = await gql(PROTECTED_COLLECTION_MEMBERS_QUERY, { handle, after });
      const c = data?.collectionByIdentifier;
      if (!c) throw new Error(`${PROTECTED_COLLECTION_MISSING} «${handle}». Jobben stopper (oppgaver/regel-beskyttede-samlinger.md)`);
      for (const n of c.products?.nodes ?? []) members.set(n.id, handle);
      after = c.products?.pageInfo?.hasNextPage ? c.products.pageInfo.endCursor : null;
    } while (after);
  }
  setProtectedMembers(members);
  return members;
}

/** Shopify-ressurs → tagger (tags kan komme som liste eller kommaseparert tekst). */
export function tagList(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === "string") return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}
