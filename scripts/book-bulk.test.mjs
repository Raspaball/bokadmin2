// node --test scripts/*.test.mjs
// Bulk-modus for «Oppdater eksisterende bøker» (pakke D del 3, _shared/book-bulk.ts).
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
// Ingen produkter i beskyttede samlinger her (medlemskap testes i protected.test.mjs)
setProtectedMembers([]);
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BULK_PRODUCTS_QUERY, BulkProductAssembler, assembleBulkProducts, bulkCoverLine, bulkUpdateLine, parseBulkResult, toJsonl,
} from "../supabase/functions/_shared/book-bulk.ts";
import { BOOK_METAFIELD_KEYS, BOOK_UPDATE_PRODUCT_FIELDS, planBookUpdate } from "../supabase/functions/_shared/book-update.ts";
import { extractIsbn } from "../supabase/functions/_shared/isbn.js";

const onix = `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference"><Product>
<DescriptiveDetail><ProductForm>BB</ProductForm>
<TitleDetail><TitleType>01</TitleType><TitleElement><TitleElementLevel>01</TitleElementLevel><TitleText>Avkledd</TitleText><Subtitle>den syke historien</Subtitle></TitleElement></TitleDetail>
<Contributor><SequenceNumber>1</SequenceNumber><ContributorRole>A01</ContributorRole><PersonNameInverted>Brochmann, Nina</PersonNameInverted></Contributor>
<Language><LanguageRole>01</LanguageRole><LanguageCode>nob</LanguageCode></Language>
<Extent><ExtentType>00</ExtentType><ExtentValue>288</ExtentValue><ExtentUnit>03</ExtentUnit></Extent></DescriptiveDetail>
<CollateralDetail><TextContent><TextType>03</TextType><Text>Første avsnitt.</Text></TextContent></CollateralDetail>
<PublishingDetail><Publisher><PublisherName>Gyldendal</PublisherName></Publisher><PublishingDate><PublishingDateRole>01</PublishingDateRole><Date dateformat="05">2026</Date></PublishingDate></PublishingDetail>
</Product></ONIXMessage>`;

// Slik bulkOperationRunQuery skriver fila: produktet, så barna med __parentId
const P1 = "gid://shopify/Product/1", P2 = "gid://shopify/Product/2", P3 = "gid://shopify/Product/3";
const jsonl = [
  { __typename: "Product", id: P1, handle: "9788203461392", title: "Avkledd: den syke historien", productType: "Brochmann, Nina", tags: ["Avkledd: den syke historien", "Brochmann", "Nina"], descriptionHtml: "", category: null, mf_forfatter: null, bokIsbn: null, seoTitleMf: null, seoDescMf: null, seoAuto: null },
  { __typename: "MediaImage", id: "gid://shopify/MediaImage/9", alt: "", image: { url: "https://cdn.shopify.com/s/files/1/x/files/jpeg_84.jpg?v=1" }, __parentId: P1 },
  { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/11", barcode: "9788203461392", sku: "9788203461392", __parentId: P1 },
  { __typename: "Product", id: P2, handle: "det-hende-i-telemark-8", title: "Det hende i Telemark 8", productType: "", tags: ["Lokallitteratur"], descriptionHtml: "<p>x</p>", category: null, bokIsbn: null },
  { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/21", barcode: "9788269368024", sku: null, __parentId: P2 },
  { __typename: "Product", id: P3, handle: "gavekort", title: "Gavekort", productType: "", tags: [], descriptionHtml: "", category: null, bokIsbn: null },
  { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/31", barcode: null, sku: "GK", __parentId: P3 },
].map((o) => JSON.stringify(o)).join("\n") + "\n";

test("bulk-spørringen har de samme feltene som side-for-side-jobben", () => {
  for (const k of BOOK_METAFIELD_KEYS) assert.match(BULK_PRODUCTS_QUERY, new RegExp(`mf_${k}: metafield\\(namespace: "bok", key: "${k}"\\)`));
  for (const f of ["seoTitleMf", "seoDescMf", "seoAuto", "bokIsbn", "descriptionHtml", "category { id }", "tags"]) assert.ok(BULK_PRODUCTS_QUERY.includes(f), f);
  assert.ok(BOOK_UPDATE_PRODUCT_FIELDS.includes("seoAuto"));
  assert.match(BULK_PRODUCTS_QUERY, /status:active OR status:draft OR status:archived/);
  assert.match(BULK_PRODUCTS_QUERY, /media\(first: 1\) \{ edges \{ node/);
});

test("produkter settes sammen med media og variant i samme form som jobben leser", () => {
  const ps = assembleBulkProducts(jsonl);
  assert.equal(ps.length, 3);
  assert.equal(ps[0].media.nodes[0].id, "gid://shopify/MediaImage/9");
  assert.equal(ps[0].variants.nodes[0].barcode, "9788203461392");
  assert.equal(extractIsbn(ps[0]), "9788203461392");
  assert.equal(extractIsbn(ps[1]), "9788269368024");
  assert.equal(extractIsbn(ps[2]), null);
  assert.equal(ps[0].__typename, undefined);
});

test("bare en del av katalogen holdes i minnet, og slim dropper tunge felt", () => {
  const a = new BulkProductAssembler((i) => i === 1);
  for (const l of jsonl.split("\n")) a.add(l);
  assert.equal(a.count, 3);
  assert.deepEqual(a.products.map((p) => p.id), [P2]);
  const s = new BulkProductAssembler(() => true, true);
  for (const l of jsonl.split("\n")) s.add(l);
  assert.equal(s.products[1].descriptionHtml, undefined);
  assert.deepEqual(s.products[1].tags, ["Lokallitteratur"]);
  assert.equal(s.products[0].media.nodes.length, 0);
  assert.equal(extractIsbn(s.products[0]), "9788203461392");
});

test("JSONL-linje: produktfelt og metafelt i én productUpdate, uten ownerId", () => {
  const [p] = assembleBulkProducts(jsonl);
  const plan = planBookUpdate(p, onix);
  const line = bulkUpdateLine(p, plan);
  assert.equal(line.product.id, P1);
  assert.equal(line.product.productType, "Bok");
  assert.ok(Array.isArray(line.product.tags) && !line.product.tags.includes("Brochmann"));
  assert.ok(line.product.metafields.length >= 5);
  for (const m of line.product.metafields) {
    assert.equal(m.ownerId, undefined);
    assert.ok(m.namespace && m.key && m.type && typeof m.value === "string", JSON.stringify(m));
  }
  assert.ok(line.product.metafields.some((m) => m.namespace === "global" && m.key === "title_tag"));
  // pris, status, handle og tittel sendes aldri
  for (const k of ["handle", "title", "status", "variants"]) assert.equal(line.product[k], undefined, k);
  const cover = bulkCoverLine(p, plan);
  assert.deepEqual(Object.keys(cover.files[0]).sort(), ["alt", "filename", "id"]);
  assert.equal(cover.files[0].id, "gid://shopify/MediaImage/9");
  assert.equal(JSON.parse(toJsonl([line, line]).split("\n")[1]).product.id, P1);
});

test("beskyttede produkter gir aldri en linje", () => {
  const ps = assembleBulkProducts(jsonl);
  const fakePlan = { product: { productType: "Bok" }, metafields: [{ ownerId: P2, namespace: "bok", key: "format", type: "single_line_text_field", value: "x" }], cover: { mediaId: "m", change: { alt: "a" } }, changes: [{ field: "productType", from: "", to: "Bok" }], notes: [] };
  assert.equal(bulkUpdateLine(ps[1], fakePlan), null);
  assert.equal(bulkCoverLine(ps[1], fakePlan), null);
  assert.deepEqual(planBookUpdate(ps[1], onix).changes, []);
});

test("ingen endring: ingen linje", () => {
  assert.equal(bulkUpdateLine({ id: P1, tags: [] }, { product: {}, metafields: [], metafieldDeletes: [], cover: null, changes: [], notes: [] }), null);
  assert.equal(bulkCoverLine({ tags: [] }, { product: {}, metafields: [], metafieldDeletes: [], cover: null, changes: [], notes: [] }), null);
});

test("resultatfila: ok, userErrors og GraphQL-feil per linje", () => {
  const text = [
    { data: { productUpdate: { product: { id: P1 }, userErrors: [] } }, __lineNumber: 0 },
    { data: { productUpdate: { product: null, userErrors: [{ field: ["metafields"], message: "Value is invalid" }] } }, __lineNumber: 1 },
    { errors: [{ message: "Throttled" }], __lineNumber: 2 },
  ].map((o) => JSON.stringify(o)).join("\n");
  assert.deepEqual(parseBulkResult(text, "productUpdate"), [
    { line: 0, ok: true },
    { line: 1, ok: false, error: "Value is invalid" },
    { line: 2, ok: false, error: "Throttled" },
  ]);
  assert.deepEqual(parseBulkResult(JSON.stringify({ data: { fileUpdate: { files: [], userErrors: [{ message: "File id does not exist." }] } }, __lineNumber: 0 }), "fileUpdate"),
    [{ line: 0, ok: false, error: "File id does not exist." }]);
  assert.deepEqual(parseBulkResult("", "productUpdate"), []);
});
