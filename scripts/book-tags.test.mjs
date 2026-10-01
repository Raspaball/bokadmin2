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
