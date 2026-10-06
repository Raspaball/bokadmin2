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

import { bkgCollectionPlan, newCollectionTitles } from "../supabase/functions/_shared/collections.ts";

test("nye samlinger med samme navn som en eksisterende eller en annen ny får « (kode)»; eksisterende omdøpes ikke", () => {
  const names = { "21": "Fag", "211": "Jus", "22": "Fag 2", "221": "Jus", "414": "Skuespill", "424": "Skuespill", "6": "Verk", "60": "Verk", "500": "Unik" };
  const current = new Map([["211", { id: "gid://1", title: "Jus" }], ["21", { id: "gid://2", title: "Fag" }]]);
  const plan = bkgCollectionPlan(["21", "211", "22", "221", "414", "424", "6", "60", "500"], current, names);
  assert.deepEqual(plan.rename, []);
  assert.deepEqual(plan.existing, ["21", "211"]);
  assert.deepEqual(plan.create.map((c) => [c.code, c.title, !!c.suffixed]), [
    ["22", "Fag 2", false],
    ["221", "Jus (221)", true], // «Jus» finnes fra før (211)
    ["414", "Skuespill (414)", true], // to like nye: begge får tillegget
    ["424", "Skuespill (424)", true],
    ["6", "Verk (6)", true],
    ["60", "Verk (60)", true],
    ["500", "Unik", false],
  ]);
});

test("newCollectionTitles: ukjent kode gir «Bokgruppe NNN»; sammenligningen ser bort fra store/små bokstaver", () => {
  const t = newCollectionTitles(["999", "1"], ["jus"], { "1": "Jus" });
  assert.deepEqual(t.get("999"), { title: "Bokgruppe 999", suffixed: false });
  assert.deepEqual(t.get("1"), { title: "Jus (1)", suffixed: true });
});

test("en eksisterende samling med feil navn rettes som før (Bokgruppe 334 → Ungdom)", () => {
  const plan = bkgCollectionPlan(["334"], new Map([["334", { id: "gid://3", title: "Bokgruppe 334" }]]), { "334": "Ungdom" });
  assert.deepEqual(plan.rename.map((r) => [r.code, r.to]), [["334", "Ungdom"]]);
});
