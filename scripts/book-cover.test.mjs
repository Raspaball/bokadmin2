// node --test scripts/*.test.mjs
// Omslag: alt-tekst og filnavn (supabase/functions/_shared/book-cover.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { coverAlt, coverChanges, coverFilename, fileNameFromUrl } from "../supabase/functions/_shared/book-cover.ts";

test("alt-tekst med og uten forfatter, hovedtittel før kolon", () => {
  assert.equal(coverAlt("Avkledd: den syke historien", ["Nina Brochmann", "X"]), "Omslag: Avkledd av Nina Brochmann");
  assert.equal(coverAlt("Kart over Norge", []), "Omslag: Kart over Norge");
});

test("filnavn: handle-omslag med endelsen fra dagens fil", () => {
  const h = "avkledd-nina-brochmann-9788203461392";
  assert.equal(coverFilename(h, "https://cdn.shopify.com/s/files/1/0/files/jpg.jpg?v=1"), `${h}-omslag.jpg`);
  assert.equal(coverFilename(h, "https://cdn.shopify.com/s/files/1/0/files/x.PNG?v=1"), `${h}-omslag.png`);
  assert.equal(coverFilename(h, null), `${h}-omslag.jpg`);
  assert.equal(coverFilename(h, "https://bokbasen.example/bilde/12345"), `${h}-omslag.jpg`);
});

test("filnavn fra URL", () => {
  assert.equal(fileNameFromUrl("https://cdn.shopify.com/s/files/1/0/files/avkledd-omslag.jpg?v=179"), "avkledd-omslag.jpg");
  assert.equal(fileNameFromUrl(""), "");
});

test("endringer: bare det som er annerledes", () => {
  const wanted = { alt: "Omslag: Avkledd av Nina Brochmann", filename: "a-omslag.jpg" };
  assert.deepEqual(coverChanges({ alt: "Avkledd", url: "https://cdn/x/jpg.jpg?v=1" }, wanted), wanted);
  assert.deepEqual(coverChanges({ alt: wanted.alt, url: "https://cdn/x/a-omslag.jpg?v=2" }, wanted), {});
  assert.deepEqual(coverChanges({ alt: wanted.alt, url: "https://cdn/x/jpg.jpg" }, wanted), { filename: "a-omslag.jpg" });
});
