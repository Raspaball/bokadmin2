/* @ts-self-types="./onix.d.ts" */
// supabase/functions/_shared/onix.js
// Felles lesing av ONIX fra Bokbasen. Ren JavaScript (ESM), slik at både
// Edge Functions (Deno) og testene i scripts/ (Node) kan importere den.
//
// Bokgruppekode: SubjectSchemeIdentifier 37 i ONIX-kodeliste 27 =
// «Bokgrupper» (Forleggerforeningen), 1–3 sifre — de samme kodene som
// bkg-taggene og de smarte samlingene bruker. Kontrollert mot rå ONIX
// 2026-10-01: 37 fantes i alle 89 postene som ble hentet (nye og eldre
// titler, alle typer), skjema 23 («Publisher's own category code») i ingen.
// Derfor ingen reserve til 23. 38 er varegrupper (5 sifre), ikke bokgrupper.

export const BOKGRUPPE_SCHEME = "37";

/** Fjerner xmlns-attributter og navneromsprefikser (<onix:Product> → <Product>). */
export function stripNamespaces(xml) {
  return String(xml ?? "")
    .replace(/\s+xmlns[^"]*"[^"]*"/g, "")
    .replace(/<(\w+:)/g, "<")
    .replace(/<\/(\w+:)/g, "</");
}

/**
 * Første bokgruppekode (skjema 37) i ONIX-teksten, eller null.
 * Teksten kan være en hel melding eller én <Product>-blokk; ved flere
 * produkter i én melding må hver blokk sendes inn for seg.
 * @param {string} xml
 * @returns {string | null}
 */
export function extractBokgruppekode(xml) {
  for (const s of stripNamespaces(xml).matchAll(/<Subject(?:\s[^>]*)?>[\s\S]*?<\/Subject>/gi)) {
    const scheme = s[0].match(/<SubjectSchemeIdentifier[^>]*>\s*(.*?)\s*<\/SubjectSchemeIdentifier>/i)?.[1];
    const code = s[0].match(/<SubjectCode[^>]*>\s*(.*?)\s*<\/SubjectCode>/i)?.[1];
    if (scheme === BOKGRUPPE_SCHEME && code && /^\d{1,3}$/.test(code)) return code;
  }
  return null;
}
