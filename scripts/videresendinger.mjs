#!/usr/bin/env node
// scripts/videresendinger.mjs — pakke H del 3b: sjekk lokalt av videresending for arkiverte bøker.
// Bruker de samme reglene som tilgjengelighetsjobben (_shared/redirects.ts, availabilityRule) mot et
// snapshot (scripts/snapshot.mjs) og ONIX fra scripts/out/onix-gjennomgang/. SKRIVER ALDRI til Shopify.
//   node --experimental-strip-types scripts/videresendinger.mjs <snapshot-mappe>
// Utdata: scripts/out/videresendinger.csv + tall per måltype og 10 eksempler.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./lib/clients.mjs";
import { outDir } from "./lib/clients.mjs";
import { availabilityRule } from "../supabase/functions/_shared/availability.ts";
import { extractAvailabilityCode, extractReplacedBy } from "../supabase/functions/_shared/onix.js";
import { extractIsbn } from "../supabase/functions/_shared/isbn.js";
import { PROTECTED_COLLECTION_HANDLES, protectedProduct, setProtectedMembers } from "../supabase/functions/_shared/protected.ts";
import { bokgruppeFromTags } from "../supabase/functions/_shared/bokgruppe.ts";
import { chooseRedirectTarget, handlePath, planRedirect, planRemoveRedirect, wantsRedirect } from "../supabase/functions/_shared/redirects.ts";

const dir = process.argv[2];
if (!dir) { console.error("Bruk: node --experimental-strip-types scripts/videresendinger.mjs <snapshot-mappe>"); process.exit(1); }
const lines = (file) => readFileSync(join(dir, file), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const collections = new Set(), handles = new Map(), members = new Map();
for (const o of lines("collections.jsonl")) {
  if (!o.__parentId) { collections.add(o.handle); if (PROTECTED_COLLECTION_HANDLES.includes(o.handle)) handles.set(o.id, o.handle); }
  else if (handles.has(o.__parentId) && o.id.includes("/Product/")) members.set(o.id, handles.get(o.__parentId));
}
setProtectedMembers(members);
const redirects = lines("redirects.jsonl");
const redirectsByPath = new Map(redirects.map((r) => [r.path, r]));

const byId = new Map();
for (const o of lines("products.jsonl")) {
  if (!o.__parentId) { byId.set(o.id, { ...o, mf: {}, variants: [] }); continue; }
  const p = byId.get(o.__parentId);
  if (!p) continue;
  if (o.id.includes("/Metafield/")) p.mf[`${o.namespace}.${o.key}`] = o.value;
  else if (o.id.includes("/ProductVariant/")) p.variants.push(o);
}
const products = [...byId.values()];
const isbnOf = (p) => extractIsbn({ handle: p.handle, bokIsbn: p.mf["bok.isbn"] != null ? { value: p.mf["bok.isbn"] } : null, variants: { nodes: p.variants.slice(0, 1) } });
const activeByIsbn = new Map();
for (const p of products) { const i = isbnOf(p); if (i && p.status === "ACTIVE") activeByIsbn.set(i, p.handle); }
const onixFor = (isbn) => { const f = join(outDir, "onix-gjennomgang", `${isbn}.xml`); return existsSync(f) ? readFileSync(f, "utf8") : null; };

const rows = [], count = { erstatning: 0, samling: 0, ingen: 0, fjernet: 0, funnet: 0 };
for (const p of products) {
  if (protectedProduct(p)) continue;
  const isbn = isbnOf(p);
  let code = null, xml = null;
  if (p.status === "ARCHIVED") code = p.mf["bok.tilgjengelighet"] === "utgatt" ? "43" : null;
  else if (isbn && (xml = onixFor(isbn))) code = extractAvailabilityCode(xml);
  else if (p.status !== "ACTIVE") continue;
  // Status etter jobben: egen tilgjengelighet og arkiverte står; ellers regelen
  const after = p.status === "ARCHIVED" || p.mf["bok.egen_tilgjengelighet"] === "true" ? p.status : availabilityRule(code).status;
  const existing = [handlePath(p.handle), ...(isbn ? [`/products/${isbn}`] : [])].map((x) => redirectsByPath.get(x)).filter(Boolean);
  if (after === "ACTIVE") {
    const ops = planRemoveRedirect(p.handle, isbn, existing);
    if (ops.length) { count.fjernet++; rows.push([p.title, isbn, p.handle, p.status, code, "fjernes (aktiv igjen)", "", ops.map((o) => o.op).join("+")]); }
    continue;
  }
  if (!wantsRedirect(p, code, after)) continue;
  const repl = code === "41" && xml ? extractReplacedBy(xml).map((i) => activeByIsbn.get(i)).find(Boolean) ?? null : null;
  const t = chooseRedirectTarget(code, repl, p.mf["bok.bokgruppe"] || bokgruppeFromTags(p.tags), collections);
  if (!t.target) { count.ingen++; rows.push([p.title, isbn, p.handle, p.status, code, "ingen", t.note, ""]); continue; }
  const ops = planRedirect(p.handle, isbn, t.target, existing);
  if (!ops.length) { count.funnet++; rows.push([p.title, isbn, p.handle, p.status, code, t.kind, t.target, "finnes"]); continue; }
  count[t.kind]++;
  rows.push([p.title, isbn, p.handle, p.status, code, t.kind, t.target, ops.map((o) => o.op).join("+")]);
}
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
writeFileSync(join(outDir, "videresendinger.csv"), "﻿" + ["Tittel;ISBN;Handle;Status;ONIX-kode;Type;Mål / årsak;Operasjoner", ...rows.map((r) => r.map(q).join(";"))].join("\n") + "\n", "utf8");
const perKode = {}; for (const r of rows) perKode[r[4] ?? "?"] = (perKode[r[4] ?? "?"] ?? 0) + 1;
console.log(`${products.length} produkter; ${rows.length} rader i scripts/out/videresendinger.csv`);
console.log("Per måltype:", count, "\nPer ONIX-kode:", perKode);
console.log("Eksempler:"); for (const r of rows.filter((r) => r[5] === "erstatning").slice(0, 5).concat(rows.filter((r) => r[5] === "samling").slice(0, 5))) console.log(`  [${r[4]}] /products/${r[2]} → ${r[6]}  (${r[7]})`);
