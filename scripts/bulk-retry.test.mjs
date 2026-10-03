// node --test scripts/*.test.mjs
// Pakke G del 4c: forbigående linjefeil i bulk-mutasjoner sendes på nytt (_shared/bulk-retry.ts).
// Feilen fra tilgjengelighetsjobben ed219b4f (2026-10-03): ISBN 9788205572775,
// «This product is currently being modified. Please try again later.»
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LINE_RETRIES, isTransientLineError, splitRetries } from "../supabase/functions/_shared/bulk-retry.ts";

test("forbigående feil kjennes igjen, ekte feil ikke", () => {
  assert.equal(isTransientLineError("This product is currently being modified. Please try again later."), true);
  assert.equal(isTransientLineError("Feil: Try again later"), true);
  assert.equal(isTransientLineError("Variant does not exist"), false);
  assert.equal(isTransientLineError("Tag cannot be longer than 255 characters"), false);
  assert.equal(isTransientLineError(""), false);
  assert.equal(isTransientLineError(null), false);
});

const refs = ["a", "b", "c", "d"].map((id) => ({ id, isbn: null, handle: id }));
const jsonl = ["L0", "L1", "L2", "L3"].join("\n");

test("bare de forbigående linjene sendes på nytt, de andre logges som feil", () => {
  const failed = new Map([[1, "This product is currently being modified. Please try again later."], [3, "Variant does not exist"]]);
  const r = splitRetries({ jsonl, refs }, failed);
  assert.deepEqual(r.retry, { jsonl: "L1", refs: [refs[1]], retry: 1 });
  assert.deepEqual(r.errors, [{ line: 3, ref: refs[3], error: "Variant does not exist" }]);
});

test("ingen feil: ingenting å sende på nytt", () => {
  assert.deepEqual(splitRetries({ jsonl, refs }, new Map()), { retry: null, errors: [] });
});

test("etter høyst to nye forsøk logges feilen", () => {
  const failed = new Map([[0, "This product is currently being modified"]]);
  let op = { jsonl: "L0", refs: [refs[0]] };
  for (let i = 1; i <= MAX_LINE_RETRIES; i++) {
    const r = splitRetries(op, failed);
    assert.equal(r.errors.length, 0);
    assert.equal(r.retry.retry, i);
    op = r.retry;
  }
  const last = splitRetries(op, failed);
  assert.equal(last.retry, null);
  assert.equal(last.errors.length, 1);
});
