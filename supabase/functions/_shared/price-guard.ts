// supabase/functions/_shared/price-guard.ts
// Sperre mot store prishopp. Ren TypeScript uten Deno-API-er, slik at
// scripts/*.test.mjs kan teste den.
//
// Prisjobben (oppdateringsmodus) og push av eksisterende bok setter ikke en ny
// pris som avviker mer enn user_settings.max_price_change_pct (standard 30 %)
// fra den gamle. Endringen legges i price_approvals og må godkjennes i Bokadmin.
// Mangler den gamle prisen, eller er den 0, settes den nye (det retter en feil).

export const DEFAULT_MAX_PRICE_CHANGE_PCT = 30;

export type PriceChangeAction =
  | "same"      // avvik under 0,01 kr: ingen endring
  | "set"       // innenfor grensen: sett ny pris
  | "fix"       // gammel pris mangler eller er 0: sett ny pris
  | "approval"; // over grensen: ikke sett, krever godkjenning

export interface PriceChangeCheck {
  action: PriceChangeAction;
  /** |ny − gammel| / gammel i prosent, null når gammel pris mangler eller er 0. */
  pct: number | null;
}

/** Gyldig grense (> 0), ellers standard. */
export function normalizeMaxPct(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PRICE_CHANGE_PCT;
}

export function checkPriceChange(oldPrice: unknown, newPrice: number, maxPct: unknown = DEFAULT_MAX_PRICE_CHANGE_PCT): PriceChangeCheck {
  const old = typeof oldPrice === "number" ? oldPrice : parseFloat(String(oldPrice ?? ""));
  if (!Number.isFinite(old) || old <= 0) return { action: "fix", pct: null };
  if (Math.abs(newPrice - old) < 0.01) return { action: "same", pct: 0 };
  const pct = (Math.abs(newPrice - old) / old) * 100;
  return { action: pct > normalizeMaxPct(maxPct) ? "approval" : "set", pct };
}

/** Prosent med én desimal og komma, f.eks. 45,2. */
export function formatPct(pct: number): string {
  return (Math.round(pct * 10) / 10).toFixed(1).replace(/\.0$/, "").replace(".", ",");
}

const kr = (n: unknown) => {
  const v = typeof n === "number" ? n : parseFloat(String(n ?? ""));
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "mangler";
};

/** «Krever godkjenning: 449 → 899 kr (100,2 %)» */
export function approvalMessage(oldPrice: unknown, newPrice: number, pct: number): string {
  return `Krever godkjenning: ${kr(oldPrice)} → ${kr(newPrice)} kr (${formatPct(pct)} %)`;
}

/** «Pris satt: mangler → 449 kr (gammel pris manglet eller var 0)» */
export function fixMessage(oldPrice: unknown, newPrice: number): string {
  return `Pris satt: ${kr(oldPrice)} → ${kr(newPrice)} kr (gammel pris manglet eller var 0)`;
}
