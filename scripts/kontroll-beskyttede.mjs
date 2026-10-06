#!/usr/bin/env node
// scripts/kontroll-beskyttede.mjs — pakke H del 4: er de beskyttede produktene i Testbutikk fortsatt
// slik importfilene (scripts/data/full-del-*.csv) la dem inn? Bare lesing: CSV-filene og et snapshot
// (scripts/snapshot.mjs). Sammenligner INNHOLD, ikke updatedAt (Shopify rører updatedAt selv).
//
//   node --experimental-strip-types scripts/kontroll-beskyttede.mjs <snapshot-mappe>
//
// Beskyttet = regelen i _shared/protected.ts (tagg, leverandør, samling wrendale). Felt: tittel, beskrivelse,
// tagger, leverandør, type, status, pris, handle, SEO-tittel/-beskrivelse, bilder. Samlinger finnes ikke i
// importfilene: medlemskapet listes fra snapshotet, for hånd-sjekk. Utdata: scripts/out/kontroll-beskyttede.json + .csv

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTECTED_COLLECTION_HANDLES, protectedProduct, setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
import { loadSnapshot } from "./snapshot-diff.mjs";

const dir = process.argv[2];
if (!dir) { console.error("Bruk: node --experimental-strip-types scripts/kontroll-beskyttede.mjs <snapshot-mappe>"); process.exit(1); }

/** RFC 4180: felt i anførselstegn med komma, linjeskift og "" */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
/** Tom beskrivelse: Shopify lagrer en tom tekst fra importen som «<p></p>» */
const normBody = (s) => { const t = norm(s); return /^(<p>\s*<\/p>)?$/i.test(t) ? "" : t; };
const num = (s) => { const n = parseFloat(String(s ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const fileName = (u) => String(u ?? "").split("?")[0].split("/").pop();
/** Shopify gir bildefilnavn et suffiks etter import; sammenlign filnavnet uten endelse og størrelses-/id-suffiks */
const imgKey = (u) => fileName(u).replace(/\.[a-z0-9]+$/i, "").replace(/_\d+x\d*$/i, "").replace(/_[0-9a-f-]{8,}$/i, "").toLowerCase();

// ── Importfilene: ett produkt per Handle (første rad), bildene fra alle rader ──
const csvProducts = new Map();
const files = readdirSync("scripts/data").filter((f) => /^full-del-\d+\.csv$/.test(f)).sort();
for (const f of files) {
  const rows = parseCsv(readFileSync(join("scripts/data", f), "utf8").replace(/^﻿/, ""));
  const idx = Object.fromEntries(rows[0].map((n, i) => [n, i]));
  const g = (r, n) => r[idx[n]] ?? "";
  for (const r of rows.slice(1)) {
    const handle = g(r, "Handle");
    if (!handle) continue;
    let p = csvProducts.get(handle);
    if (!p) {
      p = { handle, file: f, title: g(r, "Title"), body: g(r, "Body (HTML)"), vendor: g(r, "Vendor"), type: g(r, "Type"), tags: g(r, "Tags"),
        status: g(r, "Status"), price: g(r, "Variant Price"), seoTitle: g(r, "SEO Title"), seoDesc: g(r, "SEO Description"), images: [], barcode: g(r, "Variant Barcodes") };
      csvProducts.set(handle, p);
    }
    const img = g(r, "Image Src");
    if (img) p.images.push(img);
  }
}

// ── Testbutikk nå ──
const snap = loadSnapshot(dir);
const members = new Map();
for (const c of snap.collections.values()) if (PROTECTED_COLLECTION_HANDLES.includes(c.handle)) for (const id of c.products) members.set(id, c.handle);
setProtectedMembers(members);
const shopByHandle = new Map([...snap.products.values()].map((p) => [p.handle, p]));
const memberships = new Map();
for (const c of snap.collections.values()) for (const id of c.products) (memberships.get(id) ?? memberships.set(id, []).get(id)).push(c.handle);

const csvTags = (s) => String(s ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const csvProtected = (p) => protectedProduct({ id: "csv", handle: p.handle, tags: csvTags(p.tags), vendor: p.vendor }, new Map());
const statusOf = (s) => String(s ?? "").toUpperCase();

const deviations = []; // { handle, felt, importfil, testbutikk }
const perField = {};
const dev = (handle, field, a, b) => { deviations.push({ handle, felt: field, importfil: a, testbutikk: b }); perField[field] = (perField[field] ?? 0) + 1; };

const protectedShop = [...snap.products.values()].filter((p) => protectedProduct(p, members));
const protectedCsv = [...csvProducts.values()].filter(csvProtected);
let sameAll = 0, inBoth = 0;
const notInCsv = [], missingInShop = [];
// Handle som ikke finnes: leter etter produktet på strekkode eller tittel (handle kan være byttet)
const shopByTitle = new Map([...snap.products.values()].map((p) => [norm(p.title).toLowerCase(), p]));
const shopByBarcode = new Map([...snap.products.values()].filter((p) => p.variants[0]?.barcode).map((p) => [p.variants[0].barcode, p]));
const missingInfo = {};
for (const p of protectedCsv) {
  if (shopByHandle.has(p.handle)) continue;
  missingInShop.push(p.handle);
  const other = shopByBarcode.get(String(p.barcode).replace(/'/g, "")) ?? shopByTitle.get(norm(p.title).toLowerCase());
  missingInfo[p.handle] = other ? { funnetSom: other.handle, status: other.status, beskyttetNå: !!protectedProduct(other, members) } : null;
  dev(p.handle, "(produktet finnes ikke i Testbutikk)", `i importfila (${p.file})`, other ? `finnes som ${other.handle} (${other.status}, ${protectedProduct(other, members) ? "beskyttet" : "IKKE beskyttet"})` : "borte");
}
for (const s of protectedShop) {
  const c = csvProducts.get(s.handle);
  if (!c) { notInCsv.push(s.handle); continue; } // f.eks. i samlingen wrendale uten tagg/leverandør, eller lagt til senere
  inBoth++;
  const before = deviations.length;
  const vbarcode = s.variants[0]?.barcode ?? "";
  if (norm(c.title) !== norm(s.title)) dev(s.handle, "tittel", c.title, s.title);
  if (normBody(c.body) !== normBody(s.descriptionHtml)) dev(s.handle, "beskrivelse", norm(c.body).slice(0, 300), norm(s.descriptionHtml).slice(0, 300));
  const ct = csvTags(c.tags).map((t) => t.toLowerCase()).sort().join(", "), st = [...(s.tags ?? [])].map((t) => t.toLowerCase()).sort().join(", ");
  if (ct !== st) dev(s.handle, "tagger", ct, st);
  if (norm(c.vendor) !== norm(s.vendor)) dev(s.handle, "leverandør", c.vendor, s.vendor);
  if (norm(c.type) !== norm(s.productType)) dev(s.handle, "type", c.type, s.productType);
  if (c.status && statusOf(c.status) !== statusOf(s.status)) dev(s.handle, "status", c.status, s.status);
  if (num(c.price) !== num(s.variants[0]?.price)) dev(s.handle, "pris", c.price, s.variants[0]?.price);
  if (norm(c.seoTitle) !== norm(s.seo?.title) && !(norm(c.seoTitle) === "" && norm(s.seo?.title) === norm(s.title))) dev(s.handle, "SEO-tittel", c.seoTitle, s.seo?.title);
  if (norm(c.seoDesc) !== norm(s.seo?.description) && !(norm(c.seoDesc) === "" && norm(s.seo?.description) === "")) dev(s.handle, "SEO-beskrivelse", c.seoDesc, s.seo?.description);
  const ci = c.images.map(imgKey), si = s.media.map((m) => imgKey(m.image?.url));
  if (ci.length !== si.length) dev(s.handle, "bilder (antall)", ci.length, si.length);
  else if (ci.some((k, i) => k !== si[i])) dev(s.handle, "bilder (filnavn)", ci.join(" | "), si.join(" | "));
  if (c.barcode && c.barcode.replace(/'/g, "") !== (vbarcode ?? "")) dev(s.handle, "strekkode", c.barcode, vbarcode);
  if (deviations.length === before) sameAll++;
}

const report = {
  snapshot: dir, importfiler: files, produkterIImportfilene: csvProducts.size,
  beskyttedeITestbutikk: protectedShop.length, beskyttedeIImportfilene: protectedCsv.length,
  sammenlignet: inBoth, likePåAlleFelt: sameAll, medAvvik: inBoth - sameAll,
  avvikPerFelt: perField, beskyttedeUtenImportrad: notInCsv, importertMenBorte: missingInfo,
  samlingerPerBeskyttetProdukt: Object.fromEntries(protectedShop.map((s) => [s.handle, memberships.get(s.id) ?? []])),
  merknad: "Samlinger finnes ikke i importfilene; medlemskapet er fra snapshotet. updatedAt sammenlignes ikke.",
};
writeFileSync("scripts/out/kontroll-beskyttede.json", JSON.stringify(report, null, 2));
const cell = (v) => `"${String(v ?? "").replace(/"/g, '""').slice(0, 2000)}"`;
writeFileSync("scripts/out/kontroll-beskyttede.csv", "﻿" + [["Handle", "Felt", "Importfil", "Testbutikk"], ...deviations.map((d) => [d.handle, d.felt, d.importfil, d.testbutikk])].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n");

console.log(`Beskyttede i Testbutikk: ${protectedShop.length}; i importfilene: ${protectedCsv.length}; sammenlignet: ${inBoth}`);
console.log(`Like på alle felt: ${sameAll}; med avvik: ${inBoth - sameAll}`);
console.log("Avvik per felt:", perField);
console.log(`Beskyttet nå, men ikke i importfilene (${notInCsv.length}):`, notInCsv.slice(0, 10));
console.log(`I importfilene som beskyttet, men borte fra Testbutikk (${missingInShop.length}):`, missingInShop.slice(0, 10));
console.log("→ scripts/out/kontroll-beskyttede.json og .csv");
