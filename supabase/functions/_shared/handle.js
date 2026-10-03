/* @ts-self-types="./handle.d.ts" */
// supabase/functions/_shared/handle.js
// Felles regel for product handles i Bokadmin 2.0.
//
// Brukes av BÅDE Edge Functions (Deno, eksport til Shopify) og
// scripts/migrate-handles.mjs (Node, migrering av eksisterende katalog),
// slik at nye og migrerte bøker får nøyaktig samme handle.
// Skrevet som ren JavaScript (ESM) med JSDoc, så begge kjøremiljøene kan
// importere den uten byggesteg. Typer for Deno ligger i handle.d.ts.
//
// Regel (se prosjektdokumentet «beslutning-product-handles» og
// «plan-handles-og-seo-eksport»):
//   <hovedtittel>-<første forfatter, fornavn etternavn>-<ISBN-13>
//   - hovedtittel = alt før første kolon, maks 60 tegn, kuttet ved helt ord
//   - æ→ae, ø→o, å→a, andre aksenter fjernes, bare a–z, 0–9 og bindestrek
//   - mangler forfatter: <tittel>-<ISBN-13>
//   - handle lages én gang og endres ikke senere av Bokadmin

import { personAuthors } from "./contributors.js";

export const TITLE_MAX_LENGTH = 60;

const SPECIAL_CHARS = {
  "æ": "ae", "ø": "o", "å": "a", "ä": "a", "ö": "o", "ü": "u",
  "þ": "th", "ð": "d", "ß": "ss", "œ": "oe", "ł": "l", "đ": "d",
  "&": " og ",
};

/**
 * Gjør tekst om til en URL-vennlig slug.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  if (!text) return "";
  let s = String(text).toLowerCase();
  s = s.replace(/[æøåäöüþðßœłđ&]/g, (c) => SPECIAL_CHARS[c] ?? c);
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, ""); // fjern aksenter
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s;
}

/**
 * Kutter en slug til maks lengde ved helt ord (bindestrek).
 * @param {string} slug
 * @param {number} max
 * @returns {string}
 */
export function truncateSlug(slug, max = TITLE_MAX_LENGTH) {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max + 1);
  const lastDash = cut.lastIndexOf("-");
  const result = lastDash > 0 ? cut.slice(0, lastDash) : slug.slice(0, max);
  return result.replace(/-+$/g, "");
}

/**
 * Hovedtittel: alt før første kolon.
 * @param {string} title
 * @returns {string}
 */
export function mainTitle(title) {
  if (!title) return "";
  return String(title).split(":")[0].trim();
}

/**
 * Første forfatter som «Fornavn Etternavn». Institusjoner («Norge», departementer,
 * se contributors.js) regnes ikke som forfatter og hoppes over.
 * Godtar enten en liste (fra metafeltet bok.forfatter, allerede «Fornavn Etternavn»)
 * eller dagens productType-format «Etternavn, Fornavn, Etternavn2, Fornavn2».
 * @param {string[] | string | null | undefined} authors
 * @returns {string}
 */
export function firstAuthor(authors) {
  if (!authors) return "";
  if (Array.isArray(authors)) return personAuthors(authors)[0] ?? "";
  const text = String(authors).trim();
  if (!text) return "";
  // bok.forfatter kan komme som JSON-streng fra metafeltet
  if (text.startsWith("[")) {
    try {
      const list = JSON.parse(text);
      if (Array.isArray(list)) return personAuthors(list.map(String))[0] ?? "";
    } catch { /* ikke JSON, fortsett */ }
  }
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) return personAuthors(parts)[0] ?? "";
  // «Etternavn, Fornavn» → «Fornavn Etternavn»
  return personAuthors([`${parts[1]} ${parts[0]}`.trim()])[0] ?? "";
}

/**
 * Gjør ISBN-10 om til ISBN-13. Returnerer null for ugyldig input.
 * @param {string} isbn10
 * @returns {string | null}
 */
export function isbn10to13(isbn10) {
  const digits = String(isbn10).replace(/[^0-9Xx]/g, "");
  if (digits.length !== 10) return null;
  const core = "978" + digits.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return core + String(check);
}

/**
 * Normaliserer til ISBN-13 (bare sifre). Null hvis det ikke er et ISBN.
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function normalizeIsbn(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^0-9Xx]/g, "").toUpperCase();
  if (/^97[89]\d{10}$/.test(digits) && isValidIsbn13(digits)) return digits;
  if (/^\d{9}[\dX]$/.test(digits) && isValidIsbn10(digits)) return isbn10to13(digits);
  return null;
}

/** @param {string} d 13 sifre */
function isValidIsbn13(d) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(d[12]);
}

/** @param {string} d 10 tegn, siste kan være X */
function isValidIsbn10(d) {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (d[i] === "X" ? 10 : Number(d[i])) * (10 - i);
  return sum % 11 === 0;
}

/**
 * Bygger handle for en bok.
 * @param {{ title: string, authors?: string[] | string | null, isbn: string }} book
 * @returns {string | null} null hvis ISBN mangler
 */
export function buildBookHandle({ title, authors, isbn }) {
  const isbn13 = normalizeIsbn(isbn);
  if (!isbn13) return null;
  const titleSlug = truncateSlug(slugify(mainTitle(title)));
  const authorSlug = slugify(firstAuthor(authors));
  return [titleSlug, authorSlug, isbn13].filter(Boolean).join("-");
}
