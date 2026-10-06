#!/usr/bin/env node
// scripts/kanaler-rapport.mjs — pakke H del 2.3: hvor mange aktive bøker i Testbutikk ligger ikke på
// alle salgskanaler. Bare lesing (én bulk-spørring + publications). Samme regel som jobbene
// (channelsToPublish i _shared/publish.ts); produkttypen fra Shopify erstatter ONIX-formatet her.
//   node --experimental-strip-types scripts/kanaler-rapport.mjs
// Utdata: scripts/out/kanaler-mangler.csv + sammendrag i terminalen.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, outDir, shopifyGql, testShop } from "./lib/clients.mjs";

globalThis.Deno ??= { env: { get: (k) => process.env[k] } };
const { startBulkQuery, waitForBulkOperation, streamJsonlLines } = await import("../supabase/functions/_shared/shopify-bulk.ts");
const { PUBLISHED_ON_BULK_FIELD, channelsToPublish } = await import("../supabase/functions/_shared/publish.ts");
const { loadProtectedMembers, protectedProduct } = await import("../supabase/functions/_shared/protected.ts");
const { BulkProductAssembler } = await import("../supabase/functions/_shared/book-bulk.ts");

const SHOP = testShop();
await loadProtectedMembers(shopifyGql).catch((e) => fail(e.message));
const pubs = (await shopifyGql(`{ publications(first: 25) { edges { node { id name } } } }`)).publications.edges.map((e) => e.node);
const ALL = pubs.map((p) => p.id);
console.log(`Kanaler: ${pubs.map((p) => p.name).join(", ")}`);

const QUERY = `{ products(query: "status:active OR status:draft OR status:archived") { edges { node {
  __typename id handle title status vendor productType tags
  ${PUBLISHED_ON_BULK_FIELD}
} } } }`;
const id = await startBulkQuery(QUERY);
const op = await waitForBulkOperation(id, Date.now() + 60 * 60 * 1000, 5000);
if (op?.status !== "COMPLETED") fail(`Bulk-spørringen endte med ${op?.status} (${op?.errorCode ?? "ingen feilkode"})`);
const a = new BulkProductAssembler(() => true, ["id", "handle", "title", "status", "vendor", "productType", "tags"]);
if (op.url) await streamJsonlLines(op.url, (l) => a.add(l));

const r = { produkter: a.products.length, aktive: 0, beskyttet: 0, ikkeBok: 0, paaAlle: 0, mangler: 0, kanalerManglerTotalt: 0 };
const perKanal = Object.fromEntries(pubs.map((p) => [p.name, 0]));
const rows = [];
for (const p of a.products) {
  if (p.status !== "ACTIVE") continue;
  r.aktive++;
  if (protectedProduct(p)) { r.beskyttet++; continue; }
  if (p.productType && p.productType !== "Bok") { r.ikkeBok++; continue; }
  const missing = channelsToPublish(ALL, p, "Bok", true);
  if (!missing.length) { r.paaAlle++; continue; }
  r.mangler++; r.kanalerManglerTotalt += missing.length;
  for (const m of missing) perKanal[pubs.find((x) => x.id === m).name]++;
  rows.push([p.handle, p.title, p.productType ?? "", missing.map((m) => pubs.find((x) => x.id === m).name).join(" + ")]);
}
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
writeFileSync(join(outDir, "kanaler-mangler.csv"), "﻿" + ["Handle;Tittel;Produkttype;Mangler kanaler", ...rows.map((x) => x.map(q).join(";"))].join("\n") + "\n", "utf8");
console.log(`\n${SHOP}`, r, "\nMangler per kanal:", perKanal, `\n→ ${join(outDir, "kanaler-mangler.csv")}`);
console.log("Eksempler:", rows.slice(0, 10).map((x) => `${x[0]} (${x[3]})`));
