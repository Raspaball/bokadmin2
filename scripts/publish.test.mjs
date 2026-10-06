// node --test scripts/*.test.mjs
// Pakke H del 2: salgskanaler (_shared/publish.ts)
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
setProtectedMembers([]);
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLISHED_ON_BULK_FIELD, channelsToPublish, publishBulkLine, publishSummary } from "../supabase/functions/_shared/publish.ts";
import { BULK_PRODUCTS_QUERY, BulkProductAssembler } from "../supabase/functions/_shared/book-bulk.ts";
import { AVAILABILITY_BULK_QUERY } from "../supabase/functions/_shared/availability-bulk.ts";

const ALL = ["gid://shopify/Publication/1", "gid://shopify/Publication/2", "gid://shopify/Publication/3"];
const book = (o = {}) => ({ id: "gid://shopify/Product/1", handle: "x", tags: [], vendor: "Gyldendal", productType: "Bok", publicationIds: [ALL[0]], ...o });

test("bok som mangler kanaler får de som mangler", () => {
  assert.deepEqual(channelsToPublish(ALL, book(), "Bok", true), [ALL[1], ALL[2]]);
  assert.deepEqual(channelsToPublish(ALL, book({ publicationIds: [] }), "Bok", true), ALL);
});

test("allerede på alle kanaler: ingenting", () => {
  assert.deepEqual(channelsToPublish(ALL, book({ publicationIds: [...ALL] }), "Bok", true), []);
});

test("blir ikke aktiv: ingenting", () => {
  assert.deepEqual(channelsToPublish(ALL, book({ publicationIds: [] }), "Bok", false), []);
});

test("lydbok, e-bok og ikke-bok røres ikke (ONIX og produkttype)", () => {
  for (const t of ["Lydbok", "E-bok", null]) assert.deepEqual(channelsToPublish(ALL, book({ publicationIds: [] }), t, true), [], String(t));
  assert.deepEqual(channelsToPublish(ALL, book({ publicationIds: [], productType: "Lydbok" }), "Bok", true), []);
  assert.deepEqual(channelsToPublish(ALL, book({ publicationIds: [], productType: "E-bok" }), "Bok", true), []);
  assert.equal(channelsToPublish(ALL, book({ publicationIds: [], productType: "" }), "Bok", true).length, 3);
});

test("beskyttede røres aldri (tagg og leverandør)", () => {
  assert.deepEqual(channelsToPublish(ALL, book({ publicationIds: [], tags: ["Gave"] }), "Bok", true), []);
  assert.deepEqual(channelsToPublish(ALL, book({ publicationIds: [], vendor: "Wrendale Design ltd" }), "Bok", true), []);
});

test("ukjente kanaler (spørringen mangler feltet): ingenting", () => {
  assert.deepEqual(channelsToPublish(ALL, book({ publicationIds: undefined }), "Bok", true), []);
});

test("linje og sammendrag", () => {
  assert.deepEqual(publishBulkLine("gid://shopify/Product/1", [ALL[1]]), { id: "gid://shopify/Product/1", input: [{ publicationId: ALL[1] }] });
  assert.equal(publishSummary(3, 5, false), "ville blitt publisert på 5 kanaler (3 bøker)");
  assert.equal(publishSummary(3, 5, true), "publisert på 5 kanaler (3 bøker)");
});

test("begge bulk-spørringene henter kanalene", () => {
  assert.ok(BULK_PRODUCTS_QUERY.includes(PUBLISHED_ON_BULK_FIELD));
  assert.ok(AVAILABILITY_BULK_QUERY.includes(PUBLISHED_ON_BULK_FIELD));
});

test("assembleren leser kanalene fra barnelinjene (også i slim-modus)", () => {
  const P = "gid://shopify/Product/1";
  const lines = [
    { __typename: "Product", id: P, handle: "a", status: "ACTIVE" },
    { __typename: "ResourcePublicationV2", publication: { id: ALL[0] }, __parentId: P },
    { __typename: "ProductVariant", id: "v", barcode: "1", sku: "1", __parentId: P },
    { __typename: "ResourcePublicationV2", publication: { id: ALL[2] }, __parentId: P },
  ].map((o) => JSON.stringify(o));
  for (const slim of [false, true]) {
    const a = new BulkProductAssembler(() => true, slim);
    lines.forEach((l) => a.add(l));
    assert.deepEqual(a.products[0].publicationIds, [ALL[0], ALL[2]]);
    assert.equal(a.products[0].variants.nodes.length, 1);
  }
});
