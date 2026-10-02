// supabase/functions/_shared/price-summary.ts
// Tellinger for prisjobben, lagret i jobs.config.counts mellom pulsene og i
// jobs.result.counts + result.summary når jobben er ferdig. Oppdatering-siden
// viser result.summary. Ren TypeScript uten Deno-API-er (testes i scripts/).

export interface PriceCounts {
  /** Oppdatering: pris satt. Sjekk: ville fått ny pris. */
  changed: number;
  /** Samme pris i Shopify og Bokbasen */
  same: number;
  /** Over grensen: lagt til godkjenning (oppdatering) eller ville krevd det (sjekk) */
  approval: number;
  skippedOwnPrice: number;
  skippedOffer: number;
  skippedNoIsbn: number;
  /** Beskyttet tagg (_shared/protected.ts) */
  skippedProtected: number;
  /** Samme ISBN på flere produkter (_shared/duplicates.ts) */
  skippedDuplicate: number;
  /** Ingen godkjent pris i Bokbasen, per årsak («ingen NOK-pris» …) */
  missing: Record<string, number>;
  /** Feil (Bokbasen/Shopify) */
  errors: number;
}

export type PriceCountKey = Exclude<keyof PriceCounts, "missing">;

export function emptyCounts(): PriceCounts {
  return { changed: 0, same: 0, approval: 0, skippedOwnPrice: 0, skippedOffer: 0, skippedNoIsbn: 0, skippedProtected: 0, skippedDuplicate: 0, missing: {}, errors: 0 };
}

/** Tellinger fra en lagret jobb (manglende felt blir 0). */
export function loadCounts(value: unknown): PriceCounts {
  const c = emptyCounts();
  if (!value || typeof value !== "object") return c;
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(c) as (keyof PriceCounts)[]) {
    if (k === "missing") {
      if (v.missing && typeof v.missing === "object") {
        for (const [reason, n] of Object.entries(v.missing as Record<string, unknown>)) {
          if (typeof n === "number") c.missing[reason] = n;
        }
      }
    } else if (typeof v[k] === "number") {
      c[k] = v[k] as number;
    }
  }
  return c;
}

export function countMissing(c: PriceCounts, reason: string | null | undefined): void {
  const key = reason || "ukjent årsak";
  c.missing[key] = (c.missing[key] ?? 0) + 1;
}

/**
 * «3 endret, 40 samme pris, 1 krever godkjenning, hoppet over 22 (1 egen pris,
 *  1 tilbud, 20 uten ISBN, 0 beskyttet, 0 DUPLIKAT), 2 manglet godkjent pris (1 ingen pris, 1 ingen NOK-pris), 0 feil»
 * I sjekkmodus står det «ville fått ny pris» i stedet for «endret».
 */
export function summarizeCounts(c: PriceCounts, mode: "analyze" | "update"): string {
  const parts: string[] = [];
  parts.push(`${c.changed} ${mode === "analyze" ? "ville fått ny pris" : "endret"}`);
  parts.push(`${c.same} samme pris`);
  parts.push(`${c.approval} ${mode === "analyze" ? "ville krevd godkjenning" : "krever godkjenning"}`);
  const skipped = c.skippedOwnPrice + c.skippedOffer + c.skippedNoIsbn + c.skippedProtected + c.skippedDuplicate;
  parts.push(`hoppet over ${skipped} (${c.skippedOwnPrice} egen pris, ${c.skippedOffer} tilbud, ${c.skippedNoIsbn} uten ISBN, ${c.skippedProtected} beskyttet, ${c.skippedDuplicate} DUPLIKAT)`);
  const missingTotal = Object.values(c.missing).reduce((a, b) => a + b, 0);
  const reasons = Object.entries(c.missing).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} ${r}`);
  parts.push(`${missingTotal} manglet godkjent pris${reasons.length ? ` (${reasons.join(", ")})` : ""}`);
  parts.push(`${c.errors} feil`);
  return parts.join(", ");
}
