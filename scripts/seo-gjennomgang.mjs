#!/usr/bin/env node
// scripts/seo-gjennomgang.mjs — pakke G del 1: kjører den nye gjenkjenningen av gammel
// SEO-automatikk (planBookUpdate) på produkter fra et snapshot (scripts/snapshot.mjs) med
// ekte ONIX fra Bokbasen, og viser hva jobben ville gjort. Skriver ingenting til Shopify.
//
//   node scripts/seo-gjennomgang.mjs <snapshot-mappe> --sample 30        # 30 tilfeldige som ble hoppet over
//   node scripts/seo-gjennomgang.mjs <snapshot-mappe> --handles a,b,c    # bestemte produkter
//   node scripts/seo-gjennomgang.mjs <snapshot-mappe> --titles           # SEO-tittel som ikke er generert
//
// ONIX hentes med lesing mot 2.0-funksjonen bokbasen/isbn/<isbn>?raw=true (anon-nøkkel i scripts/.env.local)
// og lagres i scripts/out/onix-gjennomgang/ (git-ignorert).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./lib/clients.mjs"; // laster scripts/.env.local
import { outDir } from "./lib/clients.mjs";
import { planBookUpdate } from "../supabase/functions/_shared/book-update.ts";
import { parseSeoAuto } from "../supabase/functions/_shared/book-seo.ts";
import { PROTECTED_COLLECTION_HANDLES, setProtectedMembers } from "../supabase/functions/_shared/protected.ts";

const args = process.argv.slice(2);
const dir = args[0];
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
if (!dir) { console.error("Bruk: node scripts/seo-gjennomgang.mjs <snapshot-mappe> [--sample N | --handles a,b | --titles]"); process.exit(1); }

/** Medlemmene i de beskyttede samlingene (produkt-ID → samlingens handle), fra snapshotet. */
function protectedMembersFrom(snapshotDir) {
  const handles = new Map();
  const members = new Map();
  for (const line of readFileSync(join(snapshotDir, "collections.jsonl"), "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (!o.__parentId && o.handle && PROTECTED_COLLECTION_HANDLES.includes(o.handle)) handles.set(o.id, o.handle);
    else if (o.__parentId && handles.has(o.__parentId) && o.id.includes("/Product/")) members.set(o.id, handles.get(o.__parentId));
  }
  return members;
}
setProtectedMembers(protectedMembersFrom(dir));

function load(snapshotDir) {
  const byId = new Map();
  for (const line of readFileSync(join(snapshotDir, "products.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (!o.__parentId) { byId.set(o.id, { ...o, mf: {}, media: [] }); continue; }
    const p = byId.get(o.__parentId);
    if (!p) continue;
    if (o.id.includes("/Metafield/")) p.mf[`${o.namespace}.${o.key}`] = o.value;
    else if (o.id.includes("/MediaImage/")) p.media.push(o);
  }
  return [...byId.values()];
}

/** Produktet i den formen planBookUpdate leser (som BOOK_UPDATE_PRODUCT_FIELDS). */
function asBookProduct(p) {
  const mf = (k) => (p.mf[k] != null ? { value: p.mf[k] } : null);
  const keys = ["forfatter", "format", "sider", "utgivelsesaar", "spraak", "serie", "alder", "thema", "bokgruppe"];
  return {
    id: p.id, handle: p.handle, title: p.title, vendor: p.vendor, productType: p.productType, tags: p.tags,
    descriptionHtml: p.descriptionHtml, category: p.category,
    ...Object.fromEntries(keys.map((k) => [`mf_${k}`, mf(`bok.${k}`)])),
    seoTitleMf: mf("global.title_tag"), seoDescMf: mf("global.description_tag"), seoAuto: mf("bokadmin.seo_auto"),
    media: { nodes: p.media.slice(0, 1).map((m) => ({ id: m.id, alt: m.alt, image: m.image })) },
  };
}

async function onixFor(isbn) {
  const cacheDir = join(outDir, "onix-gjennomgang");
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${isbn}.xml`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const key = process.env.SUPABASE_ANON_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/bokbasen/isbn/${isbn}?raw=true`, { headers: { Authorization: `Bearer ${key}`, apikey: key } });
  if (!res.ok) return null;
  const xml = await res.text();
  writeFileSync(file, xml);
  return xml;
}

const products = load(dir).filter((p) => p.mf["bok.isbn"]);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
let pick;
if (opt("handles")) {
  const want = new Set(opt("handles").split(","));
  pick = products.filter((p) => want.has(p.handle));
} else if (args.includes("--titles")) {
  pick = products.filter((p) => {
    const cur = norm(p.mf["global.title_tag"]);
    const auto = parseSeoAuto(p.mf["bokadmin.seo_auto"]);
    return cur && cur !== norm(auto?.title) && cur !== norm(p.title);
  });
} else {
  // De som gammel logikk hoppet over: beskrivelse som ikke er tom og ikke lik det Bokadmin genererte
  const skipped = products.filter((p) => {
    const cur = norm(p.mf["global.description_tag"]);
    const auto = parseSeoAuto(p.mf["bokadmin.seo_auto"]);
    return cur && cur !== norm(auto?.description);
  });
  const n = Number(opt("sample") ?? 30);
  const rng = (() => { let s = 20261003; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
  pick = [...skipped].sort(() => rng() - 0.5).slice(0, n);
  console.log(`${skipped.length} produkter har en beskrivelse som ikke er lik det Bokadmin sist genererte; trekker ${pick.length}.\n`);
}

const tally = { overskrives: 0, "står (manuell)": 0, "uendret": 0, "ingen ONIX": 0 };
for (const p of pick) {
  const xml = await onixFor(p.mf["bok.isbn"]);
  if (!xml) { tally["ingen ONIX"]++; console.log(`- ${p.handle}: ingen ONIX`); continue; }
  const plan = planBookUpdate(asBookProduct(p), xml);
  const desc = plan.changes.find((c) => c.field === "seoDescription");
  const title = plan.changes.find((c) => c.field === "seoTitle");
  const noteD = plan.notes.find((n) => n.startsWith("Metabeskrivelse"));
  const noteT = plan.notes.find((n) => n.startsWith("SEO-tittel"));
  const verdict = args.includes("--titles") ? (title ? "overskrives" : noteT ? "står (manuell)" : "uendret") : (desc ? "overskrives" : noteD ? "står (manuell)" : "uendret");
  tally[verdict]++;
  console.log(`- ${p.handle}  [${verdict}]`);
  if (args.includes("--titles")) {
    console.log(`    nå:  ${p.mf["global.title_tag"]}`);
    if (title) console.log(`    ny:  ${plan.metafields.find((m) => m.key === "title_tag")?.value}`);
  } else {
    console.log(`    nå:  ${norm(p.mf["global.description_tag"]).slice(0, 140)}${norm(p.mf["global.description_tag"]).length > 140 ? "…" : ""}`);
    const nyD = plan.metafields.find((m) => m.key === "description_tag")?.value;
    if (desc) console.log(`    ny:  ${nyD}  (${nyD.length} tegn)`);
  }
}
console.log("\nSammendrag:", tally);
