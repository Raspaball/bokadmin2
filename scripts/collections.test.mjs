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
