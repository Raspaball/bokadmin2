// supabase/functions/_shared/book-seo.ts
// SEO-tittel og metabeskrivelse for en bok (pakke B del 4), og regelen for når
// Bokadmin kan skrive over det som står i Shopify. Ren TypeScript (testes i scripts/).
//
// Tittel:  «{Hovedtittel} – {Forfatter} ({format})», maks ca. 60 tegn. For lang:
//          dropp formatet; fortsatt for lang: kutt hovedtittelen ved helt ord.
//          Uten forfatter: «{Hovedtittel} ({format})».
// Beskrivelse: høyst 155 tegn. «{Hovedtittel} av {Forfatter} ({format}, {år}). »
//          + starten av forlagsteksten, kuttet ved setningsslutt hvis mulig,
//          ellers ved helt ord med «…». Avsnitt og linjeskift blir mellomrom.
// Manuelle endringer: det Bokadmin sist genererte lagres i bokadmin.seo_auto
// (JSON). Et felt oppdateres bare hvis det er tomt, lik forrige genererte verdi,
// eller lik den gamle automatikken (title_tag = tittelen, description_tag =
// forlagsteksten kuttet på 320 tegn).

import { personAuthors } from "./contributors.js";
import { mainTitle } from "./handle.js";

export const SEO_TITLE_MAX = 60;
export const SEO_DESCRIPTION_MAX = 155;

export interface SeoInput {
  title: string;
  authors: string[];
  format?: string | null;
  year?: number | null;
  /** Forlagsteksten som ren tekst (onixText), kan ha linjeskift */
  description?: string | null;
}

export interface SeoValues {
  title: string;
  description: string;
}

/** Linjeskift, avsnitt og tagger → enkle mellomrom. */
export function plainOneLine(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/<\/(p|li|div|h[1-6])>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Kutter ved helt ord så resultatet er høyst `max` tegn (uten «…»). */
export function cutAtWord(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max + 1);
  const space = slice.lastIndexOf(" ");
  return (space > 0 ? slice.slice(0, space) : t.slice(0, max)).replace(/[\s,;:–-]+$/, "");
}

export function seoTitle({ title, authors, format }: SeoInput): string {
  const main = plainOneLine(mainTitle(title)) || plainOneLine(title);
  const author = personAuthors(authors)[0] || "";
  const fmt = format?.trim() || "";
  const withFormat = (s: string) => (fmt ? `${s} (${fmt})` : s);
  const byline = author ? ` – ${author}` : "";

  const full = withFormat(main + byline);
  if (full.length <= SEO_TITLE_MAX) return full;
  if (author) {
    const noFormat = main + byline;
    if (noFormat.length <= SEO_TITLE_MAX) return noFormat;
    const room = SEO_TITLE_MAX - byline.length;
    if (room >= 15) return cutAtWord(main, room) + byline;
    return cutAtWord(main, SEO_TITLE_MAX);
  }
  return cutAtWord(main, SEO_TITLE_MAX);
}

/** Starten av teksten innen `max` tegn: til setningsslutt hvis den kommer etter halvparten, ellers ved helt ord + «…». */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 2) return "";
  const room = text.slice(0, max);
  let sentenceEnd = -1;
  for (const m of room.matchAll(/[.!?»"”](?=\s|$)/g)) sentenceEnd = m.index! + 1;
  if (sentenceEnd >= max * 0.5) return room.slice(0, sentenceEnd);
  return cutAtWord(text, max - 1) + "…";
}

export function metaDescription({ title, authors, format, year, description }: SeoInput): string {
  const main = plainOneLine(mainTitle(title)) || plainOneLine(title);
  const author = personAuthors(authors)[0] || "";
  const details = [format?.trim(), year ? String(year) : ""].filter(Boolean).join(", ");
  const prefix = `${main}${author ? ` av ${author}` : ""}${details ? ` (${details})` : ""}.`;
  const body = plainOneLine(description);
  if (prefix.length >= SEO_DESCRIPTION_MAX) return cutText(prefix, SEO_DESCRIPTION_MAX);
  if (!body) return prefix;
  return `${prefix} ${cutText(body, SEO_DESCRIPTION_MAX - prefix.length - 1)}`.trim();
}

export function bookSeo(input: SeoInput): SeoValues {
  return { title: seoTitle(input), description: metaDescription(input) };
}

/** Det den gamle automatikken skrev (push før pakke B): tittelen og forlagsteksten kuttet på 320 tegn. */
export function legacySeo(title: string, description: string | null | undefined): SeoValues {
  return { title: title || "", description: String(description ?? "").replace(/\s+/g, " ").trim().slice(0, 320) };
}

/** bokadmin.seo_auto (JSON) → verdiene, eller null. */
export function parseSeoAuto(value: string | null | undefined): Partial<SeoValues> | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    return v && typeof v === "object" ? { title: v.title, description: v.description } : null;
  } catch {
    return null;
  }
}

export interface SeoDecision {
  /** Verdien som skal settes, eller null = la stå */
  title: string | null;
  description: string | null;
  /** «SEO-tittel endret manuelt, ikke overskrevet» osv. */
  notes: string[];
}

/**
 * metafieldsSet-input for beslutningen: global.title_tag / global.description_tag
 * for feltene som skal skrives, og bokadmin.seo_auto (JSON med det Bokadmin
 * genererte) når noe skrives. Tom liste = ingenting å gjøre.
 */
export function seoMetafields(ownerId: string, decision: SeoDecision, wanted: SeoValues) {
  const out: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [];
  if (decision.title !== null) out.push({ ownerId, namespace: "global", key: "title_tag", type: "single_line_text_field", value: decision.title });
  if (decision.description !== null) out.push({ ownerId, namespace: "global", key: "description_tag", type: "single_line_text_field", value: decision.description });
  if (out.length) out.push({ ownerId, namespace: "bokadmin", key: "seo_auto", type: "json", value: JSON.stringify(wanted) });
  return out;
}

const norm = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Hva som skal skrives, felt for felt. Et felt oppdateres bare hvis det i
 * Shopify er tomt, lik forrige genererte verdi (bokadmin.seo_auto) eller lik
 * den gamle automatikken. Er det allerede lik ønsket verdi, skrives ingenting.
 */
export function decideSeo(
  current: { title?: string | null; description?: string | null },
  wanted: SeoValues,
  previousAuto: Partial<SeoValues> | null,
  legacy: SeoValues,
): SeoDecision {
  const notes: string[] = [];
  const pick = (field: "title" | "description", label: string): string | null => {
    const cur = norm(current[field]);
    if (cur === norm(wanted[field])) return null;
    const ours = !cur || cur === norm(previousAuto?.[field]) || cur === norm(legacy[field]);
    if (!ours) {
      notes.push(`${label} endret manuelt, ikke overskrevet`);
      return null;
    }
    return wanted[field];
  };
  return { title: pick("title", "SEO-tittel"), description: pick("description", "Metabeskrivelse"), notes };
}
