// supabase/functions/_shared/price-lock.ts
// Egen pris og tilbud: Bokadmin endrer ikke prisen på et produkt når
//   - metafeltet bok.egen_pris er true («Egen pris (Bokadmin endrer ikke prisen)»), eller
//   - varianten har compareAtPrice (tilbud).
// Gjelder prisjobben, push av eksisterende bok og godkjenning av prisendringer.
// Alt annet ved push oppdateres som før. Ren TypeScript uten Deno-API-er, slik
// at scripts/*.test.mjs kan teste den.
//
// Definisjonen av bok.egen_pris lages med scripts/egen-pris-definition.mjs.

/** GraphQL-felt på produktet. Hent også `compareAtPrice` på varianten. */
export const EGEN_PRIS_FIELD = `egenPris: metafield(namespace: "bok", key: "egen_pris") { value }`;

export type PriceLock = "egen pris" | "tilbud";

/** Er compareAtPrice satt (> 0)? */
function hasCompareAt(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) && n > 0;
}

/**
 * Hvorfor prisen ikke skal endres, eller null.
 * @param egenPris     verdien av bok.egen_pris (`"true"`/`"false"`, boolean eller `{ value }`)
 * @param compareAtPrice variantens compareAtPrice
 */
export function priceLock(egenPris: unknown, compareAtPrice: unknown): PriceLock | null {
  const v = egenPris && typeof egenPris === "object" && "value" in egenPris
    ? (egenPris as { value: unknown }).value
    : egenPris;
  if (v === true || String(v).toLowerCase() === "true") return "egen pris";
  if (hasCompareAt(compareAtPrice)) return "tilbud";
  return null;
}

/** «Hoppet over: egen pris» / «Hoppet over: tilbud» */
export function priceLockMessage(lock: PriceLock): string {
  return `Hoppet over: ${lock}`;
}
