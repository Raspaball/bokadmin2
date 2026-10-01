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
