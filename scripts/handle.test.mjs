// Tester for handle-regelen. Kjør: node --test scripts/handle.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBookHandle, firstAuthor, normalizeIsbn, slugify } from "../supabase/functions/_shared/handle.js";

test("tittel + forfatter (snudd fra productType) + ISBN", () => {
  assert.equal(
    buildBookHandle({ title: "Glukoserevolusjonens metode", authors: "Inchauspé, Jessie", isbn: "9788202921538" }),
    "glukoserevolusjonens-metode-jessie-inchauspe-9788202921538",
  );
});

test("bare første forfatter brukes", () => {
  assert.equal(
    buildBookHandle({ title: "Alt starter med en drøm", authors: "Nusa, Antonio, Saugestad, Frode", isbn: "9788205621060" }),
    "alt-starter-med-en-drom-antonio-nusa-9788205621060",
  );
});

test("undertittel etter kolon kuttes", () => {
  assert.equal(
    buildBookHandle({ title: "Avkledd: den syke historien om kvinners seksualitet i medisinen", authors: "Brochmann, Nina", isbn: "9788203461392" }),
    "avkledd-nina-brochmann-9788203461392",
  );
});

test("forfatter fra metafeltet bok.forfatter (JSON-liste, fornavn først)", () => {
  assert.equal(firstAuthor('["Jon Fosse","Ingen Andre"]'), "Jon Fosse");
  assert.equal(firstAuthor(["Jon Fosse"]), "Jon Fosse");
});

test("uten forfatter: tittel + ISBN", () => {
  assert.equal(
    buildBookHandle({ title: "Det hende i Telemark 8", authors: "", isbn: "9788293891604" }),
    "det-hende-i-telemark-8-9788293891604",
  );
});

test("uten ISBN: null (hoppes over)", () => {
  assert.equal(buildBookHandle({ title: "Notatbok A5", authors: "", isbn: "" }), null);
  assert.equal(buildBookHandle({ title: "Gavekort", authors: "", isbn: "gavekort-500" }), null);
});

test("norske tegn, & og aksenter", () => {
  assert.equal(slugify("Hjerte & smerte: Æ, Ø og Å"), "hjerte-og-smerte-ae-o-og-a");
  assert.equal(slugify("Bjarni Haukur Þórsson"), "bjarni-haukur-thorsson");
  assert.equal(slugify("«...alt hvad Folket i disse Bygder maa kunne!»"), "alt-hvad-folket-i-disse-bygder-maa-kunne");
});

test("lang tittel kuttes ved helt ord, maks 60 tegn", () => {
  const h = buildBookHandle({
    title: "En veldig lang tittel som aldri tar slutt fordi forlaget elsket ord og enda flere ord",
    authors: "Hansen, Kari",
    isbn: "9788205123458",
  });
  const titlePart = h.replace(/-kari-hansen-9788205123458$/, "");
  assert.ok(titlePart.length <= 60, `tittel-delen er ${titlePart.length} tegn`);
  assert.ok(!titlePart.endsWith("-"));
  assert.equal(titlePart, "en-veldig-lang-tittel-som-aldri-tar-slutt-fordi-forlaget");
});

test("ISBN normaliseres (bindestreker, ISBN-10)", () => {
  assert.equal(normalizeIsbn("978-82-02-92153-8"), "9788202921538");
  assert.equal(normalizeIsbn("8202921538"), "9788202921538");
  assert.equal(normalizeIsbn("12345"), null);
  assert.equal(normalizeIsbn("5784397765"), null, "strekkode som ikke er gyldig ISBN-10");
  assert.equal(normalizeIsbn("9788202921539"), null, "feil kontrollsiffer");
});

// ── extractIsbn (supabase/functions/_shared/isbn.js) ─────────────────────────
import { extractIsbn } from "../supabase/functions/_shared/isbn.js";

test("extractIsbn: bok.isbn går foran strekkode, SKU og handle", () => {
  assert.equal(extractIsbn({
    handle: "avkledd-nina-brochmann-9788203461392",
    bokIsbn: { value: "9788203461392" },
    variants: { nodes: [{ barcode: "9788202921538", sku: "9788202921538" }] },
  }), "9788203461392");
});

test("extractIsbn: strekkode, så SKU (edges eller nodes, sku på inventoryItem)", () => {
  assert.equal(extractIsbn({ handle: "x", variants: { edges: [{ node: { barcode: "978-82-02-92153-8" } }] } }), "9788202921538");
  assert.equal(extractIsbn({ handle: "x", variants: { edges: [{ node: { barcode: "", inventoryItem: { sku: "9788202921538" } } }] } }), "9788202921538");
  assert.equal(extractIsbn({ handle: "x", variants: { nodes: [{ barcode: "5784397765", sku: "9788202921538" }] } }), "9788202921538");
});

test("extractIsbn: handle bare når den er et rent ISBN", () => {
  assert.equal(extractIsbn({ handle: "9788203461392", variants: { nodes: [] } }), "9788203461392");
  // ny handle med ISBN i slutten skal ikke tolkes (bruk bok.isbn/strekkode/SKU)
  assert.equal(extractIsbn({ handle: "avkledd-nina-brochmann-9788203461392", variants: { nodes: [] } }), null);
  assert.equal(extractIsbn({ handle: "notatbok-a5", variants: { nodes: [{ barcode: null, sku: "NB-A5" }] } }), null);
  assert.equal(extractIsbn(null), null);
});

// ── planHandleMigration (supabase/functions/_shared/handle-migration.js) ─────
import { planHandleMigration, isBlockedRow, handleUpdateInput } from "../supabase/functions/_shared/handle-migration.js";

const prod = (id, handle, title, productType, isbn, extra = {}) => ({
  id: `gid://shopify/Product/${id}`, handle, title, productType, status: "ACTIVE",
  variants: { nodes: [{ barcode: isbn, sku: isbn }] }, ...extra,
});

test("planHandleMigration: ny handle, allerede riktig, uten ISBN, egendefinert, mangler forfatter", () => {
  const r = planHandleMigration([
    prod(1, "9788203461392", "Avkledd: undertittel", "Brochmann, Nina", "9788203461392"),
    prod(2, "glukoserevolusjonens-metode-jessie-inchauspe-9788202921538", "Glukoserevolusjonens metode", "Inchauspé, Jessie", "9788202921538"),
    prod(3, "gavekort", "Gavekort", "", null),
    prod(4, "min-egen-handle", "Alt starter med en drøm", "Nusa, Antonio", "9788205621060"),
    prod(5, "9788293891604", "Det hende i Telemark 8", "", "9788293891604"),
  ]);
  assert.deepEqual(r.skipped, { ingenIsbn: 1, alleredeRiktig: 1, egendefinert: 1, beskyttet: 0 });
  assert.equal(r.counts.planned, 2);
  assert.equal(r.counts.missingAuthor, 1);
  assert.equal(r.counts.blocked, 0);
  assert.equal(r.plan[0].newHandle, "avkledd-nina-brochmann-9788203461392");
  assert.deepEqual(r.plan[1].flags, ["mangler forfatter"]);
  assert.equal(r.plan[0].setIsbn, true);
});

test("planHandleMigration: duplikat-ISBN og kollisjon blokkerer", () => {
  const r = planHandleMigration([
    prod(1, "9788203461392", "Avkledd", "Brochmann, Nina", "9788203461392"),
    prod(2, "8203461392", "Avkledd", "Brochmann, Nina", "9788203461392"),
    prod(3, "9788202921538", "Glukose", "Inchauspé, Jessie", "9788202921538"),
    prod(4, "glukose-jessie-inchauspe-9788202921538", "Noe annet", "", null),
  ]);
  assert.equal(r.counts.blocked, 3);
  assert.ok(r.plan.every(isBlockedRow));
  assert.ok(r.plan.find((p) => p.oldHandle === "9788202921538").flags.includes("handle finnes allerede"));
});

test("handleUpdateInput: 301 og bok.isbn bare når det mangler", () => {
  assert.deepEqual(handleUpdateInput({ id: "gid://shopify/Product/1", newHandle: "a-b-9788203461392", isbn: "9788203461392", setIsbn: false }),
    { id: "gid://shopify/Product/1", handle: "a-b-9788203461392", redirectNewHandle: true });
  assert.deepEqual(handleUpdateInput({ id: "x", newHandle: "h", isbn: "9788203461392", setIsbn: true }).metafields,
    [{ namespace: "bok", key: "isbn", value: "9788203461392" }]);
});
