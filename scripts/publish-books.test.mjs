// node --test scripts/*.test.mjs
// Publiseringsfasen (09.10.2026): reglene i _shared/publish-books.ts og den smale mutasjonslista i shop-guard.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
import {
  decidePublish, decideUnpublish, PUBLISH_MUTATION, PUBLISH_ONLY_MUTATION, UNPUBLISH_MUTATION, UNPUBLISH_ONLY_MUTATION, toPublishProduct,
} from "../supabase/functions/_shared/publish-books.ts";
import { checkMutationAllowlist, checkWriteAllowed } from "../supabase/functions/_shared/shop-guard.js";

setProtectedMembers([]);
const ISBN = "9788203461392";
const STORE = "gid://shopify/Publication/1";
const OTHER = "gid://shopify/Publication/2";
const onix = (form, avail) => `<?xml version="1.0"?><ONIXMessage><Product><DescriptiveDetail><ProductForm>${form}</ProductForm></DescriptiveDetail><ProductSupply><SupplyDetail><ProductAvailability>${avail}</ProductAvailability></SupplyDetail></ProductSupply></Product></ONIXMessage>`;
const prod = (o = {}) => ({
  id: "gid://shopify/Product/1", title: "T", handle: "t-" + ISBN, status: "ACTIVE", vendor: "Gyldendal", productType: "Herresthal, Harald",
  tags: ["bkg-4"], publishedAt: null, bokIsbn: null, variants: { nodes: [{ barcode: ISBN, sku: ISBN }] }, publishedOn: [OTHER], ...o,
});
const input = (o = {}) => ({ expectedIsbn: ISBN, product: prod(), sameIsbnCount: 1, onixXml: onix("BC", "21"), onlineStoreId: STORE, ...o });

test("aktiv fysisk bok som mangler Online Store publiseres, uavhengig av produkttypen (røres ikke)", () => {
  assert.equal(decidePublish(input()).action, "publish");
  assert.equal(decidePublish(input({ product: prod({ productType: "Bok" }) })).action, "publish");
  assert.equal(decidePublish(input({ product: prod({ productType: "" }) })).action, "publish");
});

test("allerede publisert i Online Store: uendret", () => {
  assert.equal(decidePublish(input({ product: prod({ publishedOn: [STORE, OTHER] }) })).action, "unchanged");
});

test("utkast og arkivert publiseres aldri", () => {
  assert.equal(decidePublish(input({ product: prod({ status: "DRAFT" }) })).action, "skip");
  assert.equal(decidePublish(input({ product: prod({ status: "ARCHIVED" }) })).action, "skip");
});

test("ONIX-regelen gjør boka til utkast eller arkivert: hoppes over", () => {
  assert.match(decidePublish(input({ onixXml: onix("BC", "40") })).message, /utkast/);
  assert.match(decidePublish(input({ onixXml: onix("BC", "41") })).message, /arkivert/);
  assert.equal(decidePublish(input({ onixXml: onix("BC", "") })).action, "skip");
});

test("kommende (10–12) og midlertidig utsolgt (30–34) kan publiseres, slik regelen gir aktiv", () => {
  for (const code of ["10", "11", "12", "20", "21", "22", "23", "30", "31", "32", "33", "34"]) {
    assert.equal(decidePublish(input({ onixXml: onix("BB", code) })).action, "publish", code);
  }
});

test("ikke-fysiske bøker: lydbok, e-bok, annet", () => {
  for (const form of ["AJ", "EA", "PF", "SA", "ZZ", "PR"]) assert.equal(decidePublish(input({ onixXml: onix(form, "21") })).reason, "ikke_bok", form);
});

test("beskyttede produkter røres aldri (tagg, leverandør)", () => {
  assert.equal(decidePublish(input({ product: prod({ tags: ["lokal"] }) })).reason, "beskyttet");
  assert.equal(decidePublish(input({ product: prod({ vendor: "Wrendale Designs" }) })).reason, "beskyttet");
});

test("duplikat, ISBN som ikke stemmer, ikke i Bokbasen, uten produkt", () => {
  assert.equal(decidePublish(input({ sameIsbnCount: 2 })).reason, "duplikat");
  assert.equal(decidePublish(input({ expectedIsbn: "9788203461399" })).action, "skip");
  assert.equal(decidePublish(input({ onixXml: null })).reason, "ikke_i_bokbasen");
  assert.equal(decidePublish(input({ product: null })).action, "skip");
  assert.equal(decidePublish(input({ product: prod({ variants: { nodes: [] }, handle: "uten-isbn" }) })).reason, "ingen_isbn");
});

test("Bokbasen svarer ikke: feil (ikke «finnes ikke»), og mangler Online Store: feil", () => {
  assert.equal(decidePublish(input({ onixXml: undefined })).action, "error");
  assert.equal(decidePublish(input({ onlineStoreId: null })).action, "error");
});

test("tilbakerulling: bare det som er publisert i Online Store avpubliseres", () => {
  assert.equal(decideUnpublish(prod({ publishedOn: [STORE, OTHER] }), STORE).action, "publish");
  assert.equal(decideUnpublish(prod({ publishedOn: [OTHER] }), STORE).action, "unchanged");
  assert.equal(decideUnpublish(prod({ tags: ["gave"] }), STORE).reason, "beskyttet");
  assert.equal(decideUnpublish(null, STORE).action, "skip");
});

test("toPublishProduct leser kanalene", () => {
  const p = toPublishProduct({ id: "gid://shopify/Product/1", tags: [], resourcePublicationsV2: { nodes: [{ publication: { id: STORE } }] } });
  assert.deepEqual(p.publishedOn, [STORE]);
  assert.equal(toPublishProduct({}), null);
});

test("smal mutasjonsliste: bare publishablePublish (eller unpublish) slipper gjennom, og lesing", () => {
  assert.equal(checkMutationAllowlist({ query: PUBLISH_MUTATION, allowedOnly: [PUBLISH_ONLY_MUTATION] }).ok, true);
  assert.equal(checkMutationAllowlist({ query: UNPUBLISH_MUTATION, allowedOnly: [UNPUBLISH_ONLY_MUTATION] }).ok, true);
  assert.equal(checkMutationAllowlist({ query: UNPUBLISH_MUTATION, allowedOnly: [PUBLISH_ONLY_MUTATION] }).ok, false);
  assert.equal(checkMutationAllowlist({ query: `{ shop { name } }`, allowedOnly: [PUBLISH_ONLY_MUTATION] }).ok, true);
  for (const q of [
    `mutation { productUpdate(product: { id: "x", productType: "Bok" }) { product { id } } }`,
    `mutation { metafieldsSet(metafields: []) { userErrors { message } } }`,
    `mutation { productUpdate(product: {id: "x"}) { product { id } } publishablePublish(id: "x", input: []) { userErrors { message } } }`,
    `mutation { alias: productDelete(input: { id: "x" }) { deletedProductId } }`,
    `mutation { urlRedirectCreate(urlRedirect: { path: "/a", target: "/b" }) { userErrors { message } } }`,
    `mutation { bulkOperationRunMutation(mutation: "x", stagedUploadPath: "y") { userErrors { message } } }`,
  ]) assert.equal(checkMutationAllowlist({ query: q, allowedOnly: [PUBLISH_ONLY_MUTATION] }).ok, false, q);
  assert.equal(checkMutationAllowlist({ query: `mutation {{{`, allowedOnly: [PUBLISH_ONLY_MUTATION] }).ok, false);
});

test("skrivesperren er uendret: åpen sperre slipper alt (derfor den smale lista), på sperre avviser publisering", () => {
  assert.equal(checkWriteAllowed({ live: true, readOnly: true, query: PUBLISH_MUTATION }).ok, false);
  assert.equal(checkWriteAllowed({ live: true, readOnly: false, query: PUBLISH_MUTATION }).ok, true);
});
