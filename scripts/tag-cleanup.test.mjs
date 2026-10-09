// node --test scripts/*.test.mjs
// Rydd tagger (taggjobben tag_cleanup): reglene i _shared/book-tags.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isKeptTag, tagsToRemove } from "../supabase/functions/_shared/book-tags.ts";

test("bkg-1, bkg-12 og bkg-123 beholdes", () => {
  assert.deepEqual(tagsToRemove(["bkg-1", "bkg-12", "bkg-123"]), []);
});

test("bkg-1234, bkg-abc, bkg- og bkg-12a fjernes", () => {
  assert.deepEqual(tagsToRemove(["bkg-1234", "bkg-abc", "bkg-", "bkg-12a", "bkg-1-2"]), ["bkg-1234", "bkg-abc", "bkg-", "bkg-12a", "bkg-1-2"]);
});

test("beskyttede tagger beholdes uansett store og små bokstaver", () => {
  assert.deepEqual(tagsToRemove(["LOKALHISTORIE", "Gave", "lokal", "LokalLitteratur"]), []);
});

test("«gaver», «lokale» og lignende er ikke beskyttede og fjernes (hel tagg)", () => {
  assert.deepEqual(tagsToRemove(["gaver", "lokale", "gavebok", "lokalhistorien"]), ["gaver", "lokale", "gavebok", "lokalhistorien"]);
});

test("navn, titler, emnetagger og formattagger fjernes", () => {
  const tags = ["bkg-4", "Nina Brochmann", "Avkledd", "skjoenn-rom", "sakpr", "Faglitteratur", "9+", "Innbundet", "1850-1899"];
  assert.deepEqual(tagsToRemove(tags), ["Nina Brochmann", "Avkledd", "skjoenn-rom", "sakpr", "Faglitteratur", "9+", "Innbundet", "1850-1899"]);
});

test("blandet: bare det som skal fjernes, bkg og beskyttede står", () => {
  assert.deepEqual(tagsToRemove(["bkg-3", "bkg-31", "bkg-310", "lokal", "Krim", "gave"]), ["Krim"]);
});

test("tom liste, null og tomme tagger gir ingenting", () => {
  assert.deepEqual(tagsToRemove([]), []);
  assert.deepEqual(tagsToRemove(null), []);
  assert.deepEqual(tagsToRemove(["", "  "]), []);
});

test("isKeptTag", () => {
  assert.equal(isKeptTag("BKG-12"), true);
  assert.equal(isKeptTag("bkg-1234"), false);
  assert.equal(isKeptTag("Lokallitteratur"), true);
  assert.equal(isKeptTag("lokallitteratur2"), false);
});

import { keptTagsFromMessage, tagCleanupCsv } from "../src/app/utils/tagCleanup.ts";

test("CSV: før, fjernes og etter leses fra loggraden", () => {
  assert.deepEqual(keptTagsFromMessage("Ville fjernet 2 tagger; beholder: bkg-3, bkg-31"), ["bkg-3", "bkg-31"]);
  assert.deepEqual(keptTagsFromMessage("Fjernet 1 tagger; beholder: (ingen)"), []);
  const csv = tagCleanupCsv([{ isbn: "9788200000000", title: "tittel-forfatter", fields: ["Krim", "9+"], message: "Ville fjernet 2 tagger; beholder: bkg-4, lokal" }]);
  const lines = csv.replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(lines[0], "ISBN;Handle;Tagger før;Tagger som fjernes;Tagger etter");
  assert.equal(lines[1], "9788200000000;tittel-forfatter;bkg-4, lokal, Krim, 9+;Krim, 9+;bkg-4, lokal");
});
