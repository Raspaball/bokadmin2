#!/usr/bin/env node
// scripts/cpu-maling.mjs — pakke H del 1: måler CPU per produkt i planfasen lokalt (ingen skriving).
// Bygger en JSONL i bulk-formatet fra snapshotet, og tar tiden på hver del av planen:
//   lesing  = streamJsonlLines-lignende lesing av hele fila (slik hver bit gjør i dag)
//   parse   = BulkProductAssembler.add (JSON.parse + sammensetting)
//   onix    = planBookUpdate (ONIX-tolking + tekstsammenligning)
//   logg    = bygging av loggrader
//   node --experimental-strip-types scripts/cpu-maling.mjs <snapshot-mappe> [--n 1000]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { outDir } from "./lib/clients.mjs";
import { loadProducts } from "./out/last-snapshot.mjs";
import { BulkProductAssembler } from "../supabase/functions/_shared/book-bulk.ts";
import { planBookUpdate } from "../supabase/functions/_shared/book-update.ts";
import { setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
import { extractIsbn } from "../supabase/functions/_shared/isbn.js";

setProtectedMembers(new Map());
const dir = process.argv[2];
const n = process.argv.includes("--n") ? Number(process.argv[process.argv.indexOf("--n") + 1]) : 1000;
const products = loadProducts(dir);
const mf = (p, k) => (p.mf[k] != null ? { value: p.mf[k] } : null);
const keys = ["forfatter", "format", "sider", "utgivelsesaar", "spraak", "serie", "alder", "thema", "bokgruppe"];
const asBulk = (p) => ({
  id: p.id, handle: p.handle, title: p.title, vendor: p.vendor, productType: p.productType, tags: p.tags,
  descriptionHtml: p.descriptionHtml, category: p.category, status: p.status,
  ...Object.fromEntries(keys.map((k) => [`mf_${k}`, mf(p, `bok.${k}`)])),
  bokIsbn: mf(p, "bok.isbn"),
  seoTitleMf: mf(p, "global.title_tag"), seoDescMf: mf(p, "global.description_tag"), seoAuto: mf(p, "bokadmin.seo_auto"),
});
const jsonl = [];
for (const p of products) {
  jsonl.push(JSON.stringify(asBulk(p)));
  for (const v of p.variants.slice(0, 1)) jsonl.push(JSON.stringify({ ...v, __typename: "ProductVariant", __parentId: p.id }));
  for (const m of p.media ?? []) jsonl.push(JSON.stringify({ ...m, __typename: "MediaImage", __parentId: p.id }));
}
const text = jsonl.join("\n");
console.log(`${products.length} produkter, ${(text.length / 1e6).toFixed(1)} MB JSONL`);

// 1. Lesing av hele fila slik streamJsonlLines gjør det (indexOf + slice per linje), per bit
let t = performance.now();
let lines = 0;
{
  let rest = "";
  for (let off = 0; off < text.length; off += 65536) {
    rest += text.slice(off, off + 65536);
    let i;
    while ((i = rest.indexOf("\n")) >= 0) { lines++; rest = rest.slice(i + 1); }
  }
}
const readMs = performance.now() - t;
console.log(`lesing (kun linjedeling) av hele fila: ${readMs.toFixed(0)} ms, ${lines} linjer`);

// 2. Parse av hele fila (alle linjer JSON.parse), så hvor mye en bit på n koster
t = performance.now();
const a = new BulkProductAssembler(() => true);
for (const l of jsonl) a.add(l);
const parseAll = performance.now() - t;
console.log(`parse av alle linjer: ${parseAll.toFixed(0)} ms (${(parseAll / products.length).toFixed(3)} ms/produkt)`);
t = performance.now();
const b = new BulkProductAssembler((i) => i >= 4000 && i < 4000 + n);
for (const l of jsonl) b.add(l);
console.log(`parse med keep=${n} av ${products.length}: ${(performance.now() - t).toFixed(0)} ms`);

// 3. ONIX-tolking + plan per produkt
const cacheDir = join(outDir, "onix-gjennomgang");
let planMs = 0, logMs = 0, c = 0, bytes = 0;
for (const p of a.products.slice(4000)) {
  const isbn = extractIsbn(p);
  if (!isbn) continue;
  const f = join(cacheDir, `${isbn}.xml`);
  if (!existsSync(f)) continue;
  const xml = readFileSync(f, "utf8");
  bytes += xml.length;
  const t1 = performance.now();
  const plan = planBookUpdate(p, xml);
  const t2 = performance.now();
  planMs += t2 - t1; 
  if (++c >= n) break;
}
console.log(`planBookUpdate: ${c} bøker, ${planMs.toFixed(0)} ms (${(planMs / c).toFixed(3)} ms/bok), ONIX ${(bytes / c / 1024).toFixed(1)} KB/bok`);
