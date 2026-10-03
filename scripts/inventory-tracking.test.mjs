// node --test scripts/*.test.mjs
// Pakke G del 2: ingen bok skal ha «Spor beholdning» på (_shared/inventory-tracking.ts).
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
setProtectedMembers([]);
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STOCK_BEFORE_BOKBASEN, TRACK_INVENTORY, UNTRACK_VARIANT_FIELDS, effectiveStock, needsUntrack,
} from "../supabase/functions/_shared/inventory-tracking.ts";
import { availabilityLogMessage, availabilityRule, describeAvailabilityChanges, planAvailability } from "../supabase/functions/_shared/availability.ts";
import { availabilityBulkLines } from "../supabase/functions/_shared/availability-bulk.ts";

const V = "gid://shopify/ProductVariant/9";
const variant = (tracked, policy = "DENY") => ({ id: V, inventoryPolicy: policy, inventoryItem: { tracked } });
const product = (tracked, over = {}) => ({
  id: "gid://shopify/Product/1", tags: ["bkg-3"], status: "ACTIVE", totalInventory: 0,
  tilgjengelighet: { value: "tilgjengelig" }, utgivelsesdato: null,
  variants: { nodes: [variant(tracked)] }, ...over,
});
const plan = (p, code = "21", date = null) => planAvailability({ ...p, variant: p.variants.nodes[0] }, availabilityRule(code), date);

test("policy: bøker spores aldri, og beholdning går ikke foran Bokbasen", () => {
  assert.equal(TRACK_INVENTORY, false);
  assert.equal(STOCK_BEFORE_BOKBASEN, false);
  assert.equal(effectiveStock(12), 0);
  assert.deepEqual(UNTRACK_VARIANT_FIELDS, { inventoryItem: { tracked: false } });
});

test("needsUntrack: bare når sporing er på", () => {
  assert.equal(needsUntrack(variant(true)), true);
  assert.equal(needsUntrack(variant(false)), false);
  assert.equal(needsUntrack({ inventoryItem: null }), false);
  assert.equal(needsUntrack(null), false);
  assert.equal(needsUntrack(undefined), false);
});

test("sporet bok: sporing slås av, og CONTINUE trengs ikke (også når policyen er DENY)", () => {
  const p = plan(product(true));
  assert.deepEqual(p.changes, { untrack: true });
  assert.equal(p.changes.continuePolicy, undefined);
  assert.equal(describeAvailabilityChanges(p.changes), "sporing av beholdning slås av");
  assert.equal(availabilityLogMessage(p, availabilityRule("21"), null, "Ville endret"),
    "Ville endret: Tilgjengelig: ACTIVE (sporing av beholdning slås av)");
});

test("bok uten sporing: ingenting å gjøre, uansett inventoryPolicy", () => {
  assert.deepEqual(plan(product(false)).changes, {});
  assert.deepEqual(plan({ ...product(false), variants: { nodes: [variant(false, "CONTINUE")] } }).changes, {});
  // Produkt uten variantdata: ingen sporing å slå av
  assert.deepEqual(planAvailability({ status: "ACTIVE", tilgjengelighet: { value: "tilgjengelig" } }, availabilityRule("21"), null).changes, {});
});

test("beholdning teller ikke: bok med lager og kode 40 blir utkast, 43 arkivert", () => {
  const draft = plan(product(true, { totalInventory: 7 }), "40");
  assert.deepEqual(draft.changes.status, { from: "ACTIVE", to: "DRAFT" });
  assert.deepEqual(draft.stockKept, {});
  assert.equal(draft.changes.untrack, true);
  assert.deepEqual(plan(product(true, { totalInventory: 7 }), "43").changes.status, { from: "ACTIVE", to: "ARCHIVED" });
});

test("egen tilgjengelighet: status står, men sporing slås av", () => {
  const p = plan(product(true, { egenTilgjengelighet: { value: "true" } }), "40");
  assert.deepEqual(p.changes, { untrack: true });
  assert.deepEqual(Object.keys(p.heldBack).sort(), ["status", "tilgjengelighet"]);
});

test("bulk: variantlinje med inventoryItem.tracked false (alene eller sammen med status)", () => {
  const p = product(true, { status: "DRAFT" });
  const rule = availabilityRule("21");
  const l = availabilityBulkLines(p, rule, null, plan(p));
  assert.deepEqual(l.variant, { productId: p.id, variants: [{ id: V, inventoryItem: { tracked: false } }] });
  assert.equal(l.product.product.status, "ACTIVE");
  // allerede uten sporing og ellers uendret: ingen linjer
  const q = product(false, { tilgjengelighet: { value: "tilgjengelig" } });
  assert.deepEqual(availabilityBulkLines(q, rule, null, plan(q)), { variant: null, product: null });
});

test("bulk: beskyttede produkter får aldri en sporing-av-linje", () => {
  for (const tag of ["gave", "Lokal", " lokalhistorie ", "LOKALLITTERATUR"]) {
    const p = product(true, { tags: [tag] });
    assert.deepEqual(availabilityBulkLines(p, availabilityRule("21"), null, plan(p)), { variant: null, product: null }, tag);
  }
  assert.notEqual(availabilityBulkLines(product(true, { tags: ["oppgaver"] }), availabilityRule("21"), null, plan(product(true))).variant, null);
});
