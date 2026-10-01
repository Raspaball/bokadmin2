// supabase/functions/_shared/price.ts
// Prisvalg fra ONIX (Bokbasen). Ren TypeScript uten Deno-API-er, slik at
// testene i scripts/ kan importere fila direkte med Node.
//
// Begge reglene speiler gamle Bokadmin (C:\Bokadmin, branch utvikling)
// nøyaktig: bokbasen/index.ts (import) og price-update/index.ts (prisjobben).
// Ikke endre hvilken pris som velges her uten at det er en bevisst beslutning.
//
// `xml` er ONIX-teksten med navnerom fjernet (se stripNamespaces i onix.js).

const PRICE_BLOCK = /<Price[\s\S]*?<\/Price>/gi;

/**
 * Importregelen (gamle Bokadmin, bokbasen/index.ts): første Price med
 * PriceType 01 eller 02 vinner. Finnes ingen slik, brukes første beløp som
 * finnes. Ingen pris gir null.
 */
export function pickImportPrice(xml: string): number | null {
  let price = "";
  const priceBlocks = [...xml.matchAll(PRICE_BLOCK)];
  for (const p of priceBlocks) {
    const pt = p[0].match(/<PriceType[^>]*>(.*?)<\/PriceType>/i)?.[1];
    const amt = p[0].match(/<PriceAmount[^>]*>(.*?)<\/PriceAmount>/i)?.[1];
    if ((pt === "01" || pt === "02") && amt) { price = amt; break; }
    if (!price && amt) price = amt;
  }
  return price ? parseFloat(price) : null;
}

/**
 * Prisjobbens regel (gamle Bokadmin, price-update/index.ts): prioritet
 * 04 > 03 > 02 > 01 > andre typer; ved lik prioritet vinner den første.
 * Ingen pris gir null. Beløp på 0 eller lavere avvises av prisjobben selv,
 * og avvik under 0,01 kr regnes der som ingen endring.
 *
 * Norske bøker har 0 % mva., så eks./inkl.-beløpene er like, men fastpris
 * (03/04) foretrekkes fordi den er bindende etter fastprisloven (fra 2024).
 */
export function pickPriceUpdatePrice(xml: string): number | null {
  const PRIORITY: Record<string, number> = { "04": 1, "03": 2, "02": 3, "01": 4 };
  let bestPriority = Infinity;
  let bestAmount: number | null = null;

  const priceBlocks = [...xml.matchAll(PRICE_BLOCK)];
  for (const p of priceBlocks) {
    const pt = p[0].match(/<PriceType[^>]*>(.*?)<\/PriceType>/i)?.[1]?.trim();
    const amtStr = p[0].match(/<PriceAmount[^>]*>(.*?)<\/PriceAmount>/i)?.[1];
    if (!amtStr) continue;
    const amt = parseFloat(amtStr);
    if (isNaN(amt)) continue;
    const priority = PRIORITY[pt ?? ""] ?? 5;
    if (priority < bestPriority) {
      bestPriority = priority;
      bestAmount = amt;
    }
  }
  return bestAmount;
}
