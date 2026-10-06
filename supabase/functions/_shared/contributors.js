/* @ts-self-types="./contributors.d.ts" */
// supabase/functions/_shared/contributors.js
// Én felles regel for hvem som regnes som forfatter (pakke G del 3): bare personer.
// Institusjoner («Norge», departementer, Lovdata …) står som bidragsytere i ONIX
// (CorporateName i stedet for personnavn), men er ikke forfattere. De tas ikke med i
// bok.forfatter, handle, SEO-tittel, metabeskrivelse eller alt-tekst på omslaget.
// En bok som bare har institusjon, regnes som «uten forfatter».
//
// Brukes av onix.js (extractContributors), handle.js (buildBookHandle),
// book-seo.ts, book-cover.ts og book-standard.ts. Ren JavaScript (ESM) så både
// Deno og Node (scripts/) kan importere den.
//
// FUNN (rå ONIX 3.1, 2026-10-03): «Norge» står som
//   <ContributorRole>Z03</ContributorRole><NameType>04</NameType>…<CorporateName>Norge</CorporateName>
// (NameType 04 = «Real name» i ONIX-liste 18, brukes også på personer: ikke et tegn på institusjon.)
// hos alle 10 kontrollerte lovbøker (Arbeidsmiljøloven, Folketrygdloven …).
// Fordi rollen ikke er A01, tok den gamle regelen «første bidragsyter» den som forfatter.

/**
 * Kjente institusjonsnavn (hele navnet, uten hensyn til store og små bokstaver).
 * REDIGERBAR LISTE: legg til navn her når CSV-kontrollen (scripts/institusjoner.mjs)
 * viser institusjoner som er skrevet som personnavn i ONIX.
 */
export const INSTITUTION_NAMES = [
  "Norge", "Norway", "Noreg", "Norges", "Stortinget", "Regjeringen", "Lovdata", "Sametinget",
  "Statistisk sentralbyrå", "Kunnskapsdepartementet", "Utdanningsdirektoratet",
];

/**
 * Mønstre som gjør et navn til en institusjon (testes mot hele navnet).
 * REDIGERBAR LISTE.
 */
export const INSTITUTION_PATTERNS = [
  /departement(et)?$/i, // «Justis- og beredskapsdepartementet», «Finansdepartementet»
  /^lovdata\b/i,
  /direktorat(et)?$/i,
  /\b(fylkes)?kommune$/i,
  /^statens\b/i,
  /^den norske kirke\b/i,
];

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Hvorfor navnet er en institusjon («navn på listen», «mønster»), eller null.
 * @param {string} name
 * @returns {string | null}
 */
export function institutionByName(name) {
  const n = norm(name);
  if (!n) return null;
  const lower = n.toLowerCase();
  if (INSTITUTION_NAMES.some((x) => x.toLowerCase() === lower)) return "navn på listen";
  if (INSTITUTION_PATTERNS.some((re) => re.test(n))) return "mønster i navnet";
  return null;
}

/**
 * Er navnet en institusjon etter listen i koden? (Brukes der bare navnet er kjent:
 * handle, SEO, alt-tekst, gamle rader uten ONIX.)
 * @param {string} name
 * @returns {boolean}
 */
export function isInstitutionName(name) {
  return institutionByName(name) !== null;
}

/**
 * Ord som gjør et CorporateName til en organisasjon. REDIGERBAR LISTE.
 * `ORGANISATION_SUFFIXES` treffer også som slutt på sammensatte ord (Landslaget, Riksmålsforbundet,
 * Mattilsynet); `ORGANISATION_WORDS` er korte ord som må stå alene (AS, Hub, Group).
 */
export const ORGANISATION_SUFFIXES = [
  "museum", "museet", "avlslag", "universitet", "universitetet", "høgskole", "høyskole", "høgskolen", "høyskolen", "institutt", "instituttet",
  "forbund", "forbundet", "forening", "foreningen", "laget", "historielag", "stiftelse", "stiftelsen", "sykehus", "sykehuset",
  "hospital", "selskap", "selskapet", "akademi", "akademiet", "kommune", "kommunar", "direktorat", "departement", "tilsyn", "tilsynet",
  "kringkasting", "samanslutning", "sammenslutning", "avdeling", "avdelinga", "kollektivet", "bibliotek", "biblioteket", "kirke",
  "kirken", "senter", "sentret", "organisasjon", "komité", "skole", "skolen", "råd", "rådet", "forlag",
];
export const ORGANISATION_WORDS = [
  "lag", "venner", "klubb", "company", "enterprises", "comics", "group", "animation", "hub", "as", "a/s", "asa", "ltd", "inc", "gmbh", "union",
];

const esc = (w) => w.replace(/[/.]/g, "\$&");
const ORG_RE = new RegExp(
  String.raw`(${ORGANISATION_SUFFIXES.map(esc).join("|")})(?=$|[\s./),:;-])|(^|[\s./(-])(${ORGANISATION_WORDS.map(esc).join("|")})(?=$|[\s./),:;-])`,
  "i",
);
const LEADING_ARTICLE_RE = /^(en|et|ei|det|den|de|the|a|an)\s/i;
const CONNECTIVE_RE = /\s(og|for|fra|på|the|of|and|in|at|with|til)\s/i;

/**
 * Er et CorporateName en organisasjon, eller ser det ut som en tittel (utstilling, bok,
 * katalog) som forlaget har lagt i feil felt? (Pakke H etter sjekkrapport 06.10.)
 *  1. Ord som museum, universitet, forbund, lag, AS … → organisasjon, uansett resten.
 *  2. Tittelpreg uten slike ord → IKKE organisasjon: « - » / «. » / «:» / parentes / årstall i
 *     navnet, binde-/småord (og, for, fra, på, of, the …), eller starter med artikkel (En, Det, The).
 *  3. Ellers (kort navn uten tittelpreg: «Netflix», «KODE», «Game Flow») → organisasjon.
 * @param {string} name
 * @returns {boolean}
 */
export function looksLikeOrganisation(name) {
  const n = norm(name);
  if (!n) return false;
  if (ORG_RE.test(n)) return true;
  if (/\s[-–—]\s|\.\s|:|[()]|(1[5-9]|20)\d\d/.test(n)) return false;
  if (CONNECTIVE_RE.test(n) || LEADING_ARTICLE_RE.test(n)) return false;
  return true;
}

/**
 * Hvorfor en bidragsyter er en institusjon, eller null (= person, eller tittel i feil felt).
 * `corporate`: ONIX har CorporateName og ingen personnavn. Er det en organisasjon
 * (`looksLikeOrganisation`) er det en institusjon; ellers (en tittel som «Picasso - the code
 * of painting») er det verken institusjon eller person. Ellers avgjør navnet (listen i koden).
 * @param {{ name: string, corporate?: boolean }} c
 * @returns {string | null}
 */
export function institutionReason({ name, corporate = false }) {
  const byName = institutionByName(name);
  if (byName) return corporate ? "CorporateName" : byName;
  if (corporate) return looksLikeOrganisation(name) ? "CorporateName" : null;
  return null;
}

/**
 * Navnene som er personer, i samme rekkefølge. Den felles funksjonen alle
 * som viser forfatter bruker.
 * @param {readonly string[] | null | undefined} names
 * @returns {string[]}
 */
export function personAuthors(names) {
  return (names ?? []).map((n) => norm(n)).filter((n) => n && !isInstitutionName(n));
}

/**
 * CSV (semikolon, UTF-8) over bidragsyterne som ble regnet som institusjon, til kontroll.
 * Kolonner: Navn; Årsak; Roller; Antall bøker; Eksempel-ISBN.
 * @param {Record<string, { reason: string, roles: string[], count: number, isbns: string[] }>} institutions
 * @returns {string}
 */
export function institutionsCsv(institutions) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = Object.entries(institutions ?? {}).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], "nb"));
  return ["Navn;Årsak;Roller;Antall bøker;Eksempel-ISBN", ...rows.map(([name, i]) => [name, i.reason, i.roles.join(" "), i.count, i.isbns.join(" ")].map(cell).join(";"))].join("\n") + "\n";
}
