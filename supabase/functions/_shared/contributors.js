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
 * Hvorfor en bidragsyter er en institusjon, eller null (= person).
 * `corporate`: ONIX har CorporateName og ingen personnavn. Ellers avgjør navnet (listen i koden).
 * @param {{ name: string, corporate?: boolean }} c
 * @returns {string | null}
 */
export function institutionReason({ name, corporate = false }) {
  if (corporate) return "CorporateName";
  return institutionByName(name);
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
