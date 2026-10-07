import test from "node:test";
import assert from "node:assert/strict";
import { planRollback } from "./live-tilbakerull.mjs";

const P = (id, o = {}) => ({
  id: `gid://shopify/Product/${id}`, handle: `h${id}`, title: `T${id}`, status: "ACTIVE", vendor: "V", productType: "Bok", tags: ["bkg-1"],
  descriptionHtml: "<p>a</p>", templateSuffix: null, category: { id: "gid://shopify/TaxonomyCategory/me-1-3", fullName: "Print Books" },
  seo: { title: "s", description: "d" }, updatedAt: "x", publishedAt: "x", totalInventory: 0, resourcePublicationsCount: { count: 3 },
  variants: [{ id: `gid://shopify/ProductVariant/${id}`, sku: "9788200000001", barcode: "9788200000001", price: "100.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", taxable: false, inventoryItem: { tracked: false } }],
  metafields: [{ id: `gid://shopify/Metafield/${id}1`, namespace: "bok", key: "isbn", type: "id", value: "9788200000001" }],
  media: [{ id: `gid://shopify/MediaImage/${id}`, alt: "gammel alt", image: { url: "https://x/y.jpg" } }], ...o,
});
const snap = (products, redirects = [], collections = []) => ({ products: new Map(products.map((p) => [p.id, p])), redirects, collections: new Map(collections.map((c) => [c.id, c])) });

test("ingen endringer gir tom plan", () => {
  const b = snap([P(1)]);
  const plan = planRollback(b, snap([P(1, { updatedAt: "ny", totalInventory: 5 })]));
  assert.equal(plan.summary.produkterMedEndring, 0);
  assert.equal(plan.restoreProducts.length, 0);
});

test("endringer gjenopprettes felt for felt", () => {
  const before = snap([P(1), P(2), P(3)]);
  const changed = P(1, {
    title: "Ny tittel", status: "DRAFT", tags: ["bkg-1", "bkg-12"], seo: { title: "ny s", description: "d" },
    handle: "nytt-handle",
    metafields: [{ id: "m", namespace: "bok", key: "isbn", type: "id", value: "9788200000001" }, { id: "n", namespace: "bok", key: "tilgjengelighet", type: "single_line_text_field", value: "tilgjengelig" }],
    variants: [{ ...P(1).variants[0], price: "150.00" }],
    media: [{ ...P(1).media[0], alt: "ny alt" }],
  });
  const after = snap([changed, P(4)]);
  const plan = planRollback(before, after);

  const r = plan.restoreProducts.find((x) => x.product.id.endsWith("/1")).product;
  assert.equal(r.title, "T1"); assert.equal(r.status, "ACTIVE"); assert.deepEqual(r.tags, ["bkg-1"]);
  assert.deepEqual(r.seo, { title: "s" });
  assert.equal(r.handle, undefined, "handle rulles ikke tilbake i produktfilen");
  assert.deepEqual(plan.handleChanges, [{ id: changed.id, before: "h1", after: "nytt-handle" }]);
  assert.deepEqual(plan.deleteMetafields, [{ ownerId: changed.id, namespace: "bok", key: "tilgjengelighet" }]);
  assert.deepEqual(plan.restoreVariants, [{ productId: changed.id, variants: [{ id: changed.variants[0].id, price: "100.00" }] }]);
  assert.deepEqual(plan.restoreAlt, [{ id: changed.media[0].id, alt: "gammel alt" }]);
  assert.deepEqual(plan.newProducts.map((p) => p.handle), ["h4"]);
  assert.deepEqual(plan.deletedProducts.map((p) => p.handle).sort(), ["h2", "h3"]);
  assert.equal(plan.summary.nye, 1); assert.equal(plan.summary.slettede, 2);
});

test("metafelt som endret verdi settes tilbake, videresendinger og samlinger telles", () => {
  const before = snap([P(1)], [{ id: "r1", path: "/a", target: "/b" }], [{ id: "c1", handle: "bkg-1", title: "Bøker", ruleSet: { rules: [1] } }]);
  const after = snap([P(1, { metafields: [{ id: "m", namespace: "bok", key: "isbn", type: "id", value: "9788299999999" }] })],
    [{ id: "r2", path: "/c", target: "/d" }], [{ id: "c1", handle: "bkg-1", title: "Bøker", ruleSet: { rules: [2] } }, { id: "c2", handle: "ny", title: "Ny" }]);
  const plan = planRollback(before, after);
  assert.deepEqual(plan.restoreProducts[0].product.metafields, [{ namespace: "bok", key: "isbn", type: "id", value: "9788200000001" }]);
  assert.equal(plan.newRedirects.length, 1); assert.equal(plan.goneRedirects.length, 1);
  assert.deepEqual(plan.collections.map((c) => c.change).sort(), ["ny", "regel eller tittel endret"]);
});
