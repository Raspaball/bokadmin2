// node --test scripts/*.test.mjs
// Sperre mot store prishopp (supabase/functions/_shared/price-guard.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalMessage, checkPriceChange, fixMessage, formatPct, normalizeMaxPct } from "../supabase/functions/_shared/price-guard.ts";

test("under grensen: settes", () => {
  const r = checkPriceChange(399, 449);
  assert.equal(r.action, "set");
  assert.equal(formatPct(r.pct), "12,5");
});

test("akkurat på grensen (30 %): settes", () => {
  assert.equal(checkPriceChange(100, 130).action, "set");
  assert.equal(checkPriceChange(100, 70).action, "set");
});

test("over grensen: krever godkjenning, både opp og ned", () => {
  const up = checkPriceChange(449, 899);
  assert.equal(up.action, "approval");
  assert.equal(approvalMessage(449, 899, up.pct), "Krever godkjenning: 449 → 899 kr (100,2 %)");
  assert.equal(checkPriceChange(449, 199).action, "approval");
});

test("gammel pris 0 eller mangler: settes (retter feil)", () => {
  for (const old of [0, "0.00", null, undefined, "", -5]) {
    assert.deepEqual(checkPriceChange(old, 449), { action: "fix", pct: null }, String(old));
  }
  assert.equal(fixMessage(0, 449), "Pris satt: 0 → 449 kr (gammel pris manglet eller var 0)");
  assert.equal(fixMessage(null, 449), "Pris satt: mangler → 449 kr (gammel pris manglet eller var 0)");
});

test("samme pris (avvik under 0,01 kr)", () => {
  assert.equal(checkPriceChange("449.00", 449).action, "same");
  assert.equal(checkPriceChange(449, 449.004).action, "same");
});

test("grensen satt til en annen verdi", () => {
  assert.equal(checkPriceChange(400, 449, 10).action, "approval"); // 12,25 %
  assert.equal(checkPriceChange(400, 449, 15).action, "set");
  assert.equal(checkPriceChange(100, 250, 200).action, "set");    // 150 %
  assert.equal(checkPriceChange(100, 140, "50").action, "set");
});

test("ugyldig grense gir standard 30", () => {
  for (const v of [null, undefined, 0, -1, "abc"]) assert.equal(normalizeMaxPct(v), 30);
  assert.equal(checkPriceChange(100, 135, 0).action, "approval");
});
