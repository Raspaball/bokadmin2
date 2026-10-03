// supabase/functions/_shared/book-format.ts
// ONIX ProductForm (List 150) + ProductFormDetail (List 175) → bok.format,
// productType og produktkategori i Shopify. Ren TypeScript (testes i scripts/).
//
// Listen er godkjent av Eirik 2026-10-02 (pakke B del 2). Grunnlaget (103 rå
// ONIX-poster) står i BOKADMIN2_OPPSETT.md. Storpocket regnes som Pocket, og
// Flexband som Kartonert.
//
//   Innbundet  BB, BG (skinn)
//   Pocket     BA/BC + B113 (pocket), B114 (storpocket), B101/B104 (massemarked)
//   Kartonert  BA/BC + B115 (kartonnasje), B116 (flexband)
//   Spiral     BE, eller B312–B314 (spiral, wire-O, comb)
//   Heftet     BA, BC (ellers)
//   Pappbok    BH
//   Lydbok     A*  (productType Lydbok)
//   E-bok      E* med E101 (EPUB), E107 (PDF) eller E116 (Kindle) (productType E-bok)
//   Kart       C*
//   Annet      alt annet (E* uten e-bokformat får productType E-bok)

import { extractProductForm } from "./onix.js";

export const FORMAT_VALUES = [
  "Innbundet", "Heftet", "Pocket", "Kartonert", "Spiral", "Pappbok", "Lydbok", "E-bok", "Kart", "Annet",
] as const;

export type BookFormat = (typeof FORMAT_VALUES)[number];
export type BookProductType = "Bok" | "Lydbok" | "E-bok";

/** Shopify Standard Product Taxonomy (2026-07, kontrollert mot Testbutikk) */
export const CATEGORY_IDS: Record<BookProductType, string> = {
  Bok: "gid://shopify/TaxonomyCategory/me-1-3",    // Media > Books > Print Books
  Lydbok: "gid://shopify/TaxonomyCategory/me-1-1", // Media > Books > Audiobooks
  "E-bok": "gid://shopify/TaxonomyCategory/me-1-2", // Media > Books > E-Books
};

/** Fullt navn på kategorien, som i kolonnen «Product category» i Shopifys CSV */
export const CATEGORY_NAMES: Record<BookProductType, string> = {
  Bok: "Media > Books > Print Books",
  Lydbok: "Media > Books > Audiobooks",
  "E-bok": "Media > Books > E-Books",
};

export interface FormatInfo {
  format: BookFormat;
  productType: BookProductType;
  category: string;
}

const info = (format: BookFormat, productType: BookProductType): FormatInfo =>
  ({ format, productType, category: CATEGORY_IDS[productType] });

export function bookFormat(form: string | null | undefined, details: readonly string[] = []): FormatInfo {
  const f = String(form ?? "").trim().toUpperCase();
  const d = new Set(details.map((x) => String(x).trim().toUpperCase()));
  const has = (...codes: string[]) => codes.some((c) => d.has(c));

  if (f.startsWith("A")) return info("Lydbok", "Lydbok");
  if (f.startsWith("E")) return has("E101", "E107", "E116") ? info("E-bok", "E-bok") : info("Annet", "E-bok");
  if (f.startsWith("C")) return info("Kart", "Bok");
  if (f === "BB" || f === "BG") return info("Innbundet", "Bok");
  if (f === "BH") return info("Pappbok", "Bok");
  if (f === "BE" || has("B312", "B313", "B314")) return info("Spiral", "Bok");
  if (f === "BA" || f === "BC") {
    if (has("B113", "B114", "B101", "B104")) return info("Pocket", "Bok");
    if (has("B115", "B116")) return info("Kartonert", "Bok");
    return info("Heftet", "Bok");
  }
  return info("Annet", "Bok");
}

/**
 * Formatet slik det vises og lagres (bok.format, SEO-tittel, metabeskrivelse):
 * «Annet» sier ingenting til kunden og tas ikke med (pakke G del 4a). Tom streng = ingen visning.
 */
export function shownFormat(format: string | null | undefined): string {
  const f = String(format ?? "").trim();
  return f && f !== "Annet" ? f : "";
}

// ── Bare bøker (pakke F del 2.2) ─────────────────────────────────────────────
// Bokadmin behandler bare produkter med ISBN, treff i Bokbasen og bokformat:
// ProductForm B* (trykt bok), A* (lydbok) eller E* (e-bok). Alt annet (kalendere,
// spill, notatbøker, plakater, kart C* osv.) hoppes over og telles.

export const BOOK_FORM_PREFIXES: readonly string[] = Object.freeze(["B", "A", "E"]);

export function isBookForm(form: string | null | undefined): boolean {
  const f = String(form ?? "").trim().toUpperCase();
  return BOOK_FORM_PREFIXES.some((p) => f.startsWith(p));
}

/** «Hoppet over: ikke bok (ProductForm PC)» */
export function notBookMessage(form: string | null | undefined): string {
  return `Hoppet over: ikke bok (ProductForm ${String(form ?? "").trim() || "mangler"})`;
}

/** Loggteksten når ONIX-posten ikke er en bok, ellers null. Uten ONIX: se NOT_IN_BOKBASEN_MESSAGE. */
export function notBookSkip(xml: string | null | undefined): string | null {
  if (!xml) return null;
  const { form } = extractProductForm(xml);
  return isBookForm(form) ? null : notBookMessage(form);
}

export const NOT_IN_BOKBASEN_MESSAGE = "Hoppet over: fant ikke boka i Bokbasen";
