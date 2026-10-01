// node --test scripts/*.test.mjs
// Forfatterne som liste (supabase/functions/_shared/onix.js, extractContributors)
// og handle bygget fra listen (handle.js). Utdragene er forkortet fra rå ONIX 3.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractContributors, uninvertName } from "../supabase/functions/_shared/onix.js";
import { buildBookHandle, firstAuthor } from "../supabase/functions/_shared/handle.js";

const c = (role, nameXml, seq) =>
  `<Contributor>${seq ? `<SequenceNumber>${seq}</SequenceNumber>` : ""}<ContributorRole>${role}</ContributorRole><NameType>04</NameType>${nameXml}</Contributor>`;
const inv = (n) => `<PersonNameInverted>${n}</PersonNameInverted>`;
const person = (n) => `<PersonName>${n}</PersonName>`;
const product = (...cs) =>
  `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference"><Product><DescriptiveDetail>${cs.join("")}</DescriptiveDetail></Product></ONIXMessage>`;

test("én forfatter (PersonNameInverted, som hos Bokbasen)", () => {
  assert.deepEqual(extractContributors(product(c("A01", inv("Brochmann, Nina"), 1))), { authors: ["Nina Brochmann"], role: "A01" });
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
  assert.deepEqual(extractContributors(x), { authors: ["Antonio Nusa", "Frode Saugestad"], role: "A01" });
});

test("bare redaktør: første bidragsyter, med rollen", () => {
  const x = product(c("B01", inv("Grindrod, John"), 1), c("B06", inv("Hansen, Per"), 2));
  assert.deepEqual(extractContributors(x), { authors: ["John Grindrod"], role: "B01" });
});

test("ingen bidragsytere", () => {
  assert.deepEqual(extractContributors(product()), { authors: [], role: null });
});

test("NamesBeforeKey + KeyNames, CorporateName og entiteter", () => {
  assert.deepEqual(extractContributors(product(c("A01", "<NamesBeforeKey>Jo</NamesBeforeKey><KeyNames>Nesbø</KeyNames>", 1))).authors, ["Jo Nesbø"]);
  assert.deepEqual(extractContributors(product(c("A09", "<CorporateName>Cappelens kartavdeling</CorporateName>", 1))), { authors: ["Cappelens kartavdeling"], role: "A09" });
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
