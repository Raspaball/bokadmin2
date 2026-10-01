// supabase/functions/_shared/push-price.ts
// Pris og status når en bok sendes til Shopify (push, «Push alle», bulk, CSV).
// Ren TypeScript uten Deno-API-er, slik at scripts/*.test.mjs kan teste den.
//
// Regel: Bokadmin setter aldri pris 0 eller lavere.
//   - Ny bok uten godkjent pris: opprettes som utkast (DRAFT) uten pris.
//   - Eksisterende bok uten godkjent pris: prisen sendes ikke, og blir stående.
//     Statusen endres ikke av denne grunnen.
//   - Bok med pris: som før.

/** Pris over 0, ellers null. Godtar tall og tekst ("449", "449.00"). */
export function validPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Årsak når pris mangler: oppgitt årsak, ellers ut fra verdien. */
export function missingPriceReason(value: unknown, reason?: string | null): string {
  if (reason) return reason;
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) && n <= 0 ? "pris 0 eller lavere" : "ingen godkjent pris";
}

export interface PushPriceDecision {
  /** Pris som skal settes på varianten, eller null = ikke send pris. */
  price: string | null;
  /** true = opprett som utkast i stedet for aktiv. */
  draft: boolean;
  /** Melding til push-resultat og sync_log, eller null når prisen er i orden. */
  note: string | null;
}

/**
 * @param value  bokas pris (books.price / metadata.price)
 * @param isNew  true når produktet opprettes nå
 * @param reason årsak fra choosePrice når prisen mangler
 */
export function decidePushPrice(value: unknown, isNew: boolean, reason?: string | null): PushPriceDecision {
  const price = validPrice(value);
  if (price !== null) return { price: String(price), draft: false, note: null };
  const why = missingPriceReason(value, reason);
  return isNew
    ? { price: null, draft: true, note: `Opprettet som utkast: mangler pris (${why})` }
    : { price: null, draft: false, note: `Pris ikke endret: ${why}` };
}

/** CSV-eksport: rad uten pris får Status = draft og tom pris, aldri 0. */
export function csvPriceAndStatus(value: unknown): { price: string; status: "active" | "draft" } {
  const price = validPrice(value);
  return price !== null ? { price: String(price), status: "active" } : { price: "", status: "draft" };
}
