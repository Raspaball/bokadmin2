// node --test scripts/*.test.mjs
// Samlingsnavn (pakke B del 9): _shared/collections.ts og _shared/collection-names.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectionTitleFix, tagSources } from "../supabase/functions/_shared/collections.ts";
import { COLLECTION_NAMES } from "../supabase/functions/_shared/collection-names.ts";

test("feil navn rettes, riktig navn og ukjente koder røres ikke", () => {
  assert.equal(collectionTitleFix("Bokgruppe 334", COLLECTION_NAMES["334"]), "Ungdom");
  assert.equal(collectionTitleFix("Ungdom", COLLECTION_NAMES["334"]), null);
  assert.equal(collectionTitleFix("Bokgruppe 999", COLLECTION_NAMES["999"]), null);
});

test("navnelisten har kodene som hadde «Bokgruppe NNN» i Testbutikk", () => {
  for (const code of ["33", "328", "432", "334"]) assert.ok(COLLECTION_NAMES[code], code);
});

test("tagSources gir en smart samling på taggen", () => {
  assert.deepEqual(tagSources("bkg-3")[0].source.inclusion.conditions[0].productTag, { relation: "TAGGED_WITH", values: ["bkg-3"], matchType: "ANY" });
});

import { COLLECTION_TITLES, uniqueCollectionTitles } from "../supabase/functions/_shared/collection-names.ts";

test("samlingstitler er unike, og unike navn er uendret", () => {
  const titles = Object.values(COLLECTION_TITLES);
  assert.equal(new Set(titles).size, titles.length);
  assert.equal(Object.keys(COLLECTION_TITLES).length, Object.keys(COLLECTION_NAMES).length);
  assert.equal(COLLECTION_TITLES["334"], "Ungdom – Sakprosa norsk, barn og ungdom");
  assert.equal(COLLECTION_TITLES["344"], "Ungdom – Sakprosa oversatt, barn og ungdom");
  for (const [code, name] of Object.entries(COLLECTION_NAMES)) {
    if (Object.values(COLLECTION_NAMES).filter((n) => n === name).length === 1) assert.equal(COLLECTION_TITLES[code], name, code);
  }
});

test("samme navn som den overordnede gruppen: korteste kode beholder navnet, de andre får kode", () => {
  assert.equal(COLLECTION_TITLES["6"], "Verk");
  assert.equal(COLLECTION_TITLES["60"], "Verk (60)");
  assert.equal(COLLECTION_TITLES["1"], "Skolebøker");
  assert.equal(COLLECTION_TITLES["11"], "Skolebøker (11)");
  assert.deepEqual(uniqueCollectionTitles({ "1": "A", "2": "B", "21": "A", "22": "A" }), { "1": "A", "2": "B", "21": "A – B", "22": "A (22)" });
});
