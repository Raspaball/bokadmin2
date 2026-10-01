// supabase/functions/_shared/price.ts
// Prisvalg fra ONIX (Bokbasen). Ren TypeScript uten Deno-API-er, slik at
// testene i scripts/ kan importere fila direkte med Node.
//
// Bokadmin 2.0 har én prisregel, brukt av både import og prisjobben.
// Prioritet: 04 > 02 > 03 > 01 > andre, altså priser med mva før priser uten
// (04 fastpris inkl. mva, 02 veiledende inkl. mva, 03 fastpris uten mva,
// 01 veiledende uten mva). For bøker (0 % mva) gir det samme beløp. Gamle
// Bokadmin brukte 04 > 03 > 02 > 01 (endret i pakke A2 del 5).
// I tillegg godtas bare priser som (bevisst strengere enn gamle Bokadmin):
//   - er i NOK: CurrencyCode i Price, ellers DefaultCurrencyCode i headeren
//     (ONIX 2.1), ellers regnes prisen som NOK. Aldri annen valuta som reserve.
//   - gjelder Norge: står det et territorium (i Price, ellers i Market for
//     samme ProductSupply), må NO være med.
//   - gjelder i dag (Europe/Oslo): PriceEffectiveFrom/Until (ONIX 2.1) eller
//     PriceDate med PriceDateRole 14 (fra) / 15 (til) (ONIX 3). Pris uten
//     datoer gjelder alltid.
// Blant godkjente priser velges etter type; ved flere av samme type vinner
// nyest startdato (pris uten startdato regnes som eldst), deretter den første.
// Ingen godkjent pris gir price = null og en årsak.
//
// `xml` kan ha navnerom (de fjernes her). Funnene fra rå ONIX som regelen
// bygger på står i BOKADMIN2_OPPSETT.md («Valuta og gyldighetsdato»).

const PRIORITY: Record<string, number> = { "04": 1, "02": 2, "03": 3, "01": 4 };

export type PriceRejectReason = "ingen pris" | "ingen NOK-pris" | "ingen pris for Norge" | "ingen gyldig pris i dag";

export interface PriceChoice {
  price: number | null;
  priceType?: string;
  reason?: PriceRejectReason;
}

/** Dagens dato i Europe/Oslo som YYYYMMDD. */
export function osloToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(now).replace(/-/g, "");
}

function stripNamespaces(xml: string): string {
  return xml
    .replace(/\s+xmlns[^"]*"[^"]*"/g, "")
    .replace(/<(\w+:)/g, "<")
    .replace(/<\/(\w+:)/g, "</");
}

const text = (s: string, tag: string): string | undefined =>
  s.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "i"))?.[1]?.trim();
const texts = (s: string, tag: string): string[] =>
  [...s.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "gi"))].map((m) => m[1].trim());
const codes = (values: string[]): string[] => values.flatMap((v) => v.toUpperCase().split(/\s+/)).filter(Boolean);

// Dato som YYYYMMDD. YYYY og YYYYMM utvides til første (fra) eller siste (til) dag.
function normDate(raw: string | undefined, end: boolean): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length >= 8) return d.slice(0, 8);
  if (d.length === 6) return d + (end ? "31" : "01");
  if (d.length === 4) return d + (end ? "1231" : "0101");
  return null;
}

function priceDates(p: string): { from: string | null; until: string | null } {
  let from = normDate(text(p, "PriceEffectiveFrom"), false);
  let until = normDate(text(p, "PriceEffectiveUntil"), true);
  for (const m of p.matchAll(/<PriceDate(?:\s[^>]*)?>[\s\S]*?<\/PriceDate>/gi)) {
    const role = text(m[0], "PriceDateRole");
    const date = text(m[0], "Date");
    if (role === "14") from = normDate(date, false);
    if (role === "15") until = normDate(date, true);
  }
  return { from, until };
}

// Territorium i en tekstbit: null = ingen territorium oppgitt, ellers om Norge er med.
function territoryAllowsNorway(seg: string): boolean | null {
  // ONIX 3: <Territory><CountriesIncluded>/<RegionsIncluded>/<CountriesExcluded>…</Territory>
  // ONIX 2.1 (i Price): <CountryCode>, <Territory> (regionkoder som tekst), <CountryExcluded>
  const terr = seg.match(/<Territory(?:\s[^>]*)?>([\s\S]*?)<\/Territory>/i)?.[1] ?? "";
  const container = terr.includes("<") ? terr : "";
  const included = codes([...texts(container, "CountriesIncluded"), ...texts(seg, "CountryCode")]);
  const regions = codes([...texts(container, "RegionsIncluded"), ...(container ? [] : [terr])]);
  const excluded = codes([...texts(container, "CountriesExcluded"), ...texts(seg, "CountryExcluded")]);
  if (!included.length && !regions.length && !excluded.length) return null;
  if (excluded.includes("NO")) return false;
  if (included.length || regions.length) return included.includes("NO") || regions.includes("WORLD");
  return true; // bare unntak, og NO er ikke unntatt
}

/**
 * Velger pris etter regelen øverst i fila.
 * @param today YYYYMMDD (standard: i dag i Europe/Oslo)
 */
export function choosePrice(rawXml: string, today: string = osloToday()): PriceChoice {
  const xml = stripNamespaces(rawXml);
  const header = xml.match(/<Header(?:\s[^>]*)?>[\s\S]*?<\/Header>/i)?.[0] ?? "";
  const defaultCurrency = text(header, "DefaultCurrencyCode");

  // ONIX 3: én eller flere ProductSupply med Market. ONIX 2.1: SupplyDetail rett i Product.
  const supplies = [...xml.matchAll(/<ProductSupply(?:\s[^>]*)?>[\s\S]*?<\/ProductSupply>/gi)].map((m) => m[0]);

  interface Candidate { type: string; amount: number; currencyOk: boolean; territoryOk: boolean; dateOk: boolean; from: string }
  const candidates: Candidate[] = [];
  for (const supply of supplies.length ? supplies : [xml]) {
    const market = supply.match(/<Market(?:\s[^>]*)?>[\s\S]*?<\/Market>/i)?.[0] ?? "";
    const marketTerritory = territoryAllowsNorway(market);
    for (const m of supply.matchAll(/<Price(?:\s[^>]*)?>[\s\S]*?<\/Price>/gi)) {
      const p = m[0];
      const amount = parseFloat(text(p, "PriceAmount") ?? "");
      if (isNaN(amount)) continue;
      const currency = (text(p, "CurrencyCode") || defaultCurrency || "NOK").toUpperCase();
      const territory = territoryAllowsNorway(p) ?? marketTerritory;
      const { from, until } = priceDates(p);
      candidates.push({
        type: text(p, "PriceType") ?? "",
        amount,
        currencyOk: currency === "NOK",
        territoryOk: territory !== false,
        dateOk: (!from || from <= today) && (!until || today <= until),
        from: from ?? "",
      });
    }
  }

  if (!candidates.length) return { price: null, reason: "ingen pris" };
  const nok = candidates.filter((c) => c.currencyOk);
  if (!nok.length) return { price: null, reason: "ingen NOK-pris" };
  const norway = nok.filter((c) => c.territoryOk);
  if (!norway.length) return { price: null, reason: "ingen pris for Norge" };
  const valid = norway.filter((c) => c.dateOk);
  if (!valid.length) return { price: null, reason: "ingen gyldig pris i dag" };

  let best = valid[0];
  for (const c of valid.slice(1)) {
    const pc = PRIORITY[c.type] ?? 5;
    const pb = PRIORITY[best.type] ?? 5;
    if (pc < pb || (pc === pb && c.from > best.from)) best = c;
  }
  return { price: best.amount, priceType: best.type };
}

/**
 * Prisjobbens pris: choosePrice uten årsak. Beløp på 0 eller lavere returneres,
 * slik at prisjobben kan logge avvisningen; avvik under 0,01 kr regnes der som
 * ingen endring.
 */
export function pickPriceUpdatePrice(xml: string, today?: string): number | null {
  return choosePrice(xml, today).price;
}

/**
 * Pris for import og alt annet som leser pris fra ONIX: choosePrice, men
 * 0 eller lavere godtas ikke. Ingen godkjent pris gir price = null og en årsak.
 */
export function chooseValidPrice(xml: string, today?: string): { price: number | null; reason: string | null } {
  const choice = choosePrice(xml, today);
  if (choice.price === null) return { price: null, reason: choice.reason ?? "ingen pris" };
  if (choice.price <= 0) return { price: null, reason: "pris 0 eller lavere" };
  return { price: choice.price, reason: null };
}

/** chooseValidPrice uten årsak. */
export function pickValidPrice(xml: string, today?: string): number | null {
  return chooseValidPrice(xml, today).price;
}
