// supabase/functions/_shared/bokgruppe.ts
// Bokgruppekode → bkg-tagger (pakke E del 5: flyttet hit fra shopify/index.ts og
// sjangre-sync/index.ts, der den sto i to kopier). Koden 417 gir taggene
// bkg-4, bkg-41 og bkg-417, og samlingene bkg-4, bkg-41 og bkg-417.
// Ren TypeScript uten Deno-API-er (testes i scripts/bokgruppe.test.mjs).

/**
 * Metafeltet bok.bokgruppe (pakke F del 2.4): bokgruppekoden ved siden av
 * bkg-taggene, så samlingene senere kan bytte regel fra tagg til metafelt.
 * Settes av push og «Oppdater eksisterende bøker» (bookMetafields) og sjangersynken.
 * Definisjonen lages med scripts/bokgruppe-definisjon.mjs.
 */
export const BOKGRUPPE_METAFIELD = Object.freeze({ namespace: "bok", key: "bokgruppe", type: "single_line_text_field" });

/** GraphQL-felt på produktet */
export const BOKGRUPPE_FIELD = `bokgruppe: metafield(namespace: "bok", key: "bokgruppe") { value }`;

/**
 * Bokgruppekoden fra bkg-taggene (den lengste, «bkg-417» → «417»), for produkter uten bok.bokgruppe ennå.
 * Samme kode som metafeltet, siden begge settes ut fra samme ONIX-kode.
 */
export function bokgruppeFromTags(tags: unknown): string | null {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  let best = "";
  for (const t of list) {
    const m = /^bkg-(\d{1,3})$/i.exec(String(t).trim());
    if (m && m[1].length > best.length) best = m[1];
  }
  return best || null;
}

/** «417» → ["bkg-4", "bkg-41", "bkg-417"] */
export function bokgruppeTagsForKode(kode: string): string[] {
  const k = String(kode ?? "").trim();
  const tags: string[] = [];
  if (k.length >= 1) tags.push(`bkg-${k[0]}`);
  if (k.length >= 2) tags.push(`bkg-${k.slice(0, 2)}`);
  if (k.length >= 3) tags.push(`bkg-${k.slice(0, 3)}`);
  return tags;
}

/** bkg-taggene produktet mangler for koden (eksakt sammenligning, som Shopify lagrer dem). */
export function missingBokgruppeTags(tags: readonly string[] | null | undefined, kode: string): string[] {
  const have = new Set(tags ?? []);
  return bokgruppeTagsForKode(kode).filter((t) => !have.has(t));
}

/** Alle kodene samlingene trengs for (med overordnede nivåer), kortest først. */
export function bokgruppeCollectionCodes(koder: Iterable<string>): string[] {
  const all = new Set<string>();
  for (const kode of koder) {
    if (!kode || kode === "ukjent") continue;
    for (const tag of bokgruppeTagsForKode(kode)) all.add(tag.slice(4));
  }
  return [...all].sort((a, b) => a.length - b.length || a.localeCompare(b));
}
