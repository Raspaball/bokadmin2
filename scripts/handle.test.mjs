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
