// node --test scripts/*.test.mjs
// Tellinger og sammendrag for prisjobben (supabase/functions/_shared/price-summary.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { countMissing, emptyCounts, loadCounts, summarizeCounts } from "../supabase/functions/_shared/price-summary.ts";

test("sammendrag i oppdateringsmodus", () => {
  const c = emptyCounts();
  c.changed = 3; c.same = 40; c.approval = 1; c.skippedOwnPrice = 1; c.skippedOffer = 1; c.skippedNoIsbn = 20; c.skippedProtected = 2;
  countMissing(c, "ingen pris");
  countMissing(c, "ingen NOK-pris");
  countMissing(c, "ingen pris");
  assert.equal(
    summarizeCounts(c, "update"),
    "3 endret, 40 samme pris, 1 krever godkjenning, hoppet over 24 (1 egen pris, 1 tilbud, 20 uten ISBN, 2 beskyttet), 3 manglet godkjent pris (2 ingen pris, 1 ingen NOK-pris), 0 feil",
  );
});

test("sammendrag i sjekkmodus", () => {
  assert.equal(
    summarizeCounts(emptyCounts(), "analyze"),
    "0 ville fått ny pris, 0 samme pris, 0 ville krevd godkjenning, hoppet over 0 (0 egen pris, 0 tilbud, 0 uten ISBN, 0 beskyttet), 0 manglet godkjent pris, 0 feil",
  );
});

test("loadCounts: tom eller ufullstendig gir 0, og verdier beholdes", () => {
  assert.deepEqual(loadCounts(undefined), emptyCounts());
  const c = loadCounts({ changed: 2, missing: { "ingen pris": 1, feil: "x" }, ukjent: 5 });
  assert.equal(c.changed, 2);
  assert.equal(c.same, 0);
  assert.deepEqual(c.missing, { "ingen pris": 1 });
});

test("manglende årsak telles som ukjent", () => {
  const c = emptyCounts();
  countMissing(c, null);
  assert.deepEqual(c.missing, { "ukjent årsak": 1 });
});
