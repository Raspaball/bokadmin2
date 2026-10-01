// node --test scripts/*.test.mjs
// Egen pris og tilbud (supabase/functions/_shared/price-lock.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceLock, priceLockMessage } from "../supabase/functions/_shared/price-lock.ts";

test("bok.egen_pris = true: egen pris", () => {
  assert.equal(priceLock({ value: "true" }, null), "egen pris");
  assert.equal(priceLock("true", null), "egen pris");
  assert.equal(priceLock(true, null), "egen pris");
});

test("egen pris går foran tilbud", () => {
  assert.equal(priceLock({ value: "true" }, "499.00"), "egen pris");
});

test("compareAtPrice satt: tilbud", () => {
  assert.equal(priceLock(null, "499.00"), "tilbud");
  assert.equal(priceLock({ value: "false" }, 499), "tilbud");
});

test("ingen lås: egen_pris false/mangler og compareAtPrice tom eller 0", () => {
  assert.equal(priceLock(null, null), null);
  assert.equal(priceLock({ value: "false" }, ""), null);
  assert.equal(priceLock(undefined, "0.00"), null);
});

test("meldinger", () => {
  assert.equal(priceLockMessage("egen pris"), "Hoppet over: egen pris");
  assert.equal(priceLockMessage("tilbud"), "Hoppet over: tilbud");
});
