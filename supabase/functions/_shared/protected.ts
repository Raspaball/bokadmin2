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

/** Shopify-ressurs → tagger (tags kan komme som liste eller kommaseparert tekst). */
export function tagList(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === "string") return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}
