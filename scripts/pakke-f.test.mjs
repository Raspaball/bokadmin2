// node --test scripts/*.test.mjs
// Pakke F del 2 og 3: bare bøker (book-format.ts), lager går foran Bokbasen
// (planAvailability i availability.ts), bok.bokgruppe (book-standard.ts / bokgruppe.ts)
// og én loggrad per produkt (job-log.ts).
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOK_FORM_PREFIXES, isBookForm, notBookMessage, notBookSkip, NOT_IN_BOKBASEN_MESSAGE,
} from "../supabase/functions/_shared/book-format.ts";
import { availabilityLogMessage, availabilityRule, inStockMessage, planAvailability } from "../supabase/functions/_shared/availability.ts";
import { bookFieldsFromOnix, bookMetafields } from "../supabase/functions/_shared/book-standard.ts";
import { BOKGRUPPE_METAFIELD } from "../supabase/functions/_shared/bokgruppe.ts";
import { BOOK_METAFIELD_KEYS, planBookUpdate } from "../supabase/functions/_shared/book-update.ts";
import { changedRow, errorRow, logRow, OUTCOMES, SKIP_REASONS, skipRow, unchangedRow } from "../supabase/functions/_shared/job-log.ts";

setProtectedMembers([]);

const onixWith = (form, extra = "") =>
  `<ONIXMessage><Product><RecordReference>x</RecordReference><DescriptiveDetail><ProductForm>${form}</ProductForm>${extra}</DescriptiveDetail></Product></ONIXMessage>`;

// ── Bare bøker (del 2.2) ──
test("bokformat: ProductForm B*, A* og E* er bøker; alt annet er ikke", () => {
  assert.deepEqual([...BOOK_FORM_PREFIXES], ["B", "A", "E"]);
  for (const f of ["BA", "BB", "BC", "BH", "BZ", "AJ", "AN", "EA", "ED", " bc "]) assert.equal(isBookForm(f), true, f);
  // Kalender (PC), plakat (PK), puslespill/spill (ZJ), notatbok (PB), kart (CB), mangler
  for (const f of ["PC", "PK", "ZJ", "PB", "CB", "", null, undefined]) assert.equal(isBookForm(f), false, String(f));
});

test("notBookSkip: loggtekst for ikke-bøker, null for bøker og uten ONIX", () => {
  assert.equal(notBookSkip(onixWith("BC")), null);
  assert.equal(notBookSkip(onixWith("PC")), "Hoppet over: ikke bok (ProductForm PC)");
  assert.equal(notBookSkip(null), null);
  assert.equal(notBookMessage(null), "Hoppet over: ikke bok (ProductForm mangler)");
  assert.equal(NOT_IN_BOKBASEN_MESSAGE, "Hoppet over: fant ikke boka i Bokbasen");
});

// ── Lager går foran Bokbasen (del 2.1) ──
const deny = { inventoryPolicy: "DENY", inventoryItem: { tracked: true } };
const product = (over = {}) => ({ status: "ACTIVE", tilgjengelighet: { value: "tilgjengelig" }, variant: deny, ...over });

test("på lager: kode 40 gir ikke utkast, inventoryPolicy står, bok.tilgjengelighet settes", () => {
  const rule = availabilityRule("40");
  const plan = planAvailability(product({ totalInventory: 3 }), rule, null);
  assert.deepEqual(plan.changes, { tilgjengelighet: { from: "tilgjengelig", to: "ikke_tilgjengelig" } });
  assert.deepEqual(plan.stockKept, { status: { from: "ACTIVE", to: "DRAFT" } });
  assert.equal(plan.inStock, 3);
  const msg = availabilityLogMessage(plan, rule, null, "Ville endret");
  assert.match(msg, /^Ville endret: .*tilgjengelighet tilgjengelig → ikke_tilgjengelig/);
  assert.match(msg, /Status beholdt: på lager \(3\) \(regelen: Ikke tilgjengelig \(kode 40\): DRAFT; ville endret status ACTIVE → DRAFT\)/);
  assert.equal(inStockMessage(3), "Status beholdt: på lager (3)");
});

test("på lager: utgått (43) blir ikke arkivert", () => {
  const plan = planAvailability(product({ totalInventory: 1 }), availabilityRule("43"), null);
  assert.equal(plan.changes.status, undefined);
  assert.deepEqual(plan.stockKept.status, { from: "ACTIVE", to: "ARCHIVED" });
});

test("på lager: kjøpbar bok får ikke CONTINUE (policy endres ikke), men kan bli aktiv", () => {
  const rule = availabilityRule("21");
  const plan = planAvailability(product({ status: "DRAFT", totalInventory: 5 }), rule, null);
  assert.deepEqual(plan.changes.status, { from: "DRAFT", to: "ACTIVE" });
  assert.equal(plan.changes.continuePolicy, undefined);
  assert.deepEqual(plan.stockKept, { continuePolicy: true });
});

test("uten lager (0, negativ, mangler): regelen gjelder som før", () => {
  for (const totalInventory of [0, -2, null, undefined]) {
    const plan = planAvailability(product({ totalInventory }), availabilityRule("40"), null);
    assert.deepEqual(plan.changes.status, { from: "ACTIVE", to: "DRAFT" }, String(totalInventory));
    assert.deepEqual(plan.stockKept, {});
    assert.equal(plan.inStock, 0);
  }
});

test("egen tilgjengelighet går foran lager: alt holdes tilbake som egen", () => {
  const plan = planAvailability(product({ totalInventory: 4, egenTilgjengelighet: { value: "true" } }), availabilityRule("40"), null);
  assert.equal(plan.ownAvailability, true);
  assert.deepEqual(plan.changes, {});
  assert.deepEqual(plan.stockKept, {});
});

// ── bok.bokgruppe (del 2.4) ──
const onixBook = onixWith("BC", "") .replace("</DescriptiveDetail>",
  "<Subject><SubjectSchemeIdentifier>37</SubjectSchemeIdentifier><SubjectCode>417</SubjectCode></Subject></DescriptiveDetail>");

test("bok.bokgruppe: koden fra ONIX som metafelt, samme som bkg-taggene", () => {
  assert.deepEqual(BOKGRUPPE_METAFIELD, { namespace: "bok", key: "bokgruppe", type: "single_line_text_field" });
  const f = bookFieldsFromOnix(onixBook);
  assert.equal(f.bokgruppe, "417");
  assert.deepEqual(bookMetafields(f).find((m) => m.key === "bokgruppe"), { namespace: "bok", key: "bokgruppe", type: "single_line_text_field", value: "417" });
  assert.equal(bookMetafields(bookFieldsFromOnix(onixWith("BC"))).some((m) => m.key === "bokgruppe"), false);
  assert.ok(BOOK_METAFIELD_KEYS.includes("bokgruppe"));
});

test("oppdateringsjobben setter bok.bokgruppe når den mangler eller er feil, ellers ikke", () => {
  const base = { id: "gid://shopify/Product/1", handle: "h", title: "Tittel", tags: [], productType: "Bok", category: { id: "gid://shopify/TaxonomyCategory/me-1-3" } };
  const missing = planBookUpdate(base, onixBook);
  assert.ok(missing.changes.some((c) => c.field === "bok.bokgruppe" && c.to === "417"));
  const same = planBookUpdate({ ...base, mf_bokgruppe: { value: "417" } }, onixBook);
  assert.equal(same.changes.some((c) => c.field === "bok.bokgruppe"), false);
});

// ── Én loggrad per produkt (del 3.1) ──
const base = { isbn: "9788203461392", title: "avkledd", action: "book_update", shopify_id: "gid://shopify/Product/1", job_id: "j1", user_id: null };

test("loggrad: utfall, årsak og felt i egne kolonner; status som før", () => {
  assert.deepEqual([...OUTCOMES], ["endret", "uendret", "hoppet_over", "feil"]);
  assert.deepEqual(Object.keys(SKIP_REASONS), [
    "ingen_isbn", "ikke_bok", "ikke_i_bokbasen", "beskyttet", "duplikat", "egen_pris", "egen_tilgjengelighet", "paa_lager", "arkivert",
  ]);
  assert.deepEqual(changedRow(base, "Endret: x", ["productType", "bok.format"]),
    { ...base, status: "success", outcome: "endret", reason: null, fields: ["productType", "bok.format"], message: "Endret: x" });
  assert.deepEqual(unchangedRow(base), { ...base, status: "info", outcome: "uendret", reason: null, fields: null, message: "Uendret" });
  assert.deepEqual(skipRow(base, "ikke_bok", "Hoppet over: ikke bok (ProductForm PC)"),
    { ...base, status: "info", outcome: "hoppet_over", reason: "ikke_bok", fields: null, message: "Hoppet over: ikke bok (ProductForm PC)" });
  assert.deepEqual(errorRow(base, "Feil: x"), { ...base, status: "error", outcome: "feil", reason: null, fields: null, message: "Feil: x" });
  // Årsak bare når produktet er hoppet over
  assert.equal(logRow(base, "endret", "x", { reason: "duplikat" }).reason, null);
});

// ── Øyeblikksbilde før/etter (del 3.3) ──
test("snapshot-diff: felt for felt, også updatedAt, metafelt og variant", async () => {
  const { diffProduct } = await import("./snapshot-diff.mjs");
  const p = {
    id: "gid://shopify/Product/1", handle: "h", title: "T", status: "ACTIVE", tags: ["b", "a"], updatedAt: "2026-10-01T00:00:00Z",
    variants: [{ id: "gid://shopify/ProductVariant/1", price: "199.00", inventoryItem: { tracked: false } }],
    metafields: [{ namespace: "bok", key: "format", value: "Heftet" }], media: [],
  };
  assert.deepEqual(diffProduct(p, { ...p, tags: ["a", "b"] }), []);
  const d = diffProduct(p, {
    ...p, updatedAt: "2026-10-02T00:00:00Z", variants: [{ ...p.variants[0], price: "249.00" }],
    metafields: [...p.metafields, { namespace: "bok", key: "bokgruppe", value: "417" }],
  });
  assert.deepEqual(d.map((c) => c.field).sort(), ["mf.bok.bokgruppe", "updatedAt", "variant.price"]);
});
