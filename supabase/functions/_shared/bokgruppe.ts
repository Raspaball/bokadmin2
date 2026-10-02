// supabase/functions/_shared/bokgruppe.ts
// Bokgruppekode → bkg-tagger (pakke E del 5: flyttet hit fra shopify/index.ts og
// sjangre-sync/index.ts, der den sto i to kopier). Koden 417 gir taggene
// bkg-4, bkg-41 og bkg-417, og samlingene bkg-4, bkg-41 og bkg-417.
// Ren TypeScript uten Deno-API-er (testes i scripts/bokgruppe.test.mjs).

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
