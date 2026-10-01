// supabase/functions/_shared/book-standard.ts
// Standarden for en bok i Shopify (pakke B): én ren funksjon som regner ut
// ønsket tilstand fra rå ONIX. Brukes av push og jobben «Oppdater eksisterende
// bøker», og kan senere brukes av bulk-eksport uten å skrive om reglene.
// Ren TypeScript uten Deno-API-er (testes i scripts/).
//
// Pris (pakke A/A2), status og tilgjengelighet (pakke C) og handle hører ikke
// hjemme her og settes aldri av denne modulen.

import {
  extractAudienceAge, extractContributors, extractLanguage, extractPages, extractProductForm,
  extractPublicationYear, extractSeries, extractThema,
} from "./onix.js";
import { bookFormat, type BookFormat, type BookProductType } from "./book-format.ts";

/** Feltene fra ONIX som standarden bygger på. */
export interface BookFields {
  authors: string[];
  /** A01, ellers rollen til første bidragsyter (f.eks. B01 redaktør) */
  authorRole: string | null;
  format: BookFormat;
  productType: BookProductType;
  category: string;
  pages: number | null;
  year: number | null;
  language: string | null;
  series: string | null;
  age: string | null;
  thema: string[];
}

export function bookFieldsFromOnix(xml: string): BookFields {
  const { authors, role } = extractContributors(xml);
  const { form, details } = extractProductForm(xml);
  const f = bookFormat(form, details);
  return {
    authors,
    authorRole: role,
    format: f.format,
    productType: f.productType,
    category: f.category,
    pages: extractPages(xml),
    year: extractPublicationYear(xml),
    language: extractLanguage(xml),
    series: extractSeries(xml),
    age: extractAudienceAge(xml),
    thema: extractThema(xml),
  };
}

export interface BookMetafield {
  namespace: "bok";
  key: string;
  type: string;
  value: string;
}

/**
 * Metafeltene i navnerommet bok (typene som i definisjonene i butikken).
 * Felt uten verdi i ONIX tas ikke med, så de aldri tømmes av Bokadmin.
 */
export function bookMetafields(f: BookFields): BookMetafield[] {
  const out: BookMetafield[] = [];
  const add = (key: string, type: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") out.push({ namespace: "bok", key, type, value });
  };
  add("forfatter", "list.single_line_text_field", f.authors.length ? JSON.stringify(f.authors) : null);
  add("format", "single_line_text_field", f.format);
  add("sider", "number_integer", f.pages !== null ? String(f.pages) : null);
  add("utgivelsesaar", "number_integer", f.year !== null ? String(f.year) : null);
  add("spraak", "single_line_text_field", f.language);
  add("serie", "single_line_text_field", f.series);
  add("alder", "single_line_text_field", f.age);
  add("thema", "list.single_line_text_field", f.thema.length ? JSON.stringify(f.thema) : null);
  return out;
}

/** Sammenligner en metafeltverdi fra Shopify med ønsket verdi (lister som JSON). */
export function sameMetafieldValue(current: string | null | undefined, wanted: string, type: string): boolean {
  if (current === null || current === undefined) return false;
  if (type.startsWith("list.")) {
    try {
      return JSON.stringify(JSON.parse(current)) === JSON.stringify(JSON.parse(wanted));
    } catch {
      return current === wanted;
    }
  }
  return current.trim() === wanted.trim();
}
