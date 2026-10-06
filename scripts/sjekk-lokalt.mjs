#!/usr/bin/env node
// scripts/sjekk-lokalt.mjs — pakke G: sjekkmodus for «Oppdater eksisterende bøker» og
// tilgjengelighetsjobben, kjørt lokalt mot et snapshot (scripts/snapshot.mjs) med ekte ONIX
// fra Bokbasen. Bruker de samme reglene som Edge Function-jobbene (planBookUpdate,
// planAvailability), men SKRIVER ALDRI til Shopify eller Supabase. Gir sammendrag per felt.
//
//   node --experimental-strip-types scripts/sjekk-lokalt.mjs <snapshot-mappe> [--limit N]
//
// ONIX hentes (bare lesing) med bokbasen/isbn/<isbn>?raw=true og lagres i
// scripts/out/onix-gjennomgang/ (git-ignorert), så en ny kjøring går raskt.
// Utdata: scripts/out/sjekk-lokalt-<dato>.json, institusjoner-<dato>.csv og statusendringer-lokalt-<dato>.csv.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./lib/clients.mjs"; // laster scripts/.env.local
import { outDir } from "./lib/clients.mjs";
import { countPlan, emptyBookUpdateCounts, planBookUpdate, summarizeBookUpdate } from "../supabase/functions/_shared/book-update.ts";
import { availabilityRule, planAvailability } from "../supabase/functions/_shared/availability.ts";
import { notBookSkip } from "../supabase/functions/_shared/book-format.ts";
import { institutionsCsv } from "../supabase/functions/_shared/contributors.js";
import { extractAvailabilityCode, extractDescription, resolvePublication } from "../supabase/functions/_shared/onix.js";
import { extractIsbn } from "../supabase/functions/_shared/isbn.js";
import { PROTECTED_COLLECTION_HANDLES, protectedProduct, setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
import { SEO_DESCRIPTION_MAX, bodyWithoutTitle, plainOneLine } from "../supabase/functions/_shared/book-seo.ts";

const args = process.argv.slice(2);
const dir = args[0];
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
if (!dir) { console.error("Bruk: node --experimental-strip-types scripts/sjekk-lokalt.mjs <snapshot-mappe> [--limit N]"); process.exit(1); }
const lines = (file) => readFileSync(join(dir, file), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

// Beskyttede samlinger fra snapshotet
{
  const handles = new Map(), members = new Map();
  for (const o of lines("collections.jsonl")) {
    if (!o.__parentId && o.handle && PROTECTED_COLLECTION_HANDLES.includes(o.handle)) handles.set(o.id, o.handle);
    else if (o.__parentId && handles.has(o.__parentId) && o.id.includes("/Product/")) members.set(o.id, handles.get(o.__parentId));
  }
  setProtectedMembers(members);
}

const byId = new Map();
for (const o of lines("products.jsonl")) {
  if (!o.__parentId) { byId.set(o.id, { ...o, mf: {}, media: [], variants: [] }); continue; }
  const p = byId.get(o.__parentId);
  if (!p) continue;
  if (o.id.includes("/Metafield/")) p.mf[`${o.namespace}.${o.key}`] = o.value;
  else if (o.id.includes("/MediaImage/")) p.media.push(o);
  else if (o.id.includes("/ProductVariant/")) p.variants.push(o);
}
const products = [...byId.values()];
const mf = (p, k) => (p.mf[k] != null ? { value: p.mf[k] } : null);
const bookKeys = ["forfatter", "format", "sider", "utgivelsesaar", "spraak", "serie", "alder", "thema", "bokgruppe"];
const asBookProduct = (p) => ({
  id: p.id, handle: p.handle, title: p.title, vendor: p.vendor, productType: p.productType, tags: p.tags,
  descriptionHtml: p.descriptionHtml, category: p.category,
  ...Object.fromEntries(bookKeys.map((k) => [`mf_${k}`, mf(p, `bok.${k}`)])),
  seoTitleMf: mf(p, "global.title_tag"), seoDescMf: mf(p, "global.description_tag"), seoAuto: mf(p, "bokadmin.seo_auto"),
  media: { nodes: p.media.slice(0, 1).map((m) => ({ id: m.id, alt: m.alt, image: m.image })) },
});
const isbnOf = (p) => extractIsbn({ handle: p.handle, bokIsbn: mf(p, "bok.isbn"), variants: { nodes: p.variants.slice(0, 1) } });

// Duplikater (samme ISBN på flere produkter) hoppes over, som i jobbene
const isbnCount = new Map();
for (const p of products) { const i = isbnOf(p); if (i) isbnCount.set(i, (isbnCount.get(i) ?? 0) + 1); }

const cacheDir = join(outDir, "onix-gjennomgang");
mkdirSync(cacheDir, { recursive: true });
async function onixFor(isbn, attempt = 0) {
  const file = join(cacheDir, `${isbn}.xml`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const key = process.env.SUPABASE_ANON_KEY;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/bokbasen/isbn/${isbn}?raw=true`, { headers: { Authorization: `Bearer ${key}`, apikey: key } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    writeFileSync(file, xml);
    return xml;
  } catch (e) {
    if (attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); return onixFor(isbn, attempt + 1); }
    return null;
  }
}

// ── Kjøring ──────────────────────────────────────────────────────────────────
const counts = emptyBookUpdateCounts();
const av = { changed: 0, unchanged: 0, untrack: 0, untrackWithStock: 0, ownAvailability: 0, statusChanges: [], skipped: { beskyttet: 0, duplikat: 0, arkivert: 0, ingenIsbn: 0, ingenOnix: 0, ikkeBok: 0 } };
const seo = { desc: 0, descOverLimit: 0, descHtml: 0, titleTags: 0, overwrittenKjop: 0 };
const utenBeskrivelse = []; // pakke H del 3: bøker uten forlagstekst i ONIX
const extra = { forfatterSlettet: 0, formatAnnetSlettet: 0, aarEndret: 0, aarEksempler: [] };
const work = [];
for (const p of products) {
  if (work.length >= limit) break;
  const isbn = isbnOf(p);
  if (protectedProduct(p)) { counts.skippedProtected++; av.skipped.beskyttet++; continue; }
  if (!isbn) { counts.skippedNoIsbn++; av.skipped.ingenIsbn++; continue; }
  if ((isbnCount.get(isbn) ?? 0) > 1) { counts.skippedDuplicate++; av.skipped.duplikat++; continue; }
  work.push({ p, isbn });
}
console.log(`${products.length} produkter; ${work.length} skal sjekkes (ONIX hentes eller leses fra cache) …`);

/** Starter forlagsteksten med tittelen (som da fjernes fra metabeskrivelsen)? */
function dsc0(p, xml) {
  const body = plainOneLine(extractDescription(xml));
  return !!body && bodyWithoutTitle(body, [p.title]).toLocaleLowerCase("nb") !== body.toLocaleLowerCase("nb");
}
const pubRules = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, flereProdukter: 0 };
const pubCheck = [];
const descExamples = [];
const strippedExamples = [];
let strippedCount = 0;
let seenDesc = 0;
let done = 0;
async function handle({ p, isbn }) {
  const xml = await onixFor(isbn);
  if (!xml) { counts.skippedNoOnix++; av.skipped.ingenOnix++; return; }
  if (notBookSkip(xml)) { counts.skippedNotBook++; av.skipped.ikkeBok++; return; }
  // Bokdata
  const plan = planBookUpdate(asBookProduct(p), xml);
  countPlan(counts, p.handle, plan, isbn);
  if (!extractDescription(xml)?.trim()) {
    const cur = String(p.descriptionHtml ?? "").replace(/<[^>]+>/g, "").trim();
    const wrote = plan.changes.some((c) => c.field === "description");
    utenBeskrivelse.push({ handle: p.handle, title: p.title, isbn, status: p.status, shopify: !cur ? "tom" : wrote ? "generert tekst (byttes)" : "har tekst (beholdes)", handling: wrote ? "faktatekst skrives" : "ingen endring", ny: wrote ? plan.product.descriptionHtml : "" });
  }
  const d = plan.metafields.find((m) => m.key === "description_tag");
  if (d) {
    seo.desc++;
    if (d.value.length > SEO_DESCRIPTION_MAX) seo.descOverLimit++;
    if (/[<>]/.test(d.value)) seo.descHtml++;
    if (/^Kjøp .* hos Bø bok og papir/i.test(p.mf["global.description_tag"] ?? "")) seo.overwrittenKjop++;
  }
  if (plan.metafieldDeletes.some((x) => x.key === "forfatter")) extra.forfatterSlettet++;
  if (plan.metafieldDeletes.some((x) => x.key === "format")) extra.formatAnnetSlettet++;
  // Utgivelsesår og -dato (pakke H): regelfordeling og kontrolliste
  const pub = resolvePublication(xml);
  pubRules[pub.rule]++;
  if (pub.products > 1) pubRules.flereProdukter++;
  if (pub.check) {
    pubCheck.push({ title: p.title, isbn, handle: p.handle, year01: pub.role01Year, date11: pub.role11Date, products: pub.products, shopifyYear: p.mf["bok.utgivelsesaar"] ?? "", shopifyDate: p.mf["bok.utgivelsesdato"] ?? "", chosen: pub.year });
  }
  if (dsc0(p, xml)) { strippedCount++; if (strippedExamples.length < 40) strippedExamples.push({ handle: p.handle, from: p.mf["global.description_tag"] ?? "", to: plan.metafields.find((m) => m.key === "description_tag")?.value ?? "" }); }
  const dsc = plan.metafields.find((m) => m.key === "description_tag");
  if (dsc) { seenDesc++; if (descExamples.length < 5) descExamples.push({ handle: p.handle, from: p.mf["global.description_tag"] ?? "", to: dsc.value }); else { const j = Math.floor(Math.random() * seenDesc); if (j < 5) descExamples[j] = { handle: p.handle, from: p.mf["global.description_tag"] ?? "", to: dsc.value }; } }
  const year = plan.changes.find((c) => c.field === "bok.utgivelsesaar");
  if (year) { extra.aarEndret++; if (extra.aarEksempler.length < 5) extra.aarEksempler.push(`${p.handle}: ${year.from} → ${year.to}`); }
  // Tilgjengelighet (arkiverte hoppes over, som i jobben)
  if (p.status === "ARCHIVED") { av.skipped.arkivert++; return; }
  const rule = availabilityRule(extractAvailabilityCode(xml));
  const date = pub.date;
  const v = p.variants[0];
  const ap = planAvailability({
    status: p.status, tilgjengelighet: mf(p, "bok.tilgjengelighet"), utgivelsesdato: mf(p, "bok.utgivelsesdato"),
    egenTilgjengelighet: mf(p, "bok.egen_tilgjengelighet"), totalInventory: p.totalInventory,
    variant: v ? { inventoryPolicy: v.inventoryPolicy, inventoryItem: { tracked: v.inventoryItem?.tracked } } : null,
  }, rule, date, pub.check);
  if (ap.changes.deleteDate) av.deleteDate = (av.deleteDate ?? 0) + 1;
  if (ap.changes.utgivelsesdato) av.dateChanged = (av.dateChanged ?? 0) + 1;
  if (ap.ownAvailability) av.ownAvailability++;
  if (Object.keys(ap.changes).length) av.changed++; else av.unchanged++;
  if (ap.changes.untrack) { av.untrack++; if (Number(p.totalInventory) > 0) av.untrackWithStock++; }
  const sc = ap.changes.status ?? ap.heldBack.status;
  if (sc) av.statusChanges.push({ handle: p.handle, title: p.title, isbn, code: rule.code, from: sc.from, to: sc.to, lager: Number(p.totalInventory) || 0, egen: ap.ownAvailability });
}
const t0 = Date.now();
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  for (;;) {
    const i = next++;
    if (i >= work.length) return;
    await handle(work[i]);
    if (++done % 500 === 0) console.log(`  ${done}/${work.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
}));

// ── Rapport ──────────────────────────────────────────────────────────────────
const date = new Date().toISOString().slice(0, 10);
mkdirSync(outDir, { recursive: true });
const csvFile = join(outDir, `institusjoner-${date}.csv`);
writeFileSync(csvFile, "﻿" + institutionsCsv(counts.institutions), "utf8");
const statusFile = join(outDir, `statusendringer-lokalt-${date}.csv`);
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
writeFileSync(statusFile, "﻿" + ["Tittel;ISBN;ONIX-kode;Fra;Til;Lager i Shopify;Egen tilgjengelighet;Handle", ...av.statusChanges.map((s) => [s.title, s.isbn, s.code, s.from, s.to, s.lager, s.egen ? "ja" : "nei", s.handle].map(q).join(";"))].join("\n") + "\n", "utf8");
const checkFile = join(outDir, "utgivelsesaar-kontroll.csv");
writeFileSync(checkFile, "﻿" + ["Tittel;ISBN;Handle;År rolle 01;Dato rolle 11 (tidligste);Antall Product;År i Shopify nå;Dato i Shopify nå;Valgt år (ingen dato)", ...pubCheck.map((c) => [c.title, c.isbn, c.handle, c.year01, c.date11, c.products, c.shopifyYear, c.shopifyDate, c.chosen].map(q).join(";"))].join("\n") + "\n", "utf8");
const csvQ = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
writeFileSync(join(outDir, "uten-beskrivelse.csv"), "﻿" + ["Tittel;ISBN;Handle;Status;Beskrivelse i Shopify;Handling;Ny tekst", ...utenBeskrivelse.map((u) => [u.title, u.isbn, u.handle, u.status, u.shopify, u.handling, u.ny.replace(/<[^>]+>/g, "")].map(csvQ).join(";"))].join("\n") + "\n", "utf8");
const result = { snapshot: dir, utenBeskrivelse: { antall: utenBeskrivelse.length, tom: utenBeskrivelse.filter((u) => u.shopify === "tom").length, harTekst: utenBeskrivelse.filter((u) => u.shopify.startsWith("har")).length, skrives: utenBeskrivelse.filter((u) => u.handling.startsWith("faktatekst")).length }, products: products.length, checked: work.length, bokdata: { summary: summarizeBookUpdate(counts, "analyze"), counts }, seo, extra, tilgjengelighet: { ...av, statusChanges: av.statusChanges.length }, utgivelse: { regler: pubRules, kontrolliste: pubCheck.length, kontrollFil: checkFile }, metabeskrivelseEksempler: descExamples, tittelFjernet: { antall: strippedCount, eksempler: strippedExamples } };
writeFileSync(join(outDir, `sjekk-lokalt-${date}.json`), JSON.stringify(result, null, 1));
console.log("\n── Bokdata (sjekkmodus) ──\n" + result.bokdata.summary);
console.log("\nFelt:"); for (const [k, v] of Object.entries(counts.fields).sort((a, b) => b[1].count - a[1].count)) console.log(`  ${k}: ${v.count}`);
console.log("\nSEO:", seo, "\nEkstra:", extra, "\nUten forlagstekst:", result.utenBeskrivelse);
const sc = {}; for (const s of av.statusChanges) sc[`${s.from} → ${s.to}`] = (sc[`${s.from} → ${s.to}`] ?? 0) + 1;
console.log("\n── Tilgjengelighet (sjekkmodus) ──\n", { ...av, statusChanges: sc });
console.log(`\nInstitusjoner: ${Object.keys(counts.institutions).length} navn → ${csvFile}\nStatusendringer → ${statusFile}`);
