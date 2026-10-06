/* @ts-self-types="./onix.d.ts" */
// supabase/functions/_shared/onix.js
// Felles lesing av ONIX fra Bokbasen. Ren JavaScript (ESM), slik at både
// Edge Functions (Deno) og testene i scripts/ (Node) kan importere den.
//
// Bokgruppekode: SubjectSchemeIdentifier 37 i ONIX-kodeliste 27 =
// «Bokgrupper» (Forleggerforeningen), 1–3 sifre — de samme kodene som
// bkg-taggene og de smarte samlingene bruker. Kontrollert mot rå ONIX
// 2026-10-01: 37 fantes i alle 89 postene som ble hentet (nye og eldre
// titler, alle typer), skjema 23 («Publisher's own category code») i ingen.
// Derfor ingen reserve til 23. 38 er varegrupper (5 sifre), ikke bokgrupper.

import { institutionReason } from "./contributors.js";

export const BOKGRUPPE_SCHEME = "37";

/** Fjerner xmlns-attributter og navneromsprefikser (<onix:Product> → <Product>). */
export function stripNamespaces(xml) {
  return String(xml ?? "")
    .replace(/\s+xmlns[^"]*"[^"]*"/g, "")
    .replace(/<(\w+:)/g, "<")
    .replace(/<\/(\w+:)/g, "</");
}

/** Navngitte HTML-entiteter for bokstaver (store og små bokstaver teller), for dobbeltkodet tekst. */
const LATIN_ENTITIES = {
  oslash: "ø", Oslash: "Ø", aring: "å", Aring: "Å", aelig: "æ", AElig: "Æ",
  eacute: "é", Eacute: "É", egrave: "è", Egrave: "È", ecirc: "ê", euml: "ë",
  aacute: "á", Aacute: "Á", agrave: "à", acirc: "â", auml: "ä", Auml: "Ä",
  ouml: "ö", Ouml: "Ö", oacute: "ó", ograve: "ò", ocirc: "ô",
  uuml: "ü", Uuml: "Ü", uacute: "ú", ugrave: "ù", ucirc: "û",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", ccedil: "ç", ntilde: "ñ", szlig: "ß",
  hellip: "…", ndash: "–", mdash: "—", laquo: "«", raquo: "»",
};

/**
 * Tekst fra et ONIX-felt som ren tekst med avsnitt: CDATA pakkes ut, kodet HTML
 * (&lt;br&gt;) blir tagger, <br> → linjeskift, </p> </li> </div> </hN> → tomt
 * linjeskift (avsnitt), andre tagger fjernes, entiteter dekodes. Linjeskift i
 * XML-kilden er formatering og blir mellomrom. Flyttet uendret fra importen
 * (bokbasen/index.ts, stripText) i pakke B.
 * @param {string} value
 * @returns {string}
 */
export function onixText(value) {
  // 1. CDATA
  let s = String(value ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
  // 2. &lt;/&gt; → tagger, så kodet HTML kan fjernes
  s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  // 3. Semantiske skift som plassholdere før taggene fjernes: \x01 = linjeskift, \x02 = avsnitt
  s = s
    .replace(/<br\s*\/?>/gi, "\x01")
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\x02")
    .replace(/<[^>]+>/g, "");
  // 4. Linjeskift i XML-kilden er formatering → mellomrom
  s = s.replace(/[\r\n\t]+/g, " ");
  // 5. Navngitte entiteter
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&shy;/gi, "")
    .replace(/&zwj;/gi, "")
    .replace(/&zwnj;/gi, "")
    .replace(/&laquo;/gi, "«")
    .replace(/&raquo;/gi, "»")
    .replace(/&ldquo;/gi, "“")
    .replace(/&rdquo;/gi, "”")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rsquo;/gi, "’")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&hellip;/gi, "…")
    .replace(/&bull;/gi, "•")
    .replace(/&middot;/gi, "·")
    .replace(/&infin;/gi, "∞")
    .replace(/&copy;/gi, "©")
    .replace(/&reg;/gi, "®")
    .replace(/&trade;/gi, "™")
    .replace(/&euro;/gi, "€");
  // 6. Tallreferanser
  s = s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&#([0-9]+);/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ""; }
    });
  // 6b. Dobbeltkodede entiteter (Bokbasen har f.eks. «f&amp;oslash;dsel» og «&amp;amp;» i noen forlagstekster):
  //     etter &amp; → & står «&oslash;» igjen. Pakke G del 1: dekodes her, ellers ble teksten vist med «&oslash;».
  s = s
    .replace(/&([A-Za-z]+);/g, (m, name) => LATIN_ENTITIES[name] ?? m)
    .replace(/&amp;/g, "&");
  // 7. Usynlige tegn
  s = s.replace(/­/g, "").replace(/​/g, "").replace(/‌/g, "").replace(/‍/g, "");
  // 8. Skift tilbake, rydd mellomrom
  return s
    .replace(/\x01/g, "\n")
    .replace(/\x02/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Produkttittelen: TitleDetail med TitleType 01 i DescriptiveDetail (serier
 * fjernes først), TitleElement på nivå 01. Prefiks + tittel uten prefiks, og
 * undertittel etter kolon: «Gleden med skjeden: Alt om …». Flyttet uendret fra importen.
 * @param {string} xml
 * @returns {string}
 */
export function extractTitle(xml) {
  const x = stripNamespaces(xml);
  const field = (block, tag) => onixText(block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"))?.[1] || "");
  let title = "";
  const dd = x.match(/<DescriptiveDetail[\s\S]*?<\/DescriptiveDetail>/i);
  if (dd) {
    const ddStripped = dd[0].replace(/<Collection[\s\S]*?<\/Collection>/gi, "");
    for (const td of ddStripped.matchAll(/<TitleDetail[\s\S]*?<\/TitleDetail>/gi)) {
      const ttype = td[0].match(/<TitleType[^>]*>(.*?)<\/TitleType>/i)?.[1]?.trim();
      if (ttype !== "01") continue;
      for (const te of td[0].matchAll(/<TitleElement[\s\S]*?<\/TitleElement>/gi)) {
        const level = te[0].match(/<TitleElementLevel[^>]*>(.*?)<\/TitleElementLevel>/i)?.[1]?.trim();
        if (level && level !== "01") continue;
        const prefix = field(te[0], "TitlePrefix");
        const withoutPrefix = field(te[0], "TitleWithoutPrefix");
        const titleText = field(te[0], "TitleText");
        const subtitle = field(te[0], "Subtitle");
        const baseTitle = (prefix && withoutPrefix) ? `${prefix} ${withoutPrefix}` : (withoutPrefix || titleText);
        const full = [baseTitle, subtitle].filter(Boolean).join(": ");
        if (full) { title = full; break; }
      }
      if (!title) {
        title = [field(td[0], "TitleText"), field(td[0], "Subtitle")].filter(Boolean).join(": ");
      }
      if (title) break;
    }
  }
  if (!title) title = [field(x, "TitleText"), field(x, "Subtitle")].filter(Boolean).join(": ");
  return title;
}

/**
 * Forlagsteksten som ren tekst med avsnitt (onixText). ONIX 3 TextContent:
 * TextType 03, så 02, så 01; ONIX 2.1 OtherText: 03, så 01, så 02. Ellers
 * første tekst som ikke er anmeldelse/omtale (06–08, 11–14). "" uten tekst.
 * Flyttet uendret fra importen.
 * @param {string} xml
 * @returns {string}
 */
export function extractDescription(xml) {
  const x = stripNamespaces(xml);
  const TEXT_RE = /<Text(?![A-Za-z])[^>]*>([\s\S]*?)<\/Text>/i;
  const pick = (cands, priority) => {
    for (const wanted of priority) {
      const hit = cands.find((b) => b.type === wanted && b.text);
      if (hit) return hit.text;
    }
    const nonReview = cands.find((b) => b.text && !["06", "07", "08", "11", "12", "13", "14"].includes(b.type));
    return nonReview?.text || cands.find((b) => b.text)?.text || "";
  };
  const collect = (blockRe, typeRe) => {
    const cands = [];
    for (const block of x.matchAll(blockRe)) {
      const type = block[0].match(typeRe)?.[1]?.trim() || "";
      const text = onixText(block[0].match(TEXT_RE)?.[1] || "");
      if (text) cands.push({ type, text });
    }
    return cands;
  };
  const onix3 = collect(/<TextContent[\s\S]*?<\/TextContent>/gi, /<TextType(?![A-Za-z])[^>]*>(.*?)<\/TextType>/i);
  let description = onix3.length ? pick(onix3, ["03", "02", "01"]) : "";
  if (!description) {
    const onix2 = collect(/<OtherText[\s\S]*?<\/OtherText>/gi, /<TextTypeCode[^>]*>(.*?)<\/TextTypeCode>/i);
    if (onix2.length) description = pick(onix2, ["03", "01", "02"]);
  }
  return description;
}

/** Forlaget (PublisherName), eller "". */
export function extractPublisher(xml) {
  return onixText(stripNamespaces(xml).match(/<PublisherName[^>]*>([\s\S]*?)<\/PublisherName>/i)?.[1] || "");
}

/**
 * Første bokgruppekode (skjema 37) i ONIX-teksten, eller null.
 * Teksten kan være en hel melding eller én <Product>-blokk; ved flere
 * produkter i én melding må hver blokk sendes inn for seg.
 * @param {string} xml
 * @returns {string | null}
 */
export function extractBokgruppekode(xml) {
  for (const s of stripNamespaces(xml).matchAll(/<Subject(?:\s[^>]*)?>[\s\S]*?<\/Subject>/gi)) {
    const scheme = s[0].match(/<SubjectSchemeIdentifier[^>]*>\s*(.*?)\s*<\/SubjectSchemeIdentifier>/i)?.[1];
    const code = s[0].match(/<SubjectCode[^>]*>\s*(.*?)\s*<\/SubjectCode>/i)?.[1];
    if (scheme === BOKGRUPPE_SCHEME && code && /^\d{1,3}$/.test(code)) return code;
  }
  return null;
}

/** Vanlige XML-entiteter i tekstfelt (&amp; &lt; &gt; &quot; &apos; og tallreferanser). */
export function decodeXmlText(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** «Brochmann, Nina» → «Nina Brochmann». Uten komma kommer teksten uendret tilbake. */
export function uninvertName(inverted) {
  const text = String(inverted ?? "").trim();
  const i = text.indexOf(",");
  if (i < 0) return text;
  const last = text.slice(0, i).trim();
  const first = text.slice(i + 1).trim();
  return [first, last].filter(Boolean).join(" ");
}

/**
 * Én <Contributor>-blokk: navnet som «Fornavn Etternavn» og om det er en institusjon
 * (CorporateName uten personnavn, eller kjent institusjonsnavn,
 * se contributors.js). Tomt navn gir name "".
 */
function parseContributor(block) {
  const tag = (t) => decodeXmlText(block.match(new RegExp("<" + t + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + t + ">", "i"))?.[1] ?? "").trim();
  const nameType = block.match(/<NameType[^>]*>\s*([^<]+?)\s*<\/NameType>/i)?.[1] ?? null;
  const person = tag("PersonName");
  const inverted = tag("PersonNameInverted");
  const before = tag("NamesBeforeKey");
  const key = tag("KeyNames");
  let name = person || (inverted ? uninvertName(inverted) : "") || (before || key ? [before, key].filter(Boolean).join(" ") : "");
  const corporate = !name;
  if (corporate) name = tag("CorporateName");
  return { name, corporate, nameType, reason: name ? institutionReason({ name, corporate }) : null };
}

/**
 * Alle bidragsytere i ONIX (personer og institusjoner) i rekkefølge
 * (SequenceNumber, ellers rekkefølgen i ONIX): { role, name, order, institution }.
 * `institution` er årsaken («CorporateName» …) eller null for personer.
 * @param {string} xml
 * `corporate`: navnet står som CorporateName. Et CorporateName som ikke er en organisasjon
 * (en tittel i feil felt, `institution` er null) regnes ikke som forfatter heller.
 * @returns {{ role: string | null, name: string, order: number, institution: string | null, corporate: boolean }[]}
 */
export function extractAllContributors(xml) {
  const list = [];
  let index = 0;
  for (const m of stripNamespaces(xml).matchAll(/<Contributor(?:\s[^>]*)?>[\s\S]*?<\/Contributor>/gi)) {
    const block = m[0];
    const role = block.match(/<ContributorRole[^>]*>\s*([^<]+?)\s*<\/ContributorRole>/i)?.[1] ?? null;
    const seq = parseInt(block.match(/<SequenceNumber[^>]*>\s*(\d+)\s*<\/SequenceNumber>/i)?.[1] ?? "", 10);
    const c = parseContributor(block);
    if (c.name) list.push({ role, name: c.name, order: Number.isFinite(seq) ? seq : 100000 + index, institution: c.reason, corporate: c.corporate });
    index++;
  }
  list.sort((a, b) => a.order - b.order);
  return list;
}

/**
 * Forfatterne i rekkefølge, som «Fornavn Etternavn»: PersonName, ellers snudd
 * PersonNameInverted, ellers NamesBeforeKey + KeyNames. BARE PERSONER (pakke G del 3):
 * institusjoner (CorporateName, kjente navn som «Norge») tas ikke med
 * og returneres i `institutions`. En bok som bare har institusjon, får tom liste.
 * Bare rolle A01 (forfatter). Finnes ingen A01-person, brukes første person uansett
 * rolle (f.eks. B01 redaktør), og rollen står i `role`.
 * Hos Bokbasen (103 poster, 2026-10-02) står navnene nesten alltid som
 * PersonNameInverted («Brochmann, Nina»).
 * @param {string} xml
 * @returns {{ authors: string[], role: string | null, institutions: { name: string, role: string | null, reason: string }[] }}
 */
export function extractContributors(xml) {
  const all = extractAllContributors(xml);
  const institutions = all.filter((c) => c.institution).map((c) => ({ name: c.name, role: c.role, reason: c.institution }));
  const people = all.filter((c) => !c.institution && !c.corporate);
  const authors = people.filter((c) => c.role === "A01").map((c) => c.name);
  if (authors.length) return { authors, role: "A01", institutions };
  if (people.length) return { authors: [people[0].name], role: people[0].role, institutions };
  return { authors: [], role: null, institutions };
}

/**
 * Alle bidragsyternavn slik de står i ONIX som «Etternavn, Fornavn»
 * (PersonNameInverted, ellers KeyNames, NamesBeforeKey). Brukes til å kjenne
 * igjen gamle forfattertagger med sammensatte etternavn («Hove Christensen, Mia»),
 * der snuing av «Fornavn Etternavn» gir feil skille.
 * @param {string} xml
 * @returns {string[]}
 */
export function extractInvertedNames(xml) {
  const out = [];
  for (const m of stripNamespaces(xml).matchAll(/<Contributor(?:\s[^>]*)?>[\s\S]*?<\/Contributor>/gi)) {
    const tag = (t) => decodeXmlText(m[0].match(new RegExp("<" + t + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + t + ">", "i"))?.[1] ?? "").trim();
    const inverted = tag("PersonNameInverted");
    const key = tag("KeyNames"), before = tag("NamesBeforeKey");
    const name = inverted || (key && before ? `${key}, ${before}` : "");
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Tilgjengelighetskoden (ONIX List 65): første <ProductAvailability> i en
 * <SupplyDetail>, eller null. Samme lesing som importen og tilgjengelighets-
 * sjekken har brukt; regelen for koden står i availability.ts.
 * @param {string} xml
 * @returns {string | null}
 */
export function extractAvailabilityCode(xml) {
  for (const s of stripNamespaces(xml).matchAll(/<SupplyDetail[\s\S]*?<\/SupplyDetail>/gi)) {
    const code = s[0].match(/<ProductAvailability[^>]*>\s*(\d+)\s*<\/ProductAvailability>/i)?.[1];
    if (code) return code;
  }
  return null;
}

/** Hel dato (YYYYMMDD, også starten av YYYYMMDDThhmm…) → "YYYY-MM-DD", ellers null. */
function fullDate(raw) {
  const m = String(raw ?? "").trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31 ? `${y}-${mo}-${d}` : null;
}

/** Datoen i den første blokken <tag> med <roleTag> = role, som hel dato eller null. */
function roleDate(xml, tag, roleTag, role) {
  const re = new RegExp(String.raw`<${tag}(?:\s[^>]*)?>[\s\S]*?<\/${tag}>`, "gi");
  for (const b of xml.matchAll(re)) {
    const r = b[0].match(new RegExp(String.raw`<${roleTag}[^>]*>\s*(\d+)\s*<\/${roleTag}>`, "i"))?.[1];
    if (r !== role) continue;
    const d = fullDate(b[0].match(/<Date(?:\s[^>]*)?>\s*([^<]+?)\s*<\/Date>/i)?.[1]);
    if (d) return d;
  }
  return null;
}

/** Årstallet (4 siffer i starten) i den første blokken <tag> med <roleTag> = role, eller null. */
function roleYear(xml, tag, roleTag, role) {
  for (const b of blocks(xml, tag)) {
    if (firstText(b, roleTag) !== role) continue;
    const y = firstText(b, "Date").match(/^(\d{4})/)?.[1];
    if (y) return parseInt(y, 10);
  }
  return null;
}

/**
 * Utgivelsesår og utgivelsesdato (pakke H, etter sjekkrapport 06.10; erstatter pakke G del 4b).
 * PublishingDate rolle 11 hos Bokbasen er ofte en registrerings- eller importdato, ikke
 * utgivelsen: 9781847940933 (Getting to Yes) har rolle 01 = 2012 i begge poster og rolle 11 =
 * 20180105 og 20170421. Regler, i rekkefølge:
 *   1. Kommende bok (ProductAvailability 10–12) med MarketDate rolle 01 som hel dato: den gir
 *      dato og år (tidligste hvis flere).
 *   2. Ellers, når året i rolle 01 og datoen (rolle 11) er like eller 1 år fra hverandre: dato og
 *      år fra datoen.
 *   3. Er de 2 år eller mer fra hverandre: år = rolle 01 og ingen dato (`check` = true, boka
 *      legges på kontrollisten scripts/out/utgivelsesaar-kontroll.csv).
 *   4. Finnes bare én av dem: bruk den (bare rolle 01 gir bare år).
 *   5. Flere <Product> i ONIX: alle leses. År = rolle 01-året flest poster har (likt antall:
 *      det laveste). Dato = den tidligste som passer med regel 2. (`products` > 1)
 * Datoen er rolle 11, ellers (ONIX 3 uten rolle 11) PublishingDate 01 som hel dato, MarketDate 01,
 * og PublicationDate (ONIX 2.1). Brukes av push, bokdata og tilgjengelighet via
 * extractPublishingDate / extractPublicationYear.
 * @param {string} xml
 * @returns {{ year: number | null, date: string | null, rule: 0 | 1 | 2 | 3 | 4, products: number, check: boolean, role01Year: number | null, role11Date: string | null }}
 */
export function resolvePublication(xml) {
  const x = stripNamespaces(xml);
  const prods = blocks(x, "Product");
  const list = prods.length ? prods : [x];
  const info = list.map((p) => {
    const year01 = roleYear(p, "PublishingDate", "PublishingDateRole", "01");
    const full01 = roleDate(p, "PublishingDate", "PublishingDateRole", "01");
    const market = roleDate(p, "MarketDate", "MarketDateRole", "01");
    const d11 = roleDate(p, "PublishingDate", "PublishingDateRole", "11");
    const pub21 = fullDate(firstText(p, "PublicationDate"));
    const year21 = firstText(p, "PublicationDate").match(/^(\d{4})/)?.[1];
    return { year01: year01 ?? (year21 ? parseInt(year21, 10) : null), market, date: full01 ?? d11 ?? market ?? pub21 };
  });
  const base = { products: list.length, check: false };
  const yearOf = (d) => parseInt(d.slice(0, 4), 10);
  const role11 = (() => { const d = info.map((i) => i.date).filter(Boolean).sort(); return d[0] ?? null; })();
  const out = (r) => ({ ...base, role01Year: null, role11Date: role11, ...r });

  // 1. Kommende bok med MarketDate 01
  const code = extractAvailabilityCode(x);
  if (code && ["10", "11", "12"].includes(code)) {
    const m = info.map((i) => i.market).filter(Boolean).sort()[0];
    if (m) return out({ year: yearOf(m), date: m, rule: 1 });
  }

  // År: det rolle 01-året flest poster har (likt antall: det laveste)
  const counts = new Map();
  for (const i of info) if (i.year01 != null) counts.set(i.year01, (counts.get(i.year01) ?? 0) + 1);
  const y01 = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  const dates = info.map((i) => i.date).filter(Boolean).sort();

  if (y01 == null && !dates.length) return out({ year: null, date: null, rule: 0 });
  if (y01 == null) return out({ year: yearOf(dates[0]), date: dates[0], rule: 4 });
  if (!dates.length) return out({ year: y01, date: null, rule: 4, role01Year: y01 });
  const fitting = dates.filter((d) => Math.abs(yearOf(d) - y01) <= 1);
  if (fitting.length) return out({ year: yearOf(fitting[0]), date: fitting[0], rule: 2, role01Year: y01 });
  return out({ year: y01, date: null, rule: 3, check: true, role01Year: y01 });
}

/**
 * Utgivelsesdato som "YYYY-MM-DD", eller null (bare årstall, eller datoen er mistenkelig).
 * Regelen står i resolvePublication.
 * @param {string} xml
 * @returns {string | null}
 */
export function extractPublishingDate(xml) {
  return resolvePublication(xml).date;
}

// ── Bokfeltene (pakke B del 2) ───────────────────────────────────────────────
// Kontrollert mot 103 rå ONIX 3.1-poster fra Bokbasen (2026-10-02). Funnene
// står i BOKADMIN2_OPPSETT.md («Pakke B»).

/** Første tekst i <tag> (uten attributter i navnet), dekodet og trimmet, eller "". */
function firstText(xml, tag) {
  const m = xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"));
  return m ? decodeXmlText(m[1]).trim() : "";
}

/** Alle blokker <tag>…</tag>. */
function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp("<" + tag + "(?:\\s[^>]*)?>[\\s\\S]*?</" + tag + ">", "gi"))].map((m) => m[0]);
}

/**
 * ISBN-13 for utgaver som erstatter denne boka: RelatedProduct med ProductRelationCode 05
 * («Replaced by», List 51), identifisert med ProductIDType 15 (ISBN-13) eller 03 (GTIN-13).
 * @param {string} xml
 * @returns {string[]}
 */
export function extractReplacedBy(xml) {
  const x = stripNamespaces(xml);
  const out = [];
  for (const rel of blocks(x, "RelatedProduct")) {
    if (firstText(rel, "ProductRelationCode") !== "05") continue;
    for (const id of blocks(rel, "ProductIdentifier")) {
      const type = firstText(id, "ProductIDType");
      const value = firstText(id, "IDValue").replace(/[-\s]/g, "");
      if ((type === "15" || type === "03") && /^\d{13}$/.test(value) && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

/**
 * ProductForm (List 150) og ProductFormDetail (List 175).
 * @param {string} xml
 * @returns {{ form: string | null, details: string[] }}
 */
export function extractProductForm(xml) {
  const x = stripNamespaces(xml);
  const form = firstText(x, "ProductForm") || null;
  const details = [...x.matchAll(/<ProductFormDetail[^>]*>\s*([^<]+?)\s*<\/ProductFormDetail>/gi)].map((m) => m[1]);
  return { form, details };
}

/**
 * Sidetall: Extent med type 00 (hovedinnhold), ellers 07 (absolutt), ellers 08
 * (sidetall i trykt utgave, f.eks. for e-bøker), og enhet 03 (sider). null ellers.
 * @param {string} xml
 * @returns {number | null}
 */
export function extractPages(xml) {
  const found = {};
  for (const b of blocks(stripNamespaces(xml), "Extent")) {
    const type = firstText(b, "ExtentType");
    const unit = firstText(b, "ExtentUnit");
    const value = parseInt(firstText(b, "ExtentValue"), 10);
    if (unit === "03" && Number.isFinite(value) && value > 0 && found[type] === undefined) found[type] = value;
  }
  return found["00"] ?? found["07"] ?? found["08"] ?? null;
}

/**
 * Utgivelsesår (bok.utgivelsesaar): fra samme regel som utgivelsesdatoen (resolvePublication).
 * @param {string} xml
 * @returns {number | null}
 */
export function extractPublicationYear(xml) {
  return resolvePublication(xml).year;
}

/** ISO 639-2/B-koder → norsk språknavn. Ukjente koder vises som koden. */
export const LANGUAGE_NAMES = {
  nob: "Bokmål", nno: "Nynorsk", nor: "Norsk", eng: "Engelsk", swe: "Svensk", dan: "Dansk",
  ger: "Tysk", deu: "Tysk", fre: "Fransk", fra: "Fransk", spa: "Spansk", ita: "Italiensk",
  rus: "Russisk", fin: "Finsk", isl: "Islandsk", ice: "Islandsk", dut: "Nederlandsk", nld: "Nederlandsk",
  por: "Portugisisk", pol: "Polsk", ara: "Arabisk", sme: "Nordsamisk", smj: "Lulesamisk", sma: "Sørsamisk",
  lat: "Latin", gre: "Gresk", ell: "Gresk", chi: "Kinesisk", zho: "Kinesisk", jpn: "Japansk",
  mul: "Flere språk",
};

/**
 * Språket boka er skrevet på: Language med rolle 01, som norsk navn.
 * @param {string} xml
 * @returns {string | null}
 */
export function extractLanguage(xml) {
  for (const b of blocks(stripNamespaces(xml), "Language")) {
    if (firstText(b, "LanguageRole") !== "01") continue;
    const code = firstText(b, "LanguageCode").toLowerCase();
    if (code) return LANGUAGE_NAMES[code] ?? code;
  }
  return null;
}

/**
 * Serie: Collection med CollectionType 10 (forlagets serie), ellers 20
 * (tilordnet av Bokbasen). Type 11 (forlagsrekker som «Cap-serien», «Pekebok»)
 * brukes ikke. Med nummer: «Ingrid Winter (5)». ONIX 2.1: Series/TitleOfSeries.
 * @param {string} xml
 * @returns {string | null}
 */
export function extractSeries(xml) {
  const x = stripNamespaces(xml);
  const collections = blocks(x, "Collection").map((b) => ({
    type: firstText(b, "CollectionType"),
    title: firstText(b, "TitleText"),
    part: firstText(b, "PartNumber"),
  })).filter((c) => c.title);
  const pick = collections.find((c) => c.type === "10") ?? collections.find((c) => c.type === "20");
  if (pick) return pick.part ? `${pick.title} (${pick.part})` : pick.title;
  const series = blocks(x, "Series")[0];
  if (series) {
    const title = firstText(series, "TitleOfSeries");
    const part = firstText(series, "NumberWithinSeries");
    if (title) return part ? `${title} (${part})` : title;
  }
  return null;
}

/**
 * Aldersgruppe fra AudienceRange med kvalifikator 17 (interessealder, år):
 * presisjon 01 = nøyaktig, 03 = fra, 04 = til. Flere områder slås sammen
 * (laveste fra, høyeste til). «6–9 år», «fra 12 år», «til 3 år», «5 år».
 * Alle poster med Thema-alder (5A…) hadde også AudienceRange, så Thema brukes ikke.
 * @param {string} xml
 * @returns {string | null}
 */
export function extractAudienceAge(xml) {
  let from = null;
  let to = null;
  for (const b of blocks(stripNamespaces(xml), "AudienceRange")) {
    if (firstText(b, "AudienceRangeQualifier") !== "17") continue;
    const precisions = [...b.matchAll(/<AudienceRangePrecision[^>]*>\s*(\d+)\s*<\/AudienceRangePrecision>/gi)].map((m) => m[1]);
    const values = [...b.matchAll(/<AudienceRangeValue[^>]*>\s*(\d+)\s*<\/AudienceRangeValue>/gi)].map((m) => parseInt(m[1], 10));
    precisions.forEach((p, i) => {
      const v = values[i];
      if (!Number.isFinite(v)) return;
      if (p === "01" || p === "03") from = from === null ? v : Math.min(from, v);
      if (p === "01" || p === "04") to = to === null ? v : Math.max(to, v);
    });
  }
  if (from !== null && to !== null) return from === to ? `${from} år` : `${from}–${to} år`;
  if (from !== null) return `fra ${from} år`;
  if (to !== null) return `til ${to} år`;
  return null;
}

/**
 * Thema-koder: Subject med skjema 93 (emne) og 94–99 (kvalifikatorer: sted,
 * språk, tid, utdanning, interesse/alder, stil), i rekkefølge, uten duplikater.
 * @param {string} xml
 * @returns {string[]}
 */
export function extractThema(xml) {
  const codes = [];
  for (const b of blocks(stripNamespaces(xml), "Subject")) {
    const scheme = firstText(b, "SubjectSchemeIdentifier");
    if (!/^9[3-9]$/.test(scheme)) continue;
    const code = firstText(b, "SubjectCode");
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}
