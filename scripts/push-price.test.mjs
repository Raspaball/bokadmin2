// node --test scripts/*.test.mjs
// Pris og status ved push og CSV (supabase/functions/_shared/push-price.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { csvPriceAndStatus, decidePushPrice, validPrice } from "../supabase/functions/_shared/push-price.ts";

test("ny bok uten pris: utkast uten pris, med årsak", () => {
  assert.deepEqual(decidePushPrice(null, true, "ingen NOK-pris"), {
    price: null, draft: true, note: "Opprettet som utkast: mangler pris (ingen NOK-pris)",
  });
});

test("eksisterende bok uten pris: prisen sendes ikke, status uendret", () => {
  assert.deepEqual(decidePushPrice(null, false, "ingen gyldig pris i dag"), {
    price: null, draft: false, note: "Pris ikke endret: ingen gyldig pris i dag",
  });
});

test("pris 0 eller lavere behandles som manglende pris", () => {
  assert.deepEqual(decidePushPrice(0, true), { price: null, draft: true, note: "Opprettet som utkast: mangler pris (pris 0 eller lavere)" });
  assert.equal(decidePushPrice("-5", false).price, null);
  assert.equal(decidePushPrice("0.00", false).note, "Pris ikke endret: pris 0 eller lavere");
});

test("bok med pris: som før (aktiv, pris satt)", () => {
  assert.deepEqual(decidePushPrice(449, true), { price: "449", draft: false, note: null });
  assert.deepEqual(decidePushPrice("349.00", false), { price: "349", draft: false, note: null });
});

test("uten årsak: generell tekst", () => {
  assert.equal(decidePushPrice(undefined, true).note, "Opprettet som utkast: mangler pris (ingen godkjent pris)");
});

test("validPrice", () => {
  assert.equal(validPrice(449), 449);
  assert.equal(validPrice("12.5"), 12.5);
  for (const v of [null, undefined, "", 0, "0", -1, "abc", NaN]) assert.equal(validPrice(v), null, String(v));
});

test("CSV: uten pris gir draft og tom pris, aldri 0", () => {
  assert.deepEqual(csvPriceAndStatus(null), { price: "", status: "draft" });
  assert.deepEqual(csvPriceAndStatus(0), { price: "", status: "draft" });
  assert.deepEqual(csvPriceAndStatus(449), { price: "449", status: "active" });
});
