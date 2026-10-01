// supabase/functions/_shared/book-cover.ts
// Omslaget (pakke B del 5): alt-tekst og filnavn. Ren TypeScript (testes i scripts/).
//
//   Alt-tekst: «Omslag: {Hovedtittel} av {Forfatter}» (uten forfatter: «Omslag: {Hovedtittel}»)
//   Filnavn:   «{handle}-omslag.{endelse}», endelsen fra dagens fil (jpg som standard)
//
// I 2026-07 kan productUpdate(media:) ikke sette filnavn, men fileUpdate kan
// endre både filnavn og alt-tekst på et eksisterende bilde uten ny opplasting
// (testet i Testbutikk 2026-10-02: samme media-ID, fortsatt koblet til
// produktet, ny URL). Like filnavn er tillatt.

import { mainTitle } from "./handle.js";

export function coverAlt(title: string, authors: readonly string[]): string {
  const main = String(mainTitle(title) || title || "").replace(/\s+/g, " ").trim();
  const author = authors[0]?.trim();
  return author ? `Omslag: ${main} av ${author}` : `Omslag: ${main}`;
}

/** Filnavnet i en Shopify CDN-URL: …/files/jpg.jpg?v=123 → "jpg.jpg". */
export function fileNameFromUrl(url: string | null | undefined): string {
  const path = String(url ?? "").split("?")[0];
  try {
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return path.slice(path.lastIndexOf("/") + 1);
  }
}

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"];

export function coverFilename(handle: string, currentUrl?: string | null): string {
  const name = fileNameFromUrl(currentUrl);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return `${handle}-omslag.${IMAGE_EXTENSIONS.includes(ext) ? ext : "jpg"}`;
}

export interface CoverChange {
  alt?: string;
  filename?: string;
}

/** Hva som må endres på bildet. Tomt objekt = ingenting. */
export function coverChanges(
  current: { alt?: string | null; url?: string | null },
  wanted: { alt: string; filename: string },
): CoverChange {
  const out: CoverChange = {};
  if ((current.alt ?? "").trim() !== wanted.alt) out.alt = wanted.alt;
  if (fileNameFromUrl(current.url) !== wanted.filename) out.filename = wanted.filename;
  return out;
}
