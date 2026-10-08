// Shopify slutter å telle på 10 000 uten limit: null. Skriptene som teller hele katalogen skal sende den.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const fil of ["live-eksport.mjs", "clean-tags.mjs"]) {
  test(`${fil}: productsCount over hele katalogen har limit: null`, () => {
    const kilde = readFileSync(new URL(`./${fil}`, import.meta.url), "utf8");
    const treff = kilde.match(/productsCount\s*(\([^)]*\))?\s*\{/g) ?? [];
    assert.ok(treff.length > 0, "fant ingen productsCount");
    for (const t of treff) assert.match(t, /limit:\s*null/, `mangler limit: null: ${t}`);
  });
}

test("Edge Functions: productsCount(query: ALL_PRODUCT_STATUSES) har limit: null", () => {
  const filer = ["availability-check/index.ts", "book-update/index.ts", "price-update/index.ts",
    "sjangre-sync/index.ts", "shopify/index.ts", "_shared/shopify.ts"];
  let antall = 0;
  for (const f of filer) {
    const kilde = readFileSync(new URL(`../supabase/functions/${f}`, import.meta.url), "utf8");
    for (const linje of kilde.split("\n")) {
      if (linje.trimStart().startsWith("//")) continue;
      for (const t of linje.match(/productsCount\(query:[^)]*\)/g) ?? []) {
        antall++;
        assert.match(t, /limit:\s*null/, `${f}: ${t}`);
      }
    }
  }
  assert.ok(antall >= 10);
});
