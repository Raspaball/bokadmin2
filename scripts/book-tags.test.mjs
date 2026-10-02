// node --test scripts/*.test.mjs
// Tagger (pakke B del 7, _shared/book-tags.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanBookTags } from "../supabase/functions/_shared/book-tags.ts";

const avkledd = { title: "Avkledd: den syke historien om kvinners seksualitet i medisinen", authors: ["Nina Brochmann"] };

test("gamle tagger fra push (delt på komma) fjernes, bkg-* og andre beholdes", () => {
  const r = cleanBookTags(
    ["Avkledd: den syke historien om kvinners seksualitet i medisinen", "bkg-3", "bkg-31", "bkg-312", "Brochmann", "folio-test", "Nina"],
    avkledd, ["bkg-3", "bkg-31", "bkg-312"],
  );
  assert.deepEqual(r.tags, ["bkg-3", "bkg-31", "bkg-312", "folio-test"]);
  assert.deepEqual(r.removed.sort(), ["Avkledd: den syke historien om kvinners seksualitet i medisinen", "Brochmann", "Nina"]);
});

test("hel forfatter i begge skrivemåter, hovedtittel, uten store/små bokstaver og ekstra mellomrom", () => {
  const r = cleanBookTags(["nina  brochmann", "Brochmann, Nina", "AVKLEDD", "gave"], avkledd);
  assert.deepEqual(r.tags, ["gave"]);
  assert.equal(r.removed.length, 3);
});

test("en navnedel alene fjernes ikke (kan være en egen tagg)", () => {
  const r = cleanBookTags(["Nina", "lokal"], avkledd);
  assert.deepEqual(r.tags, ["Nina", "lokal"]);
  assert.deepEqual(r.removed, []);
});

test("flere forfattere og books.author-tekst", () => {
  const r = cleanBookTags(["Støkken Dahl", "Ellen", "Brochmann", "Nina", "lokal"],
    { title: "Gleden med skjeden", authors: ["Nina Brochmann", "Ellen Støkken Dahl"], authorTexts: ["Brochmann, Nina, Støkken Dahl, Ellen"] });
  assert.deepEqual(r.tags, ["lokal"]);
});

test("bkg-tagger legges til uten duplikat", () => {
  assert.deepEqual(cleanBookTags(["bkg-3"], avkledd, ["bkg-3", "bkg-31"]).tags, ["bkg-3", "bkg-31"]);
});

// Generalprøven (pakke D del 4): fire bøker beholdt forfatterbiter
test("sammensatte etternavn fra ONIX («Etternavn, Fornavn») og diakritiske tegn fjernes", async () => {
  const { extractInvertedNames } = await import("../supabase/functions/_shared/onix.js");
  const xml = `<Product><DescriptiveDetail>
    <Contributor><SequenceNumber>1</SequenceNumber><ContributorRole>A01</ContributorRole><PersonNameInverted>Hove Christensen, Mia</PersonNameInverted></Contributor>
    <Contributor><ContributorRole>B06</ContributorRole><NamesBeforeKey>Simon</NamesBeforeKey><KeyNames>Sebag Montefiore</KeyNames></Contributor>
  </DescriptiveDetail></Product>`;
  assert.deepEqual(extractInvertedNames(xml), ["Hove Christensen, Mia", "Sebag Montefiore, Simon"]);
  const r = cleanBookTags(["bkg-3", "Hove Christensen", "Mia", "Tenerife"],
    { title: "Tenerife", authors: ["Mia Hove Christensen"], authorTexts: extractInvertedNames(xml) });
  assert.deepEqual(r.tags, ["bkg-3"]);
  assert.deepEqual(cleanBookTags(["Sūnzi", "bkg-5", "krigskunst"], { title: "Kunsten å krige", authors: ["Sunzi"] }).tags, ["bkg-5", "krigskunst"]);
  assert.deepEqual(cleanBookTags(["Da Costa", "Mélissa", "skjoenn"], { title: "Det usynlige savnet", authors: ["Melissa Da Costa"], authorTexts: ["Da Costa, Mélissa"] }).tags, ["skjoenn"]);
  // Diakritiske tegn gjør ikke andre tagger like: «Hav» er ikke «Håv» når ingen heter det
  assert.deepEqual(cleanBookTags(["Hav", "bkg-3"], { title: "Fjord", authors: ["Ola Håv"] }).tags, ["Hav", "bkg-3"]);
});
