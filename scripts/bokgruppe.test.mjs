// node --test scripts/*.test.mjs
// bkg-tagger og samlinger (pakke E del 5): _shared/bokgruppe.ts og bkgCollectionPlan i _shared/collections.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bokgruppeCollectionCodes, bokgruppeTagsForKode, missingBokgruppeTags } from "../supabase/functions/_shared/bokgruppe.ts";
import { bkgCollectionPlan } from "../supabase/functions/_shared/collections.ts";

test("koden gir alle tre nivåene", () => {
  assert.deepEqual(bokgruppeTagsForKode("417"), ["bkg-4", "bkg-41", "bkg-417"]);
  assert.deepEqual(bokgruppeTagsForKode("4"), ["bkg-4"]);
  assert.deepEqual(bokgruppeTagsForKode(""), []);
});

test("bare manglende tagger legges til; andre tagger røres ikke", () => {
  assert.deepEqual(missingBokgruppeTags(["bkg-4", "gave", "Faglitteratur"], "417"), ["bkg-41", "bkg-417"]);
  assert.deepEqual(missingBokgruppeTags(["bkg-4", "bkg-41", "bkg-417"], "417"), []);
  assert.deepEqual(missingBokgruppeTags(null, "3"), ["bkg-3"]);
});

test("samlingskoder med overordnede nivåer, kortest først", () => {
  assert.deepEqual(bokgruppeCollectionCodes(["417", "412", "ukjent", "", "3"]), ["3", "4", "41", "412", "417"]);
});

test("samlingsplan: lag manglende, rett feil navn, la riktige stå", () => {
  const current = new Map([["4", { id: "c4", title: "Bokgruppe 4" }], ["41", { id: "c41", title: "Sakprosa" }], ["999", { id: "x", title: "X" }]]);
  const plan = bkgCollectionPlan(["4", "41", "417", "5"], current, { "4": "Fag", "41": "Sakprosa", "417": "Historie" });
  assert.deepEqual(plan.create, [{ code: "417", handle: "bkg-417", title: "Historie" }, { code: "5", handle: "bkg-5", title: "Bokgruppe 5" }]);
  assert.deepEqual(plan.rename, [{ code: "4", id: "c4", from: "Bokgruppe 4", to: "Fag" }]);
  assert.deepEqual(plan.existing, ["41"]);
});
