// node --test scripts/*.test.mjs
// Egen tilgjengelighet og arkiverte produkter (pakke E del 2 og 3):
// planAvailability / availabilitySkip / availabilityLogMessage i _shared/availability.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityLogMessage, availabilityMetafields, availabilityRule, availabilitySkip, ownAvailability, planAvailability,
} from "../supabase/functions/_shared/availability.ts";

const deny = { inventoryPolicy: "DENY", inventoryItem: { tracked: true } };
const product = (over = {}) => ({
  status: "ACTIVE",
  tilgjengelighet: { value: "tilgjengelig" },
  utgivelsesdato: { value: "2020-01-01" },
  variant: deny,
  ...over,
});

test("ownAvailability: bare true er egen tilgjengelighet", () => {
  for (const v of ["true", "TRUE", " true ", true, { value: "true" }]) assert.equal(ownAvailability(v), true, String(v));
  for (const v of ["false", false, null, undefined, "", { value: "false" }, {}]) assert.equal(ownAvailability(v), false, String(v));
});

test("uten egen tilgjengelighet: alt regelen sier endres", () => {
  const plan = planAvailability(product(), availabilityRule("40"), "2020-01-01");
  assert.deepEqual(plan.changes, { status: { from: "ACTIVE", to: "DRAFT" }, tilgjengelighet: { from: "tilgjengelig", to: "ikke_tilgjengelig" } });
  assert.deepEqual(plan.heldBack, {});
  assert.equal(plan.ownAvailability, false);
});

test("egen tilgjengelighet: status, tilgjengelighet og lager står (kode 40, engelsk bok)", () => {
  const plan = planAvailability(product({ egenTilgjengelighet: { value: "true" } }), availabilityRule("40"), "2020-01-01");
  assert.deepEqual(plan.changes, {});
  assert.deepEqual(Object.keys(plan.heldBack).sort(), ["status", "tilgjengelighet"]);
  assert.match(availabilityLogMessage(plan, availabilityRule("40"), null, "Ville endret"),
    /^Hoppet over: egen tilgjengelighet \(regelen: Ikke tilgjengelig \(kode 40\): DRAFT; ville endret status ACTIVE → DRAFT/);
});

test("egen tilgjengelighet: CONTINUE settes ikke, men utgivelsesdatoen oppdateres", () => {
  const p = product({ egenTilgjengelighet: { value: "true" }, status: "DRAFT", tilgjengelighet: null });
  const plan = planAvailability(p, availabilityRule("10"), "2026-11-15");
  assert.deepEqual(plan.changes, { utgivelsesdato: { from: "2020-01-01", to: "2026-11-15" } });
  assert.equal(plan.heldBack.continuePolicy, true);
  assert.equal(plan.heldBack.status.to, "ACTIVE");
  const msg = availabilityLogMessage(plan, availabilityRule("10"), "2026-11-15", "Endret");
  assert.match(msg, /^Endret: utgivelsesdato 2020-01-01 → 2026-11-15\. Hoppet over: egen tilgjengelighet/);
  // Bare datoen skrives som metafelt
  assert.deepEqual(availabilityMetafields("gid://shopify/Product/1", availabilityRule("10"), plan.changes.utgivelsesdato.to, false).map((m) => m.key), ["utgivelsesdato"]);
});

test("egen tilgjengelighet som allerede følger regelen: ingenting å melde", () => {
  const plan = planAvailability(product({ egenTilgjengelighet: { value: "true" }, variant: { inventoryPolicy: "CONTINUE", inventoryItem: { tracked: true } } }), availabilityRule("21"), null);
  assert.deepEqual(plan.changes, {});
  assert.deepEqual(plan.heldBack, {});
  assert.equal(availabilityLogMessage(plan, availabilityRule("21"), null, "Ville endret"), null);
});

test("egen tilgjengelighet = false behandles som vanlig", () => {
  const plan = planAvailability(product({ egenTilgjengelighet: { value: "false" } }), availabilityRule("40"), null);
  assert.equal(plan.changes.status.to, "DRAFT");
});

test("loggtekst uten egen tilgjengelighet er som før", () => {
  const rule = availabilityRule("10");
  const plan = planAvailability(product({ status: "DRAFT", tilgjengelighet: null, variant: null }), rule, "2026-11-15");
  assert.equal(availabilityLogMessage(plan, rule, "2026-11-15", "Ville endret"),
    "Ville endret: Kommer 15.11.2026: ACTIVE, kan forhåndsbestilles (status DRAFT → ACTIVE, tilgjengelighet mangler → kommer, utgivelsesdato 2020-01-01 → 2026-11-15)");
});

test("utgivelsesdato bare som hel dato", () => {
  const plan = planAvailability(product(), availabilityRule("21"), "2026");
  assert.deepEqual(plan.changes, { continuePolicy: true });
});

test("arkivert: hoppes alltid over, også når regelen sier ARCHIVED eller ACTIVE", () => {
  assert.equal(availabilitySkip({ status: "ARCHIVED" }), "arkivert");
  for (const s of ["ACTIVE", "DRAFT", "", null, undefined]) assert.equal(availabilitySkip({ status: s }), null, String(s));
});
