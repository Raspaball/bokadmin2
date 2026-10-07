#!/usr/bin/env node
// scripts/snapshot.mjs — øyeblikksbilde av hele butikken (pakke F del 3.3), også brukt
// som sikkerhetskopi av Testbutikk før den tømmes. Bare lesing: tre bulk-spørringer
// (produkter med varianter, metafelt og bilder; samlinger med regler og produkter;
// videresendinger). Sammenlign to bilder med scripts/snapshot-diff.mjs.
//
// KJØRING (fra prosjektmappa):
//   node scripts/snapshot.mjs                 # → scripts/out/snapshot-<butikk>-<tid>/
//   node scripts/snapshot.mjs --name foer     # → scripts/out/snapshot-<butikk>-foer/
//
// Nøkler i scripts/.env.local: SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.
// Bare Testbutikk (SAFE_STORES): live leses aldri via API, bare fra eksportfila.

import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { fail, outDir, testShop } from "./lib/clients.mjs";

// Bulk-hjelperne i _shared bruker _shared/shopify.ts, som leser hemmelighetene med Deno.env.get
globalThis.Deno ??= { env: { get: (k) => process.env[k] } };
const { startBulkQuery, waitForBulkOperation, streamJsonlLines } = await import("../supabase/functions/_shared/shopify-bulk.ts");
const { SNAPSHOT_PRODUCTS_QUERY, SNAPSHOT_COLLECTIONS_QUERY, SNAPSHOT_REDIRECTS_QUERY } = await import("./lib/snapshot-queries.mjs");

const args = process.argv.slice(2);
const option = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const SHOP = testShop(); // bare Testbutikk: live leses aldri via API, bare fra eksportfila

const stamp = option("name") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const dir = join(outDir, `snapshot-${SHOP.replace(".myshopify.com", "")}-${stamp}`);
mkdirSync(dir, { recursive: true });

/** Kjører én bulk-spørring og skriver rå JSONL til fila. Returnerer antall linjer per type. */
async function runQuery(name, query) {
  const started = Date.now();
  process.stdout.write(`${name}: starter bulk-spørring … `);
  const id = await startBulkQuery(query);
  const op = await waitForBulkOperation(id, Date.now() + 60 * 60 * 1000, 5000);
  if (op?.status !== "COMPLETED") fail(`${name}: bulk-spørringen endte med ${op?.status} (${op?.errorCode ?? "ingen feilkode"}).`);
  const out = createWriteStream(join(dir, `${name}.jsonl`));
  const counts = {};
  if (op.url) {
    await streamJsonlLines(op.url, (line) => {
      if (!line.trim()) return;
      out.write(line + "\n");
      const gid = JSON.parse(line).id ?? "";
      const type = gid.split("/")[3] ?? "ukjent";
      counts[type] = (counts[type] ?? 0) + 1;
    });
  }
  await new Promise((r) => out.end(r));
  console.log(`${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(", ") || "tom"} (${Math.round((Date.now() - started) / 1000)} s)`);
  return counts;
}

const summary = { shop: SHOP, startedAt: new Date().toISOString(), files: {} };
summary.files.products = await runQuery("products", SNAPSHOT_PRODUCTS_QUERY);
summary.files.collections = await runQuery("collections", SNAPSHOT_COLLECTIONS_QUERY);
summary.files.redirects = await runQuery("redirects", SNAPSHOT_REDIRECTS_QUERY);
summary.finishedAt = new Date().toISOString();
writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`\n✔ Lagret i ${dir}`);
