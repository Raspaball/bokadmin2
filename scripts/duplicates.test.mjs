// node --test scripts/*.test.mjs
// Duplikater: samme ISBN på flere produkter (pakke D del 3b, _shared/duplicates.ts).
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
// Ingen produkter i beskyttede samlinger her (medlemskap testes i protected.test.mjs)
setProtectedMembers([]);
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addToScan, decideDuplicate, duplicateCounts, duplicateMessage, emptyDuplicateScan, groupDuplicates, runDuplicateScan, tagsToMerge,
} from "../supabase/functions/_shared/duplicates.ts";

// Mønsteret fra live: eldre produkt med tittel-handle og tema-tagger, og ett fra gamle Bokadmin
const old = {
  id: "gid://shopify/Product/1", handle: "tenke-fort-og-langsomt", title: "Tenke, fort og langsomt", status: "ACTIVE",
  createdAt: "2019-03-01T10:00:00Z", productType: "Kahneman, Daniel", tags: ["Faglitteratur", "kognitiv psykologi", "sakpr"],
  forfatter: [], orders: null, variants: { nodes: [{ barcode: "9788253036465", sku: null }] },
};
const fromBokadmin = {
  id: "gid://shopify/Product/2", handle: "9788253036465", title: "Tenke, fort og langsomt", status: "ACTIVE",
  createdAt: "2025-11-20T10:00:00Z", productType: "Kahneman, Daniel", tags: ["bkg-5", "bkg-50", "bkg-503", "Daniel", "fort og langsomt", "Kahneman", "Tenke", "Bokhandlerens favoritt"],
  forfatter: ["Daniel Kahneman"], orders: null, variants: { nodes: [{ barcode: "9788253036465", sku: "9788253036465" }] },
};
const single = { ...old, id: "gid://shopify/Product/3", handle: "annen", variants: { nodes: [{ barcode: "9788203461392" }] } };

test("grupperer bare ISBN med flere produkter (også ISBN bare i handle)", () => {
  const handleOnly = { ...fromBokadmin, id: "gid://shopify/Product/4", variants: { nodes: [{ barcode: null, sku: null }] } };
  const g = groupDuplicates([old, fromBokadmin, single, handleOnly]);
  assert.equal(g.length, 1);
  assert.equal(g[0].isbn, "9788253036465");
  assert.equal(g[0].products.length, 3);
});

test("regel: ordrer ukjent → behold det eldste", () => {
  const d = decideDuplicate([fromBokadmin, old]);
  assert.equal(d.keepId, old.id);
  assert.deepEqual(d.deleteIds, [fromBokadmin.id]);
  assert.ok(d.automatic);
  assert.ok(d.flags.includes("ordrer ukjent"));
  assert.ok(d.flags.includes("flere er aktive"));
});

test("regel: produktet med ordrer beholdes, også om det er yngst", () => {
  const d = decideDuplicate([{ ...old, orders: 0 }, { ...fromBokadmin, orders: 3 }]);
  assert.equal(d.keepId, fromBokadmin.id);
  assert.equal(d.reason, "har ordrer (3)");
  const both = decideDuplicate([{ ...old, orders: 5 }, { ...fromBokadmin, orders: 3 }]);
  assert.equal(both.keepId, old.id);
  assert.ok(both.flags.includes("flere har ordrer"));
  assert.equal(decideDuplicate([{ ...old, orders: 0 }, { ...fromBokadmin, orders: 0 }]).keepId, old.id);
});

test("regel: uten dato og ordrer (CSV) avgjør Eirik", () => {
  const d = decideDuplicate([{ ...old, createdAt: null }, { ...fromBokadmin, createdAt: null }]);
  assert.equal(d.keepId, null);
  assert.equal(d.automatic, false);
});

test("beskyttet produkt i gruppen: ingenting gjøres automatisk", () => {
  const d = decideDuplicate([{ ...old, tags: [...old.tags, "Lokalhistorie"] }, fromBokadmin]);
  assert.equal(d.automatic, false);
  assert.equal(d.keepId, null);
  assert.deepEqual(d.deleteIds, []);
  assert.match(d.reason, /beskyttet \(tagg: Lokalhistorie\)/);
});

test("sammenslåing: bkg-* og egne tagger, ikke tittel/forfatterbiter eller beskyttede", () => {
  assert.deepEqual(tagsToMerge(old, fromBokadmin), ["bkg-5", "bkg-50", "bkg-503", "Bokhandlerens favoritt"]);
  assert.deepEqual(tagsToMerge(old, { ...fromBokadmin, tags: ["sakpr", "SAKPR", "bkg-5"] }), ["bkg-5"]);
  assert.deepEqual(tagsToMerge(old, { ...fromBokadmin, tags: ["gave", "bkg-5"] }), ["bkg-5"]);
});

test("skanning over flere sider, og duplikatlisten", () => {
  const s = emptyDuplicateScan();
  addToScan(s, [old, single], "c1", true);
  assert.equal(s.done, false);
  addToScan(s, [fromBokadmin], null, false);
  assert.equal(s.done, true);
  assert.deepEqual(duplicateCounts(s.counts), { "9788253036465": 2 });
  assert.equal(duplicateMessage(2), "Hoppet over: DUPLIKAT (samme ISBN på 2 produkter)");
});

test("runDuplicateScan blar til siste side", async () => {
  const pages = [
    { nodes: [old], pageInfo: { hasNextPage: true, endCursor: "a" } },
    { nodes: [fromBokadmin, single], pageInfo: { hasNextPage: false, endCursor: "b" } },
  ];
  const seen = [];
  const gql = async (_q, v) => { seen.push(v.after); return { data: { products: pages[seen.length - 1] } }; };
  const s = emptyDuplicateScan();
  await runDuplicateScan(gql, s, Date.now() + 10_000);
  assert.deepEqual(seen, [null, "a"]);
  assert.deepEqual(duplicateCounts(s.counts), { "9788253036465": 2 });
});

test("alle jobber og push hopper over duplikater", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["book-update", "price-update", "availability-check", "sjangre-sync", "shopify"]) {
    const src = readFileSync(new URL(`../supabase/functions/${f}/index.ts`, import.meta.url), "utf8");
    assert.match(src, /duplicateMessage\(/, f);
  }
  for (const f of ["price-update", "availability-check", "sjangre-sync", "book-update"]) {
    const src = readFileSync(new URL(`../supabase/functions/${f}/index.ts`, import.meta.url), "utf8");
    assert.match(src, /ensureDuplicates\(/, f);
  }
});

test("ordrer per produkt fra bulk-fila: én per ordre og produkt", async () => {
  const { OrderCounter } = await import("../supabase/functions/_shared/duplicates.ts");
  const c = new OrderCounter();
  const lines = [
    { id: "gid://shopify/Order/1" },
    { product: { id: "P1" }, __parentId: "gid://shopify/Order/1" },
    { product: { id: "P1" }, __parentId: "gid://shopify/Order/1" }, // samme bok to ganger i ordren
    { product: { id: "P2" }, __parentId: "gid://shopify/Order/1" },
    { id: "gid://shopify/Order/2" },
    { product: { id: "P1" }, __parentId: "gid://shopify/Order/2" },
    { product: null, __parentId: "gid://shopify/Order/2" }, // slettet produkt / egendefinert linje
  ];
  for (const l of lines) c.add(JSON.stringify(l));
  c.add("");
  assert.deepEqual(Object.fromEntries(c.counts), { P1: 2, P2: 1 });
});

test("ordretilgang og tydelig melding", async () => {
  const { orderAccess, orderAccessWarning } = await import("../supabase/functions/_shared/duplicates.ts");
  assert.equal(orderAccess(["read_products"]), "ingen");
  assert.equal(orderAccess(["read_products", "read_orders"]), "60 dager");
  assert.equal(orderAccess(["read_orders", "read_all_orders"]), "alle");
  assert.match(orderAccessWarning("ingen"), /mangler read_orders/);
  assert.match(orderAccessWarning("60 dager"), /siste 60 dagene/);
  assert.equal(orderAccessWarning("alle"), null);
});

test("regel med ordre-tilgang: 60 dager merkes i beslutningen", () => {
  const d = decideDuplicate([{ ...old, orders: 0 }, { ...fromBokadmin, orders: 0 }], "60 dager");
  assert.equal(d.keepId, old.id);
  assert.ok(d.flags.includes("ordrer bare siste 60 dager"));
  assert.equal(decideDuplicate([{ ...old, orders: 0 }, { ...fromBokadmin, orders: 2 }], "alle").keepId, fromBokadmin.id);
});
