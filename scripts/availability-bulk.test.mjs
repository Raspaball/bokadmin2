// node --test scripts/*.test.mjs
// Bulk-modus for tilgjengelighetssjekken (pakke E del 5): _shared/availability-bulk.ts.
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
// Ingen produkter i beskyttede samlinger her (medlemskap testes i protected.test.mjs)
setProtectedMembers([]);
import { test } from "node:test";
import assert from "node:assert/strict";
import { AVAILABILITY_BULK_QUERY, availabilityBulkLines } from "../supabase/functions/_shared/availability-bulk.ts";
import { availabilityRule, planAvailability } from "../supabase/functions/_shared/availability.ts";
import { assembleBulkProducts } from "../supabase/functions/_shared/book-bulk.ts";

const product = (over = {}) => ({
  id: "gid://shopify/Product/1", tags: ["bkg-3"], status: "DRAFT",
  tilgjengelighet: null, utgivelsesdato: null,
  variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", inventoryPolicy: "DENY", inventoryItem: { tracked: true } }] },
  ...over,
});
const lines = (p, code, date = null) => {
  const rule = availabilityRule(code);
  const plan = planAvailability({ ...p, variant: p.variants.nodes[0] }, rule, date);
  return availabilityBulkLines(p, rule, date, plan);
};

test("kommer: CONTINUE-linje og productUpdate med status og begge metafelt", () => {
  const l = lines(product(), "10", "2026-11-15");
  assert.deepEqual(l.variant, { productId: "gid://shopify/Product/1", variants: [{ id: "gid://shopify/ProductVariant/9", inventoryPolicy: "CONTINUE" }] });
  assert.deepEqual(l.product, { product: {
    id: "gid://shopify/Product/1", status: "ACTIVE",
    metafields: [
      { namespace: "bok", key: "tilgjengelighet", type: "single_line_text_field", value: "kommer" },
      { namespace: "bok", key: "utgivelsesdato", type: "date", value: "2026-11-15" },
    ],
  } });
});

test("bare feltene som endres skrives", () => {
  const p = product({ status: "ACTIVE", tilgjengelighet: { value: "tilgjengelig" }, variants: { nodes: [{ id: "v", inventoryPolicy: "CONTINUE", inventoryItem: { tracked: true } }] } });
  assert.deepEqual(lines(p, "21"), { variant: null, product: null });
  const l = lines({ ...p, utgivelsesdato: { value: "2020-01-01" } }, "21", "2020-02-02");
  assert.deepEqual(l.product.product, { id: p.id, metafields: [{ namespace: "bok", key: "utgivelsesdato", type: "date", value: "2020-02-02" }] });
});

test("egen tilgjengelighet: ingen status, CONTINUE eller tilgjengelighet i linjene", () => {
  const p = product({ status: "ACTIVE", egenTilgjengelighet: { value: "true" }, utgivelsesdato: { value: "2020-01-01" } });
  const l = lines(p, "40", "2021-01-01");
  assert.equal(l.variant, null);
  assert.deepEqual(l.product.product, { id: p.id, metafields: [{ namespace: "bok", key: "utgivelsesdato", type: "date", value: "2021-01-01" }] });
  assert.deepEqual(lines({ ...p, utgivelsesdato: { value: "2021-01-01" } }, "40", "2021-01-01"), { variant: null, product: null });
});

test("beskyttet: aldri linjer", () => {
  for (const tag of ["gave", "LOKAL", " lokalhistorie ", "Lokallitteratur"]) {
    assert.deepEqual(lines(product({ tags: [tag] }), "10", "2026-11-15"), { variant: null, product: null }, tag);
  }
  assert.notEqual(lines(product({ tags: ["oppgaver"] }), "10").product, null);
});

test("bulk-fila: variant med lager kobles til produktet", () => {
  const text = [
    JSON.stringify({ __typename: "Product", id: "gid://shopify/Product/1", title: "T", handle: "h", status: "ACTIVE", tags: [], bokIsbn: { value: "9788202875244" }, tilgjengelighet: null, utgivelsesdato: null, egenTilgjengelighet: { value: "true" } }),
    JSON.stringify({ __typename: "ProductVariant", id: "gid://shopify/ProductVariant/9", barcode: "9788202875244", sku: null, inventoryPolicy: "DENY", inventoryItem: { tracked: true }, __parentId: "gid://shopify/Product/1" }),
  ].join("\n");
  const [p] = assembleBulkProducts(text);
  assert.equal(p.status, "ACTIVE");
  assert.equal(p.egenTilgjengelighet.value, "true");
  assert.deepEqual(p.variants.nodes[0].inventoryItem, { tracked: true });
  assert.match(AVAILABILITY_BULK_QUERY, /egenTilgjengelighet: metafield\(namespace: "bok", key: "egen_tilgjengelighet"\)/);
});
