// node --test scripts/*.test.mjs
// Tilgjengelighetsregelen (supabase/functions/_shared/availability.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityDescription, availabilityMetafields, availabilityRule, formatNorwegianDate, needsContinuePolicy,
} from "../supabase/functions/_shared/availability.ts";

const pick = (code) => {
  const r = availabilityRule(code);
  return [r.status, r.tilgjengelighet, r.buyable];
};

test("20–23: tilgjengelig, ACTIVE, kan kjøpes", () => {
  for (const c of ["20", "21", "22", "23"]) assert.deepEqual(pick(c), ["ACTIVE", "tilgjengelig", true], c);
});

test("10, 11, 12: kommer, ACTIVE, kan kjøpes", () => {
  for (const c of ["10", "11", "12"]) assert.deepEqual(pick(c), ["ACTIVE", "kommer", true], c);
});

test("30–34: midlertidig utsolgt, ACTIVE, kan kjøpes", () => {
  for (const c of ["30", "31", "32", "33", "34"]) assert.deepEqual(pick(c), ["ACTIVE", "midlertidig_utsolgt", true], c);
});

test("43, 46, 49: utgått, ARCHIVED", () => {
  for (const c of ["43", "46", "49"]) assert.deepEqual(pick(c), ["ARCHIVED", "utgatt", false], c);
});

test("alt annet: ikke tilgjengelig, DRAFT", () => {
  for (const c of ["01", "09", "13", "40", "41", "42", "44", "45", "47", "48", "50", "51", "52", "97", "98", "99"]) {
    assert.deepEqual(pick(c), ["DRAFT", "ikke_tilgjengelig", false], c);
  }
});

test("ukjent og tom kode: DRAFT", () => {
  for (const c of ["", null, undefined, "abc", "200", "  "]) assert.deepEqual(pick(c), ["DRAFT", "ikke_tilgjengelig", false], String(c));
  assert.equal(availabilityRule(" 21 ").tilgjengelighet, "tilgjengelig");
});

test("CONTINUE bare for kjøpbare bøker med sporet lager og DENY", () => {
  const kommer = availabilityRule("10");
  assert.equal(needsContinuePolicy(kommer, { inventoryPolicy: "DENY", inventoryItem: { tracked: true } }), true);
  assert.equal(needsContinuePolicy(kommer, { inventoryPolicy: "CONTINUE", inventoryItem: { tracked: true } }), false);
  assert.equal(needsContinuePolicy(kommer, { inventoryPolicy: "DENY", inventoryItem: { tracked: false } }), false);
  assert.equal(needsContinuePolicy(availabilityRule("40"), { inventoryPolicy: "DENY", inventoryItem: { tracked: true } }), false);
  assert.equal(needsContinuePolicy(kommer, null), false);
});

test("loggtekster", () => {
  assert.equal(availabilityDescription(availabilityRule("10"), "2026-11-15"), "Kommer 15.11.2026: ACTIVE, kan forhåndsbestilles");
  assert.equal(availabilityDescription(availabilityRule("11"), null), "Kommer: ACTIVE, kan forhåndsbestilles");
  assert.equal(availabilityDescription(availabilityRule("31")), "Midlertidig utsolgt: ACTIVE, kan bestilles");
  assert.equal(availabilityDescription(availabilityRule("21")), "Tilgjengelig: ACTIVE");
  assert.equal(availabilityDescription(availabilityRule("43")), "Utgått (kode 43): ARCHIVED");
  assert.equal(availabilityDescription(availabilityRule("40")), "Ikke tilgjengelig (kode 40): DRAFT");
  assert.equal(availabilityDescription(availabilityRule("")), "Ikke tilgjengelig (ingen kode): DRAFT");
  assert.equal(formatNorwegianDate("2026-01-05"), "05.01.2026");
});

test("metafelt: utgivelsesdato bare med hel dato", () => {
  const r = availabilityRule("10");
  assert.deepEqual(availabilityMetafields("gid://shopify/Product/1", r, "2026-11-15").map((m) => [m.key, m.type, m.value]), [
    ["tilgjengelighet", "single_line_text_field", "kommer"],
    ["utgivelsesdato", "date", "2026-11-15"],
  ]);
  assert.equal(availabilityMetafields("gid://shopify/Product/1", r, "2026").length, 1);
  assert.equal(availabilityMetafields("gid://shopify/Product/1", r, null).length, 1);
});
