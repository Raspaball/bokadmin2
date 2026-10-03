// node --test scripts/*.test.mjs
// Forfatterne som liste (supabase/functions/_shared/onix.js, extractContributors)
// og handle bygget fra listen (handle.js). Utdragene er forkortet fra rå ONIX 3.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAllContributors, extractContributors, uninvertName } from "../supabase/functions/_shared/onix.js";
import { INSTITUTION_NAMES, isInstitutionName, personAuthors } from "../supabase/functions/_shared/contributors.js";
import { buildBookHandle, firstAuthor } from "../supabase/functions/_shared/handle.js";
import { metaDescription, seoTitle } from "../supabase/functions/_shared/book-seo.ts";
import { bookMetafields, fallbackDescription } from "../supabase/functions/_shared/book-standard.ts";
import { coverAlt } from "../supabase/functions/_shared/book-cover.ts";

const c = (role, nameXml, seq) =>
  `<Contributor>${seq ? `<SequenceNumber>${seq}</SequenceNumber>` : ""}<ContributorRole>${role}</ContributorRole><NameType>04</NameType>${nameXml}</Contributor>`;
const inv = (n) => `<PersonNameInverted>${n}</PersonNameInverted>`;
const person = (n) => `<PersonName>${n}</PersonName>`;
const product = (...cs) =>
  `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference"><Product><DescriptiveDetail>${cs.join("")}</DescriptiveDetail></Product></ONIXMessage>`;

test("én forfatter (PersonNameInverted, som hos Bokbasen)", () => {
  assert.deepEqual(extractContributors(product(c("A01", inv("Brochmann, Nina"), 1))), { authors: ["Nina Brochmann"], role: "A01", institutions: [] });
});

test("to forfattere som PersonName", () => {
  const x = product(c("A01", person("Nina Brochmann"), 1), c("A01", person("Ellen Støkken Dahl"), 2));
  assert.deepEqual(extractContributors(x).authors, ["Nina Brochmann", "Ellen Støkken Dahl"]);
});

test("to forfattere som PersonNameInverted, i SequenceNumber-rekkefølge", () => {
  const x = product(c("A01", inv("Støkken Dahl, Ellen"), 2), c("A01", inv("Brochmann, Nina"), 1));
  assert.deepEqual(extractContributors(x).authors, ["Nina Brochmann", "Ellen Støkken Dahl"]);
});

test("andre roller tas ikke med når det finnes A01", () => {
  const x = product(c("A01", inv("Nusa, Antonio"), 1), c("A01", inv("Saugestad, Frode"), 2), c("A12", inv("Tegner, Tine"), 3), c("B06", inv("Oversetter, Olav"), 4));
  assert.deepEqual(extractContributors(x), { authors: ["Antonio Nusa", "Frode Saugestad"], role: "A01", institutions: [] });
});

test("bare redaktør: første bidragsyter, med rollen", () => {
  const x = product(c("B01", inv("Grindrod, John"), 1), c("B06", inv("Hansen, Per"), 2));
  assert.deepEqual(extractContributors(x), { authors: ["John Grindrod"], role: "B01", institutions: [] });
});

test("ingen bidragsytere", () => {
  assert.deepEqual(extractContributors(product()), { authors: [], role: null, institutions: [] });
});

test("NamesBeforeKey + KeyNames, CorporateName og entiteter", () => {
  assert.deepEqual(extractContributors(product(c("A01", "<NamesBeforeKey>Jo</NamesBeforeKey><KeyNames>Nesbø</KeyNames>", 1))).authors, ["Jo Nesbø"]);
  // CorporateName er en institusjon og tas ikke med som forfatter (pakke G del 3)
  assert.deepEqual(extractContributors(product(c("A09", "<CorporateName>Cappelens kartavdeling</CorporateName>", 1))),
    { authors: [], role: null, institutions: [{ name: "Cappelens kartavdeling", role: "A09", reason: "CorporateName" }] });
  assert.deepEqual(extractContributors(product(c("A01", inv("Ørbeck &amp; Co, Ole"), 1))).authors, ["Ole Ørbeck & Co"]);
});

test("uninvertName", () => {
  assert.equal(uninvertName("Støkken Dahl, Ellen"), "Ellen Støkken Dahl");
  assert.equal(uninvertName("Platon"), "Platon");
  assert.equal(uninvertName("H.L. Phoenix"), "H.L. Phoenix");
});

test("handle fra listen: «Nina Brochmann, Ellen Støkken Dahl» gir nå riktig første forfatter", () => {
  const authors = ["Nina Brochmann", "Ellen Støkken Dahl"];
  assert.equal(buildBookHandle({ title: "Gleden med skjeden", authors, isbn: "9788203361234" }), "gleden-med-skjeden-nina-brochmann-9788203361234");
  // Reserve for gamle data: tekst «Etternavn, Fornavn» snus fortsatt
  assert.equal(firstAuthor("Brochmann, Nina"), "Nina Brochmann");
});

// ── Institusjoner (pakke G del 3) ─────────────────────────────────────────────
// «Norge» står i ONIX som CorporateName med rolle Z03 (funnet i rå ONIX for Arbeidsmiljøloven m.fl.)
const norge = c("Z03", "<NameIdentifier><NameIDType>36</NameIDType><IDValue>90052905</IDValue></NameIdentifier><CorporateName>Norge</CorporateName>", 1);

test("Arbeidsmiljøloven: bare «Norge» (CorporateName, Z03) gir ingen forfatter", () => {
  assert.deepEqual(extractContributors(product(norge)),
    { authors: [], role: null, institutions: [{ name: "Norge", role: "Z03", reason: "CorporateName" }] });
  assert.equal(buildBookHandle({ title: "Arbeidsmiljøloven", authors: extractContributors(product(norge)).authors, isbn: "9788202913786" }), "arbeidsmiljoloven-9788202913786");
});

test("institusjon tas ikke med, personen gjør", () => {
  const x = product(norge, c("B01", inv("Hansen, Per"), 2));
  assert.deepEqual(extractContributors(x).authors, ["Per Hansen"]);
  assert.equal(extractContributors(x).role, "B01");
  assert.deepEqual(extractContributors(product(c("A01", "<CorporateName>Lovdata</CorporateName>", 1), c("A01", inv("Berg, Anne"), 2))).authors, ["Anne Berg"]);
});

test("kjent institusjonsnavn skrevet som personnavn (listen i koden)", () => {
  assert.deepEqual(extractContributors(product(c("A01", person("Norge"), 1))).authors, []);
  assert.deepEqual(extractContributors(product(c("A01", inv("Justis- og beredskapsdepartementet"), 1))).authors, []);
  assert.deepEqual(extractContributors(product(c("A01", person("Norway"), 1))).institutions[0].reason, "navn på listen");
  assert.deepEqual(extractAllContributors(product(norge, c("A01", person("Ola Norge"), 2))).map((x) => x.institution), ["CorporateName", null]);
});

test("isInstitutionName og personAuthors (felles for handle, SEO, alt-tekst, bok.forfatter)", () => {
  for (const n of INSTITUTION_NAMES) assert.equal(isInstitutionName(n), true, n);
  for (const n of ["norge", " NORGE ", "Finansdepartementet", "Lovdata Pro", "Utdanningsdirektoratet", "Oslo kommune"]) assert.equal(isInstitutionName(n), true, n);
  for (const n of ["Nina Brochmann", "Ola Norge", "Jo Nesbø", "Marie Norgaard"]) assert.equal(isInstitutionName(n), false, n);
  assert.deepEqual(personAuthors(["Norge", "Nina Brochmann"]), ["Nina Brochmann"]);
  assert.deepEqual(personAuthors(["Norge"]), []);
  assert.deepEqual(personAuthors(null), []);
});

test("handle: institusjon blant forfatterne hoppes over, også for gamle data", () => {
  assert.equal(buildBookHandle({ title: "Lov om arkiv", authors: ["Norge"], isbn: "9788202913359" }), "lov-om-arkiv-9788202913359");
  assert.equal(buildBookHandle({ title: "Lov om arkiv", authors: ["Norge", "Per Hansen"], isbn: "9788202913359" }), "lov-om-arkiv-per-hansen-9788202913359");
  assert.equal(buildBookHandle({ title: "Lov om arkiv", authors: '["Norge"]', isbn: "9788202913359" }), "lov-om-arkiv-9788202913359");
  assert.equal(firstAuthor("Norge"), "");
});

// ── Kontroll-CSV og telling i jobben ────────────────────────────────────────
import { institutionsCsv } from "../supabase/functions/_shared/contributors.js";
import { countPlan, emptyBookUpdateCounts, loadBookUpdateCounts, planBookUpdate, summarizeBookUpdate } from "../supabase/functions/_shared/book-update.ts";
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
setProtectedMembers([]);

test("jobben teller institusjoner (navn, roller, antall bøker, eksempel-ISBN) og CSV-en har dem alle", () => {
  const counts = emptyBookUpdateCounts();
  const xml = product(norge, c("A01", "<CorporateName>Lovdata</CorporateName>", 2));
  const productInput = { id: "gid://shopify/Product/1", handle: "h", title: "Arbeidsmiljøloven", tags: [], productType: "Bok", category: { id: "gid://shopify/TaxonomyCategory/me-1-3" } };
  const plan = planBookUpdate(productInput, xml);
  assert.deepEqual(plan.institutions.map((i) => i.name).sort(), ["Lovdata", "Norge"]);
  countPlan(counts, "h", plan, "9788202913786");
  countPlan(counts, "h2", planBookUpdate({ ...productInput, id: "gid://shopify/Product/2" }, product(norge)), "9788202913359");
  assert.deepEqual(counts.institutions.Norge, { reason: "CorporateName", roles: ["Z03"], count: 2, isbns: ["9788202913786", "9788202913359"] });
  assert.equal(counts.institutions.Lovdata.count, 1);
  assert.match(summarizeBookUpdate(counts, "analyze"), /Institusjoner \(ikke forfatter\): 2 navn på 3 bøker/);
  // Overlever lagring mellom pulser
  assert.deepEqual(loadBookUpdateCounts(JSON.parse(JSON.stringify(counts))).institutions, counts.institutions);
  const csv = institutionsCsv(counts.institutions);
  assert.equal(csv.split("\n")[0], "Navn;Årsak;Roller;Antall bøker;Eksempel-ISBN");
  assert.equal(csv.split("\n")[1], '"Norge";"CorporateName";"Z03";"2";"9788202913786 9788202913359"');
  assert.equal(csv.trim().split("\n").length, 3);
});

test("planBookUpdate: «Norge» som bok.forfatter fjernes når ONIX ikke har noen person; personer og manuelle verdier røres ikke", () => {
  const base = { id: "gid://shopify/Product/1", handle: "h", title: "Arbeidsmiljøloven", tags: [], productType: "Bok", category: { id: "gid://shopify/TaxonomyCategory/me-1-3" } };
  const del = (mf) => planBookUpdate({ ...base, mf_forfatter: { value: mf } }, product(norge)).metafieldDeletes;
  assert.deepEqual(del('["Norge"]'), [{ ownerId: base.id, namespace: "bok", key: "forfatter" }]);
  assert.deepEqual(del('["Norge","Lovdata"]'), [{ ownerId: base.id, namespace: "bok", key: "forfatter" }]);
  assert.deepEqual(del('["Jo Nesbø"]'), []); // manuelt satt person: røres ikke
  assert.deepEqual(del('["Norge","Jo Nesbø"]'), []);
  assert.deepEqual(planBookUpdate(base, product(norge)).metafieldDeletes, []); // ingen verdi å slette
  // ONIX har en person: bok.forfatter settes (ikke slettes), «Norge» overskrives
  const withPerson = planBookUpdate({ ...base, mf_forfatter: { value: '["Norge"]' } }, product(norge, c("A01", inv("Hansen, Per"), 2)));
  assert.deepEqual(withPerson.metafieldDeletes, []);
  assert.equal(withPerson.metafields.find((m) => m.key === "forfatter").value, '["Per Hansen"]');
});

// ── SEO, alt-tekst og bok.forfatter uten institusjon ─────────────────────────

test("institusjon er ikke forfatter i SEO-tittel, metabeskrivelse, alt-tekst, bok.forfatter og reservebeskrivelse", () => {
  const input = { title: "Arbeidsmiljøloven", authors: ["Norge"], format: "Heftet", year: 2026, description: "Loven om arbeidsmiljø." };
  assert.equal(seoTitle(input), "Arbeidsmiljøloven (Heftet)");
  assert.equal(metaDescription(input), "Arbeidsmiljøloven (Heftet, 2026). Loven om arbeidsmiljø.");
  assert.equal(coverAlt("Arbeidsmiljøloven", ["Norge"]), "Omslag: Arbeidsmiljøloven");
  assert.equal(coverAlt("Arbeidsmiljøloven", ["Norge", "Per Hansen"]), "Omslag: Arbeidsmiljøloven av Per Hansen");
  const f = { authors: ["Norge"], institutions: [], authorRole: null, format: "Heftet", productType: "Bok", category: "", pages: 100, year: 2026, language: null, series: null, age: null, thema: [], bokgruppe: null };
  assert.ok(!bookMetafields(f).some((m) => m.key === "forfatter"));
  assert.match(fallbackDescription("Arbeidsmiljøloven", f, "Cappelen Damm"), /^Arbeidsmiljøloven\. Heftet/);
  assert.deepEqual(bookMetafields({ ...f, authors: ["Norge", "Per Hansen"] }).find((m) => m.key === "forfatter").value, JSON.stringify(["Per Hansen"]));
});
