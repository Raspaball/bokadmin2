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

export const BOKGRUPPE_SCHEME = "37";

/** Fjerner xmlns-attributter og navneromsprefikser (<onix:Product> → <Product>). */
export function stripNamespaces(xml) {
  return String(xml ?? "")
    .replace(/\s+xmlns[^"]*"[^"]*"/g, "")
    .replace(/<(\w+:)/g, "<")
    .replace(/<\/(\w+:)/g, "</");
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

/** Navnet på én <Contributor>-blokk som «Fornavn Etternavn», eller "". */
function contributorName(block) {
  const tag = (t) => decodeXmlText(block.match(new RegExp("<" + t + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + t + ">", "i"))?.[1] ?? "").trim();
  const person = tag("PersonName");
  if (person) return person;
  const inverted = tag("PersonNameInverted");
  if (inverted) return uninvertName(inverted);
  const before = tag("NamesBeforeKey");
  const key = tag("KeyNames");
  if (before || key) return [before, key].filter(Boolean).join(" ");
  return tag("CorporateName");
}

/**
 * Forfatterne i rekkefølge (SequenceNumber, ellers rekkefølgen i ONIX), som
 * «Fornavn Etternavn»: PersonName, ellers snudd PersonNameInverted, ellers
 * NamesBeforeKey + KeyNames, ellers CorporateName.
 * Bare rolle A01 (forfatter). Finnes ingen A01, brukes første bidragsyter
 * uansett rolle (f.eks. B01 redaktør), og rollen står i `role`.
 * Hos Bokbasen (103 poster, 2026-10-02) står navnene nesten alltid som
 * PersonNameInverted («Brochmann, Nina»).
 * @param {string} xml
 * @returns {{ authors: string[], role: string | null }}
 */
export function extractContributors(xml) {
  const list = [];
  let index = 0;
  for (const m of stripNamespaces(xml).matchAll(/<Contributor(?:\s[^>]*)?>[\s\S]*?<\/Contributor>/gi)) {
    const block = m[0];
    const role = block.match(/<ContributorRole[^>]*>\s*([^<]+?)\s*<\/ContributorRole>/i)?.[1] ?? null;
    const seq = parseInt(block.match(/<SequenceNumber[^>]*>\s*(\d+)\s*<\/SequenceNumber>/i)?.[1] ?? "", 10);
    const name = contributorName(block);
    if (name) list.push({ role, name, order: Number.isFinite(seq) ? seq : 100000 + index });
    index++;
  }
  list.sort((a, b) => a.order - b.order);
  const authors = list.filter((c) => c.role === "A01").map((c) => c.name);
  if (authors.length) return { authors, role: "A01" };
  if (list.length) return { authors: [list[0].name], role: list[0].role };
  return { authors: [], role: null };
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

/**
 * Utgivelsesdato som "YYYY-MM-DD", eller null når ONIX bare har årstall.
 * Rekkefølge (kontrollert mot 206 rå ONIX 3.1-poster fra Bokbasen 2026-10-02):
 *   1. PublishingDate rolle 01 (utgivelsesdato), hvis den er en hel dato.
 *      Hos Bokbasen er den alltid bare årstall (dateformat 05).
 *   2. MarketDate rolle 01 (utgivelse i markedet). Her står den hele datoen
 *      for kommende bøker (kode 10/11: 33 av 33).
 *   3. PublishingDate rolle 11 (første utgivelse). Her står den for utgitte bøker.
 *   4. PublicationDate (ONIX 2.1).
 * @param {string} xml
 * @returns {string | null}
 */
export function extractPublishingDate(xml) {
  const x = stripNamespaces(xml);
  return roleDate(x, "PublishingDate", "PublishingDateRole", "01")
    ?? roleDate(x, "MarketDate", "MarketDateRole", "01")
    ?? roleDate(x, "PublishingDate", "PublishingDateRole", "11")
    ?? fullDate(x.match(/<PublicationDate[^>]*>\s*([^<]+?)\s*<\/PublicationDate>/i)?.[1]);
}
