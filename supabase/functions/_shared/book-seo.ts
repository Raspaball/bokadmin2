// supabase/functions/_shared/book-seo.ts
// SEO-tittel og metabeskrivelse for en bok (pakke B del 4), og regelen for når
// Bokadmin kan skrive over det som står i Shopify. Ren TypeScript (testes i scripts/).
//
// Tittel:  «{Hovedtittel} – {Forfatter} ({format})», maks ca. 60 tegn. For lang:
//          dropp formatet; fortsatt for lang: kutt hovedtittelen ved helt ord.
//          Uten forfatter: «{Hovedtittel} ({format})». Formatet «Annet» vises ikke
//          (pakke G del 4a), og institusjoner («Norge») er ikke forfatter (del 3).
// Beskrivelse: høyst 155 tegn, uten HTML. «{Hovedtittel} av {Forfatter} ({format}, {år}). »
//          + starten av forlagsteksten, kuttet ved setningsslutt hvis mulig,
//          ellers ved helt ord med «…». Avsnitt og linjeskift blir mellomrom.
// Manuelle endringer: det Bokadmin sist genererte lagres i bokadmin.seo_auto
// (JSON, bare feltene som faktisk ble skrevet). Et felt oppdateres bare hvis det
// er tomt, lik forrige genererte verdi, eller gammel automatikk (pakke G del 1):
//   SEO-tittel:  tittelen, eller hovedtittelen (før kolon)
//   Beskrivelse: «Kjøp {tittel} hos Bø bok og papir» (gammelt skript), forlagsteksten
//                kuttet på ca. 320 tegn (også med HTML-tagger), eller hele forlagsteksten
// Alt annet er en manuell endring og står.

import { personAuthors } from "./contributors.js";
import { shownFormat } from "./book-format.ts";
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
  const fmt = shownFormat(format);
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

/**
 * Forlagsteksten uten tittelen i starten (tittelen står allerede først i metabeskrivelsen),
 * og med stor forbokstav: «Solaris inneholder en …» → «Inneholder en …». Tittelen fjernes
 * bare som helt ord (ikke «Solaris» i «Solarisen …»), sammen med skilletegnet etter.
 */
export function bodyWithoutTitle(body: string, titles: string[]): string {
  let text = body.trim();
  const candidates = [...new Set(titles.map((t) => plainOneLine(t)).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const t of candidates) {
    if (text.length < t.length || text.slice(0, t.length).toLocaleLowerCase("nb") !== t.toLocaleLowerCase("nb")) continue;
    const rest = text.slice(t.length);
    if (rest && /^[\p{L}\p{N}]/u.test(rest)) continue;
    text = rest.replace(/^[\s.,:;–—-]+/, "");
    break;
  }
  return text.charAt(0).toLocaleUpperCase("nb") + text.slice(1);
}

export function metaDescription({ title, authors, format, year, description }: SeoInput): string {
  const main = plainOneLine(mainTitle(title)) || plainOneLine(title);
  const author = personAuthors(authors)[0] || "";
  const details = [shownFormat(format), year ? String(year) : ""].filter(Boolean).join(", ");
  const prefix = `${main}${author ? ` av ${author}` : ""}${details ? ` (${details})` : ""}.`;
  const body = bodyWithoutTitle(plainOneLine(description), [title, mainTitle(title)]);
  if (prefix.length >= SEO_DESCRIPTION_MAX) return cutText(prefix, SEO_DESCRIPTION_MAX);
  if (!body) return prefix;
  return `${prefix} ${cutText(body, SEO_DESCRIPTION_MAX - prefix.length - 1)}`.trim();
}

export function bookSeo(input: SeoInput): SeoValues {
  return { title: seoTitle(input), description: metaDescription(input) };
}

/**
 * Det den gamle automatikken skrev (push før pakke B og eldre skript). `title` og
 * `description` er den eksakte gamle verdien (tittelen; forlagsteksten kuttet på 320
 * tegn). `titles` og `texts` brukes til å kjenne igjen de andre variantene.
 */
export interface LegacySeo extends SeoValues {
  /** Titlene automatikken brukte (tittelen og hovedtittelen), uten HTML */
  titles: string[];
  /** Forlagsteksten(e) som ble kuttet eller kopiert */
  texts: string[];
}

export function legacySeo(title: string, description: string | null | undefined, extraTexts: Array<string | null | undefined> = []): LegacySeo {
  const titles = [...new Set([plainOneLine(title), plainOneLine(mainTitle(title))].filter(Boolean))];
  const texts = [description, ...extraTexts].map((t) => String(t ?? "")).filter((t) => t.trim());
  return {
    title: title || "",
    description: String(description ?? "").replace(/\s+/g, " ").trim().slice(0, 320),
    titles,
    texts: [...new Set(texts)],
  };
}

const norm = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();
const sameText = (a: string, b: string) => norm(a).toLocaleLowerCase("nb") === norm(b).toLocaleLowerCase("nb");

/** Teksten uten tagger (også en avkuttet tagg på slutten), entiteter og mellomrom: for å sammenligne uavhengig av formatering. */
export function textFingerprint(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/<[^>]*$/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, "");
}

/** «Kjøp {tittel} hos Bø bok og papir»: tittelen inni, eller null. */
export function shopSeoTitle(text: string | null | undefined): string | null {
  return norm(text).match(/^Kjøp (.+?) hos Bø bok og papir\.?$/i)?.[1] ?? null;
}

/** Den gamle automatikken skrev tittelen eller hovedtittelen som SEO-tittel (og «Kjøp … hos Bø bok og papir»). */
export function isLegacySeoTitle(current: string | null | undefined, legacy: SeoValues & Partial<LegacySeo>): boolean {
  const cur = norm(current);
  if (!cur) return true;
  const titles = legacy.titles ?? [legacy.title];
  if (titles.some((t) => t && sameText(t, cur))) return true;
  const shop = shopSeoTitle(cur);
  return shop !== null && titles.some((t) => t && sameText(t, shop));
}

/**
 * Den gamle automatikken skrev som metabeskrivelse: «Kjøp {tittel} hos Bø bok og papir»,
 * forlagsteksten kuttet på ca. 320 tegn (med eller uten HTML), eller hele forlagsteksten.
 * Alt annet (en annen tekst, en egen setning, et sitat) er manuelt.
 */
export function isLegacySeoDescription(current: string | null | undefined, legacy: SeoValues & Partial<LegacySeo>): boolean {
  const cur = norm(current);
  if (!cur) return true;
  const titles = legacy.titles ?? [legacy.title];
  const shop = shopSeoTitle(cur);
  if (shop !== null && titles.some((t) => t && sameText(t, shop))) return true;
  if (cur === norm(legacy.description)) return true;
  const c = textFingerprint(cur);
  if (!c) return false;
  for (const text of legacy.texts ?? [legacy.description]) {
    const t = textFingerprint(text);
    if (!t) continue;
    if (c === t) return true; // hele forlagsteksten, i alle lengder
    // kuttet på 320 tegn: råteksten (med tagger) er ca. 320 tegn og er starten av forlagsteksten
    if (cur.length >= 280 && cur.length <= 340 && c.length >= 60 && t.startsWith(c)) return true;
  }
  return false;
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

/**
 * Reservebeskrivelsen Bokadmin sist skrev (bokadmin.seo_auto.body, pakke H del 3), eller null.
 * Den er «generert»: kan byttes ut når forlagsteksten kommer i ONIX.
 */
export function parseSeoAutoBody(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    return v && typeof v.body === "string" && v.body ? v.body : null;
  } catch {
    return null;
  }
}

/**
 * Ny verdi for bokadmin.seo_auto med reservebeskrivelsen (`body`) satt eller fjernet.
 * `decisionAuto` er verdien fra decideSeo (title/description), `previous` det som står i Shopify.
 * `body`: tekst = lagre, null = fjern, undefined = rør ikke. Returnerer null når seo_auto ikke skal skrives.
 */
export function mergeSeoAutoBody(previous: string | null | undefined, decisionAuto: string | null, body: string | null | undefined): string | null {
  if (body === undefined) return decisionAuto;
  let base: Record<string, unknown> = {};
  try {
    const b = JSON.parse(decisionAuto ?? previous ?? "{}");
    if (b && typeof b === "object") base = b;
  } catch { /* ugyldig JSON: begynn på nytt */ }
  if (body) base.body = body; else delete base.body;
  const out = JSON.stringify(base);
  return out === (previous ?? null) ? null : out;
}

export interface SeoDecision {
  /** Verdien som skal settes, eller null = la stå */
  title: string | null;
  description: string | null;
  /** «SEO-tittel endret manuelt, ikke overskrevet» osv. */
  notes: string[];
  /** Ny verdi for bokadmin.seo_auto (JSON) når noe skrives, ellers null */
  auto: string | null;
}

/**
 * metafieldsSet-input for beslutningen: global.title_tag / global.description_tag
 * for feltene som skal skrives, og bokadmin.seo_auto når noe skrives. seo_auto har
 * bare feltene Bokadmin faktisk har skrevet (eller som allerede var lik det genererte),
 * slik at en manuelt stående verdi aldri ser ut som «forrige genererte».
 * Tom liste = ingenting å gjøre.
 */
export function seoMetafields(ownerId: string, decision: SeoDecision) {
  const out: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [];
  if (decision.title !== null) out.push({ ownerId, namespace: "global", key: "title_tag", type: "single_line_text_field", value: decision.title });
  if (decision.description !== null) out.push({ ownerId, namespace: "global", key: "description_tag", type: "single_line_text_field", value: decision.description });
  if (out.length && decision.auto) out.push({ ownerId, namespace: "bokadmin", key: "seo_auto", type: "json", value: decision.auto });
  return out;
}

/**
 * Hva som skal skrives, felt for felt. Et felt oppdateres bare hvis det i
 * Shopify er tomt, lik forrige genererte verdi (bokadmin.seo_auto) eller gammel
 * automatikk (isLegacySeoTitle / isLegacySeoDescription). Er det allerede lik
 * ønsket verdi, skrives ingenting.
 */
export function decideSeo(
  current: { title?: string | null; description?: string | null },
  wanted: SeoValues,
  previousAuto: Partial<SeoValues> | null,
  legacy: SeoValues & Partial<LegacySeo>,
): SeoDecision {
  const notes: string[] = [];
  const auto: Partial<SeoValues> = { ...(previousAuto ?? {}) };
  let written = false;
  const pick = (field: "title" | "description", label: string): string | null => {
    const cur = norm(current[field]);
    if (cur === norm(wanted[field])) {
      auto[field] = wanted[field];
      return null;
    }
    const old = field === "title" ? isLegacySeoTitle(cur, legacy) : isLegacySeoDescription(cur, legacy);
    if (!(!cur || cur === norm(previousAuto?.[field]) || old)) {
      notes.push(`${label} endret manuelt, ikke overskrevet`);
      return null;
    }
    auto[field] = wanted[field];
    written = true;
    return wanted[field];
  };
  const title = pick("title", "SEO-tittel");
  const description = pick("description", "Metabeskrivelse");
  return { title, description, notes, auto: written ? JSON.stringify(auto) : null };
}
