#!/usr/bin/env node
// scripts/live-eksport.mjs  (pakke I del B)
// Full eksport og sikkerhetskopi av en butikk, BARE LESING. Gir et lokalt bilde som brukes
//   1) som sikkerhetskopi før piloten og overgangen,
//   2) til før/etter-sammenligning (scripts/snapshot-diff.mjs) og til tilbakerulling
//      (scripts/live-tilbakerull.mjs).
//
// Innhold (samme filformat som scripts/snapshot.mjs, så snapshot-diff leser det):
//   products.jsonl     alle produkter (aktive, utkast, arkiverte): handle, tittel, status, produkttype,
//                      leverandør, tagger, beskrivelse, kategori, SEO, varianter (pris, strekkode, SKU, lagerpolicy),
//                      ALLE metafelt (bok.*, bokadmin.*, global.*), bilder med alt-tekst, antall salgskanaler
//   collections.jsonl  alle samlinger med regler og produktene i dem
//   redirects.jsonl    alle videresendinger
//   butikk.json        butikkinfo, metafeltdefinisjoner, salgskanaler, menyer, tellinger
//   manifest.json      sha256 per fil, og kontroll av antall mot butikkens egne tellinger
//
// KJØRING (fra prosjektmappa):
//   node scripts/live-eksport.mjs                                                  # Testbutikk (øvelse)
//   node scripts/live-eksport.mjs --live --bekreft-butikk <hele domenet> [--name foer-pilot]
// Live trenger LIVE_SHOPIFY_SHOP_DOMAIN og LIVE_SHOPIFY_ACCESS_TOKEN (eller _CLIENT_ID/_CLIENT_SECRET)
// i scripts/.env.local. Skriver aldri til butikken: det eneste som sendes er lesespørringer og
// bulkOperationRunQuery (klienten avviser alle andre mutasjoner i live).
//
// Filene lagres i scripts/data/ (git-ignorert). De inneholder hele katalogen. Repoet er offentlig: aldri i git.

import { mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shopifyGql, testShop, enableLive, isLive, fail, sleep } from "./lib/clients.mjs";

globalThis.Deno ??= { env: { get: (k) => process.env[k] } };
const { SNAPSHOT_PRODUCTS_QUERY, SNAPSHOT_COLLECTIONS_QUERY, SNAPSHOT_REDIRECTS_QUERY } = await import("./lib/snapshot-queries.mjs");

const args = process.argv.slice(2);
const option = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
if (args.includes("--live")) enableLive(); // ingen mutasjoner utenom bulkOperationRunQuery
const SHOP = testShop();

const root = join(dirname(fileURLToPath(import.meta.url)), "data");
const stamp = option("name") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const dir = join(root, `${isLive() ? "live" : "test"}-eksport-${SHOP.replace(".myshopify.com", "")}-${stamp}`);
if (existsSync(dir)) fail(`${dir} finnes allerede. Bruk et annet --name.`);
mkdirSync(dir, { recursive: true });

const typeOf = (line) => (JSON.parse(line).id ?? "").split("/")[3] ?? "?";

async function bulkQuery(name, query) {
  const started = Date.now();
  process.stdout.write(`${name}: starter … `);
  for (;;) {
    const cur = (await shopifyGql(`{ currentBulkOperation(type: QUERY) { id status } }`)).currentBulkOperation;
    if (!cur || !["CREATED", "RUNNING", "CANCELING"].includes(cur.status)) break;
    process.stdout.write("(venter på pågående bulk-spørring) ");
    await sleep(10_000);
  }
  const start = (await shopifyGql(
    `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id } userErrors { message } } }`,
    { q: query },
  )).bulkOperationRunQuery;
  const id = start.bulkOperation?.id;
  if (!id) fail(`${name}: ${JSON.stringify(start.userErrors)}`);
  let op;
  for (;;) {
    await sleep(5000);
    op = (await shopifyGql(`query($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode url objectCount } } }`, { id })).node;
    if (op.status === "COMPLETED") break;
    if (!["CREATED", "RUNNING"].includes(op.status)) fail(`${name}: bulk-spørringen endte med ${op.status} (${op.errorCode ?? "ingen feilkode"}).`);
  }
  const file = join(dir, `${name}.jsonl`);
  const out = createWriteStream(file);
  const counts = {};
  const count = (l) => { out.write(l + "\n"); const t = typeOf(l); counts[t] = (counts[t] ?? 0) + 1; };
  if (op.url) {
    const res = await fetch(op.url);
    if (!res.ok) fail(`${name}: nedlasting feilet (HTTP ${res.status}).`);
    let buf = "";
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) if (l.trim()) count(l);
    }
    if (buf.trim()) count(buf);
  }
  await new Promise((r) => out.end(r));
  console.log(`${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(", ") || "tom"} (${Math.round((Date.now() - started) / 1000)} s)`);
  return { counts, file };
}

const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
console.log(`Butikk: ${SHOP}${isLive() ? "  (LIVE, bare lesing)" : "  (Testbutikk)"}\nMappe: ${dir}\n`);

// ── Små spørringer ───────────────────────────────────────────────────────────
const butikk = {};
butikk.shop = (await shopifyGql(`{ shop { name myshopifyDomain primaryDomain { url } currencyCode } }`)).shop;
butikk.tellinger = {
  produkter: (await shopifyGql(`{ productsCount(query: "status:active OR status:draft OR status:archived", limit: null) { count precision } }`)).productsCount.count,
  samlinger: (await shopifyGql(`{ collectionsCount { count } }`)).collectionsCount.count,
};
butikk.publications = (await shopifyGql(`{ publications(first: 50) { nodes { id name } } }`)).publications.nodes;
butikk.metafeltdefinisjoner = (await shopifyGql(`{ metafieldDefinitions(first: 100, ownerType: PRODUCT) { nodes {
  namespace key name description pinnedPosition metafieldsCount type { name } access { storefront }
  capabilities { adminFilterable { enabled } smartCollectionCondition { enabled } uniqueValues { enabled } } validations { name value } } } }`)).metafieldDefinitions.nodes;
try {
  butikk.menyer = (await shopifyGql(`{ menus(first: 50) { nodes { id handle title items { title type url resourceId items { title type url resourceId items { title type url resourceId } } } } } }`)).menus.nodes;
} catch (e) {
  butikk.menyer = null;
  butikk.menyerFeil = String(e.message).slice(0, 200);
}
writeFileSync(join(dir, "butikk.json"), JSON.stringify(butikk, null, 2));
console.log(`butikk.json: ${butikk.shop.name}, ${butikk.tellinger.produkter} produkter, ${butikk.tellinger.samlinger} samlinger, ${butikk.publications.length} salgskanaler, ${butikk.metafeltdefinisjoner.length} metafeltdefinisjoner`);

// ── Bulk-spørringer ──────────────────────────────────────────────────────────
const manifest = { shop: SHOP, live: isLive(), startedAt: new Date().toISOString(), files: {}, kontroll: {} };
for (const [name, q] of [["products", SNAPSHOT_PRODUCTS_QUERY], ["collections", SNAPSHOT_COLLECTIONS_QUERY], ["redirects", SNAPSHOT_REDIRECTS_QUERY]]) {
  const { counts, file } = await bulkQuery(name, q);
  manifest.files[name] = { counts, sha256: sha256(file) };
}
manifest.files.butikk = { sha256: sha256(join(dir, "butikk.json")) };

// ── Kontroll: antall i eksporten mot butikkens egne tellinger ────────────────
const got = { produkter: manifest.files.products.counts.Product ?? 0, samlinger: manifest.files.collections.counts.Collection ?? 0 };
manifest.kontroll = {
  produkterEksport: got.produkter, produkterButikk: butikk.tellinger.produkter,
  samlingerEksport: got.samlinger, samlingerButikk: butikk.tellinger.samlinger,
  ok: got.produkter === butikk.tellinger.produkter && got.samlinger === butikk.tellinger.samlinger,
};
manifest.finishedAt = new Date().toISOString();
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nKontroll: ${got.produkter}/${butikk.tellinger.produkter} produkter, ${got.samlinger}/${butikk.tellinger.samlinger} samlinger → ${manifest.kontroll.ok ? "OK" : "AVVIK (endret butikken seg underveis? kjør på nytt)"}`);
console.log(`✔ Lagret i ${dir}`);
process.exit(manifest.kontroll.ok ? 0 : 3);
