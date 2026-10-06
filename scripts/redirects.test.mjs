// node --test scripts/*.test.mjs
// Pakke H del 3b: videresending for arkiverte bøker (_shared/redirects.ts, extractReplacedBy i onix.js)
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
setProtectedMembers([]);
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseRedirectTarget, planRedirect, planRemoveRedirect, wantsRedirect } from "../supabase/functions/_shared/redirects.ts";
import { extractReplacedBy } from "../supabase/functions/_shared/onix.js";

const book = (o = {}) => ({ id: "gid://shopify/Product/1", handle: "tittel-forfatter-9788200000001", tags: [], vendor: "Gyldendal", ...o });
const COLL = new Set(["bkg-4", "bkg-41", "bkg-417"]);

test("kodene som gir videresending, og ingen for utkast (40, 42, 44) eller aktive", () => {
  for (const code of ["41", "43", "46", "47", "48", "49"]) assert.equal(wantsRedirect(book(), code, "ARCHIVED"), true, code);
  for (const code of ["40", "42", "44", "20", "", null]) assert.equal(wantsRedirect(book(), code, "DRAFT"), false, String(code));
  assert.equal(wantsRedirect(book(), "43", "ACTIVE"), false);
});

test("beskyttede får aldri videresending", () => {
  assert.equal(wantsRedirect(book({ tags: ["gave"] }), "43", "ARCHIVED"), false);
  assert.equal(wantsRedirect(book({ vendor: "Wrendale Design ltd" }), "43", "ARCHIVED"), false);
});

test("kode 41: til ny utgave når den finnes aktiv, ellers samlingen", () => {
  assert.deepEqual(chooseRedirectTarget("41", "ny-bok-forfatter-9788200000002", "417", COLL), { kind: "erstatning", target: "/products/ny-bok-forfatter-9788200000002", note: "ny utgave" });
  assert.equal(chooseRedirectTarget("41", null, "417", COLL).target, "/collections/bkg-417");
  // erstatning gjelder bare kode 41
  assert.equal(chooseRedirectTarget("43", "ny-bok", "417", COLL).target, "/collections/bkg-417");
});

test("ingen samling = ingen videresending, med årsak", () => {
  const r = chooseRedirectTarget("43", null, "999", COLL);
  assert.equal(r.kind, "ingen"); assert.equal(r.target, null); assert.match(r.note, /bkg-999/);
  assert.match(chooseRedirectTarget("43", null, "", COLL).note, /mangler bokgruppe/);
  assert.match(chooseRedirectTarget("43", null, undefined, COLL).note, /mangler bokgruppe/);
});

test("ny videresending fra handlen, og ISBN-adressen oppdateres rett til målet (ingen kjeder)", () => {
  const h = "tittel-forfatter-9788200000001";
  const ops = planRedirect(h, "9788200000001", "/collections/bkg-417", [
    { id: "gid://shopify/UrlRedirect/9", path: "/products/9788200000001", target: `/products/${h}` },
    { id: "gid://shopify/UrlRedirect/8", path: "/products/noe-helt-annet", target: "/" },
  ]);
  assert.deepEqual(ops, [
    { op: "create", path: `/products/${h}`, target: "/collections/bkg-417" },
    { op: "update", id: "gid://shopify/UrlRedirect/9", path: "/products/9788200000001", target: "/collections/bkg-417", from: `/products/${h}` },
  ]);
});

test("allerede riktig: ingenting. Feil mål på handlen: oppdateres, ikke ny oppå", () => {
  const h = "t-9788200000001";
  const ok = [{ id: "1", path: `/products/${h}`, target: "/collections/bkg-4" }, { id: "2", path: "/products/9788200000001", target: "/collections/bkg-4" }];
  assert.deepEqual(planRedirect(h, "9788200000001", "/collections/bkg-4", ok), []);
  const ops = planRedirect(h, "9788200000001", "/collections/bkg-41", ok);
  assert.deepEqual(ops.map((o) => o.op), ["update", "update"]);
  assert.equal(planRedirect(h, null, "/collections/bkg-4", []).length, 1);
});

test("aktiv igjen: handle-videresendingen slettes og ISBN-adressen peker tilbake til boka", () => {
  const h = "t-9788200000001";
  const ops = planRemoveRedirect(h, "9788200000001", [
    { id: "1", path: `/products/${h}`, target: "/collections/bkg-4" },
    { id: "2", path: "/products/9788200000001", target: "/collections/bkg-4" },
  ]);
  assert.deepEqual(ops, [
    { op: "delete", id: "1", path: `/products/${h}`, from: "/collections/bkg-4" },
    { op: "update", id: "2", path: "/products/9788200000001", target: `/products/${h}`, from: "/collections/bkg-4" },
  ]);
  assert.deepEqual(planRemoveRedirect(h, "9788200000001", [{ id: "2", path: "/products/9788200000001", target: `/products/${h}` }]), []);
});

const onix = (rel) => `<ONIXMessage xmlns="http://ns.editeur.org/onix/3.1/reference"><Product><RelatedMaterial>${rel}</RelatedMaterial></Product></ONIXMessage>`;
test("extractReplacedBy: bare relasjonskode 05 med ISBN-13", () => {
  const rp = (code, type, id) => `<RelatedProduct><ProductRelationCode>${code}</ProductRelationCode><ProductIdentifier><ProductIDType>${type}</ProductIDType><IDValue>${id}</IDValue></ProductIdentifier></RelatedProduct>`;
  assert.deepEqual(extractReplacedBy(onix(rp("05", "15", "9788200000002") + rp("03", "15", "9788200000003") + rp("05", "03", "978-82-00-00004-9") + rp("05", "15", "9788200000002"))), ["9788200000002", "9788200000049"]);
  assert.deepEqual(extractReplacedBy(onix(rp("05", "02", "8200000002"))), []);
  assert.deepEqual(extractReplacedBy("<ONIXMessage/>"), []);
});

import { bokgruppeFromTags } from "../supabase/functions/_shared/bokgruppe.ts";
test("bokgruppe fra tagger: den lengste bkg-taggen", () => {
  assert.equal(bokgruppeFromTags(["bkg-4", "bkg-41", "bkg-417", "gave"]), "417");
  assert.equal(bokgruppeFromTags(["bkg-4"]), "4");
  assert.equal(bokgruppeFromTags("bkg-4, bkg-41"), "41");
  assert.equal(bokgruppeFromTags(["Forfatter", "bkg-x"]), null);
  assert.equal(bokgruppeFromTags(undefined), null);
});
