import test from "node:test";
import assert from "node:assert/strict";
import { checkShopAllowed, SAFE_SHOPS } from "../supabase/functions/_shared/shop-guard.js";

const NOW = Date.parse("2026-11-01T08:00:00Z");
const LIVE = "bo-bok-og-papir.myshopify.com";
const inHours = (h) => new Date(NOW + h * 3600e3).toISOString();

test("Testbutikk er alltid tillatt", () => {
  assert.deepEqual(checkShopAllowed({ domain: SAFE_SHOPS[0], now: NOW }), { ok: true, live: false });
  assert.equal(checkShopAllowed({ domain: "TESTBUTIKK-9434.myshopify.com", now: NOW }).ok, true);
});
test("tomt domene stoppes", () => {
  assert.equal(checkShopAllowed({ domain: "", now: NOW }).ok, false);
  assert.equal(checkShopAllowed({ domain: undefined, now: NOW }).ok, false);
});
test("live uten bekreftelse stoppes", () => {
  const r = checkShopAllowed({ domain: LIVE, now: NOW });
  assert.equal(r.ok, false); assert.equal(r.live, true); assert.match(r.reason, /LIVE_SHOP_CONFIRMED/);
});
test("bekreftelse for en annen butikk stoppes", () => {
  assert.equal(checkShopAllowed({ domain: LIVE, confirmed: "testbutikk-9434.myshopify.com", until: inHours(2), now: NOW }).ok, false);
  assert.equal(checkShopAllowed({ domain: LIVE, confirmed: "bo-bok-og-papir", until: inHours(2), now: NOW }).ok, false);
});
test("bekreftet, men uten tidsvindu", () => {
  const r = checkShopAllowed({ domain: LIVE, confirmed: LIVE, now: NOW });
  assert.equal(r.ok, false); assert.match(r.reason, /LIVE_SHOP_UNTIL/);
  assert.equal(checkShopAllowed({ domain: LIVE, confirmed: LIVE, until: "i morgen", now: NOW }).ok, false);
});
test("utløpt vindu stoppes", () => {
  const r = checkShopAllowed({ domain: LIVE, confirmed: LIVE, until: inHours(-1), now: NOW });
  assert.equal(r.ok, false); assert.match(r.reason, /utløpt/);
});
test("vindu over 24 timer stoppes", () => {
  assert.equal(checkShopAllowed({ domain: LIVE, confirmed: LIVE, until: inHours(25), now: NOW }).ok, false);
});
test("bekreftet og innenfor vinduet er tillatt", () => {
  const r = checkShopAllowed({ domain: LIVE, confirmed: ` ${LIVE.toUpperCase()} `, until: inHours(6), now: NOW });
  assert.equal(r.ok, true); assert.equal(r.live, true); assert.equal(r.expiresAt, inHours(6));
});

// ── Skrivesperre (LIVE_READ_ONLY) ────────────────────────────────────────────
import { checkWriteAllowed, graphQLOperations, liveReadOnly } from "../supabase/functions/_shared/shop-guard.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ro = (query) => checkWriteAllowed({ live: true, readOnly: true, query });

test("skrivesperren er på som standard, av bare med nøyaktig «false»", () => {
  assert.equal(liveReadOnly(undefined), true);
  assert.equal(liveReadOnly(""), true);
  assert.equal(liveReadOnly("true"), true);
  assert.equal(liveReadOnly("nei"), true);
  assert.equal(liveReadOnly("0"), true);
  assert.equal(liveReadOnly(" FALSE "), false);
});
test("live: lesing er tillatt", () => {
  assert.equal(ro(`query { shop { name } }`).ok, true);
  assert.equal(ro(`{ productsCount { count } }`).ok, true);
  assert.equal(ro(`query P($id: ID!) { product(id: $id) { title metafield(namespace: "bok", key: "isbn") { value } } }`).ok, true);
});
test("live: bulkOperationRunQuery (lesing) er tillatt, også med strengen som variabel", () => {
  assert.equal(ro(`mutation ($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { id } userErrors { message } } }`).ok, true);
  assert.equal(ro(`mutation { bulkOperationRunQuery(query: """ { products { edges { node { id } } } } """) { bulkOperation { id } } }`).ok, true);
});
test("live: alle mutasjoner avvises", () => {
  for (const q of [
    `mutation { productUpdate(product: { id: "x", title: "y" }) { product { id } } }`,
    `mutation M($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`,
    `mutation { urlRedirectCreate(urlRedirect: { path: "/a", target: "/b" }) { urlRedirect { id } } }`,
    `mutation { publishablePublish(id: "x", input: []) { userErrors { message } } }`,
    `mutation { fileUpdate(files: []) { files { id } } }`,
    `mutation { bulkOperationRunMutation(mutation: "x", stagedUploadPath: "y") { bulkOperation { id } } }`,
    `mutation { metafieldDefinitionCreate(definition: {}) { createdDefinition { id } } }`,
    `mutation { collectionAddProductsV2(id: "x", productIds: []) { job { id } } }`,
    `mutation { tagsAdd(id: "x", tags: ["a"]) { node { id } } }`,
  ]) {
    const r = ro(q);
    assert.equal(r.ok, false, q); assert.match(r.reason, /LIVE_READ_ONLY/);
  }
});
test("live: mutasjon skjult bak alias, kommentar eller sammen med lesing avvises", () => {
  assert.equal(ro(`mutation { safe: productUpdate(product: {}) { product { id } } }`).ok, false);
  assert.equal(ro(`# query\nmutation { productDelete(input: {}) { deletedProductId } }`).ok, false);
  assert.equal(ro(`mutation { bulkOperationRunQuery(query: "x") { bulkOperation { id } } productUpdate(product: {}) { product { id } } }`).ok, false);
  assert.equal(ro(`query { shop { name } } mutation { productUpdate(product: {}) { product { id } } }`).ok, false);
  assert.equal(ro(`fragment F on Mutation { productUpdate(product: {}) { product { id } } } mutation { ...F }`).ok, false);
  assert.equal(ro(`mutation { productUpdate(product: {}) { product { id } }`).ok, false); // ubalansert
});
test("live: ord inne i strenger eller kommentarer lures ikke", () => {
  assert.equal(ro(`query { products(query: "mutation productUpdate") { edges { node { id } } } }`).ok, true);
  assert.equal(ro(`query { shop { name } } # mutation { productUpdate }`).ok, true);
});
test("Testbutikk og live med sperren av: mutasjoner slipper gjennom som før", () => {
  const q = `mutation { productUpdate(product: {}) { product { id } } }`;
  assert.equal(checkWriteAllowed({ live: false, readOnly: true, query: q }).ok, true);
  assert.equal(checkWriteAllowed({ live: true, readOnly: false, query: q }).ok, true);
});

// Alle GraphQL-strenger i Edge Functions: spørringer slipper gjennom, mutasjoner stoppes i live.
function* tsFiles(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (/\.(ts|js)$/.test(f) && !f.endsWith(".d.ts")) yield p;
  }
}
test("alle GraphQL-strenger i koden: lesing tillatt, skriving avvist (unntatt bulkOperationRunQuery)", () => {
  let reads = 0, writes = 0;
  for (const file of tsFiles(fileURLToPath(new URL("../supabase/functions", import.meta.url)))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/`\s*((?:query|mutation)\b[\s\S]*?)`/g)) {
      const q = m[1].replace(/\$\{[^}]*\}/g, "x");
      const ops = graphQLOperations(q);
      if (!ops.ok) continue; // malstreng satt sammen av deler: ikke et helt dokument
      const r = ro(q);
      const onlyBulkQuery = ops.hasMutation && ops.mutations.flat().every((f) => f === "bulkOperationRunQuery");
      if (!ops.hasMutation || onlyBulkQuery) { assert.equal(r.ok, true, `${file}: ${q.slice(0, 80)}`); reads++; }
      else { assert.equal(r.ok, false, `${file}: ${q.slice(0, 80)}`); writes++; }
    }
  }
  assert.ok(reads > 20 && writes > 20, `fant ${reads} lesinger og ${writes} skrivinger`);
  console.log(`  GraphQL i koden: ${reads} lesinger tillatt, ${writes} mutasjoner avvist i live`);
});

// ── Butikkstempel på jobber ──────────────────────────────────────────────────
import { jobShopMismatch } from "../supabase/functions/_shared/shop-guard.js";
test("jobb: samme butikk fortsetter", () => {
  assert.equal(jobShopMismatch(SAFE_SHOPS[0], SAFE_SHOPS[0]), null);
  assert.equal(jobShopMismatch(" TESTBUTIKK-9434.myshopify.com", SAFE_SHOPS[0]), null);
});
test("jobb: byttet butikk stoppes", () => {
  assert.match(jobShopMismatch(SAFE_SHOPS[0], LIVE), /byttet/);
  assert.match(jobShopMismatch(LIVE, SAFE_SHOPS[0]), /byttet/);
});
test("jobb uten stempel eller uten aktiv butikk stoppes", () => {
  assert.match(jobShopMismatch(null, SAFE_SHOPS[0]), /mangler butikkstempel/);
  assert.match(jobShopMismatch("", LIVE), /mangler butikkstempel/);
  assert.match(jobShopMismatch(SAFE_SHOPS[0], ""), /ikke satt/);
});
test("alle steder som lager en jobb, stempler butikken, og alle pulser sjekker den", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (f) => readFileSync(new URL(`../supabase/functions/${f}/index.ts`, import.meta.url), "utf8");
  for (const f of ["availability-check", "price-update", "book-update", "sjangre-sync", "shopify"]) {
    const src = read(f);
    const inserts = [...src.matchAll(/from\("jobs"\)\s*\.insert\(|restJson\("jobs", \{\s*method: "POST"/g)].length;
    const stamps = [...src.matchAll(/shop_domain: currentShopDomain\(\)/g)].length;
    assert.ok(inserts > 0, f);
    assert.equal(stamps, inserts, `${f}: ${inserts} jobber lages, ${stamps} stemples`);
  }
  for (const [f, n] of [["availability-check", 1], ["price-update", 1], ["book-update", 2], ["sjangre-sync", 2]]) {
    assert.equal([...read(f).matchAll(/stopIfShopChanged\(supabase, job\)/g)].length, n, f);
  }
  assert.equal([...read("shopify").matchAll(/jobShopError\(job\)/g)].length, 3);
});
