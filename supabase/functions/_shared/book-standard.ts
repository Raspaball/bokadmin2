// supabase/functions/_shared/book-standard.ts
// Standarden for en bok i Shopify (pakke B): én ren funksjon som regner ut
// ønsket tilstand fra rå ONIX. Brukes av push og jobben «Oppdater eksisterende
// bøker», og kan senere brukes av bulk-eksport uten å skrive om reglene.
// Ren TypeScript uten Deno-API-er (testes i scripts/).
//
// Pris (pakke A/A2), status og tilgjengelighet (pakke C) og handle hører ikke
// hjemme her og settes aldri av denne modulen.

import {
  extractAudienceAge, extractBokgruppekode, extractContributors, extractLanguage, extractPages, extractProductForm,
  extractPublicationYear, extractSeries, extractThema,
} from "./onix.js";
import { bookFormat, type BookFormat, type BookProductType } from "./book-format.ts";
import { BOKGRUPPE_METAFIELD } from "./bokgruppe.ts";

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
  /** Bokgruppekode (ONIX skjema 37), også som metafelt bok.bokgruppe (pakke F del 2.4) */
  bokgruppe: string | null;
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
    bokgruppe: extractBokgruppekode(xml) || null,
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
  // Samme kode som bkg-taggene, så samlingene senere kan bytte regel fra tagg til metafelt
  add(BOKGRUPPE_METAFIELD.key, BOKGRUPPE_METAFIELD.type, f.bokgruppe);
  return out;
}

// ── Beskrivelse (pakke B del 6) ──────────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Forlagsteksten (ren tekst fra onixText, med \n og \n\n) som HTML: ett <p> per
 * avsnitt, <br> for linjeskift i avsnittet. Teksten HTML-kodes, så & og < vises riktig.
 */
export function descriptionHtml(text: string | null | undefined): string {
  const t = String(text ?? "").replace(/\r/g, "").trim();
  if (!t) return "";
  return t.split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.split("\n").map((l) => escapeHtml(l.trim())).join("<br>")}</p>`)
    .join("\n");
}

/**
 * Reservebeskrivelse når forlagstekst mangler:
 * «{Hovedtittel} av {Forfatter}. {Format}, {sider} sider, utgitt {år} på {forlag}.»
 * Det som mangler utelates.
 */
export function fallbackDescription(title: string, f: Pick<BookFields, "authors" | "format" | "pages" | "year">, publisher?: string | null): string {
  const main = String(title.split(":")[0] ?? title).trim();
  const first = f.authors[0] ? `${main} av ${f.authors[0]}.` : `${main}.`;
  const parts: string[] = [];
  if (f.format && f.format !== "Annet") parts.push(f.format);
  if (f.pages) parts.push(`${f.pages} sider`);
  const published = [f.year ? `utgitt ${f.year}` : "", publisher?.trim() ? `på ${publisher.trim()}` : ""].filter(Boolean).join(" ");
  if (published) parts.push(published);
  if (!parts.length) return first;
  const second = parts.join(", ");
  return `${first} ${second.charAt(0).toUpperCase()}${second.slice(1)}.`;
}

export interface BookDescription {
  html: string;
  /** true = forlagstekst manglet, reservebeskrivelsen er brukt */
  fallback: boolean;
}

export function bookDescription(text: string | null | undefined, title: string, f: Pick<BookFields, "authors" | "format" | "pages" | "year">, publisher?: string | null): BookDescription {
  const html = descriptionHtml(text);
  if (html) return { html, fallback: false };
  return { html: descriptionHtml(fallbackDescription(title, f, publisher)), fallback: true };
}

/** Teksten uten tagger, entiteter og mellomrom: for å se om to beskrivelser bare skiller seg i formatering. */
export function descriptionFingerprint(html: string | null | undefined): string {
  return String(html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, "");
}

/**
 * Kan jobben erstatte beskrivelsen i Shopify? Ja når den er tom, eller når
 * teksten er den samme og bare formateringen er annerledes (avsnitt, linjeskift,
 * sammenlimte setninger), eller når den er Bokadmins reservebeskrivelse.
 * Ellers er den skrevet eller endret av noen andre og får stå.
 */
export function canReplaceDescription(currentHtml: string | null | undefined, wanted: BookDescription, previousFallbackHtml?: string | null): boolean {
  const cur = descriptionFingerprint(currentHtml);
  if (!cur) return true;
  if (cur === descriptionFingerprint(wanted.html)) return true;
  if (previousFallbackHtml && cur === descriptionFingerprint(previousFallbackHtml)) return true;
  return false;
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
