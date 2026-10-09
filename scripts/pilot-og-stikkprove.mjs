#!/usr/bin/env node
// scripts/pilot-og-stikkprove.mjs — live-sjekk 1, punkt 18 og 21. BARE LOKALE FILER: leser live-eksporten,
// ONIX fra den lokale hurtigbufferen (scripts/out/onix-gjennomgang/) og handle-planen; kontakter verken
// Shopify eller Bokbasen. Bruker de samme delte reglene som jobbene (planBookUpdate, planAvailability).
//
//   node --experimental-strip-types scripts/pilot-og-stikkprove.mjs --mappe scripts/data/live-eksport-… [--seed 7]
//
// Utfiler (scripts/out/, git-ignorert, live-data): pilot-forslag-50.csv, stikkprove-10.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outDir } from "./lib/clients.mjs";

globalThis.Deno ??= { env: { get: (k) => process.env[k] } };
const { planBookUpdate } = await import("../supabase/functions/_shared/book-update.ts");
const { availabilityRule, planAvailability } = await import("../supabase/functions/_shared/availability.ts");
const { notBookSkip } = await import("../supabase/functions/_shared/book-format.ts");
const { channelsToPublish } = await import("../supabase/functions/_shared/publish.ts");
const { bookFieldsFromOnix } = await import("../supabase/functions/_shared/book-standard.ts");
const { protectedProduct, setProtectedMembers, PROTECTED_COLLECTION_HANDLES } = await import("../supabase/functions/_shared/protected.ts");
const { extractAvailabilityCode, extractDescription, resolvePublication } = await import("../supabase/functions/_shared/onix.js");
const { extractIsbn } = await import("../supabase/functions/_shared/isbn.js");

const args = process.argv.slice(2);
const dir = args[args.indexOf("--mappe") + 1];
if (!dir || !existsSync(dir)) { console.error("Oppgi --mappe <live-eksport>"); process.exit(1); }
let seed = Number(args.includes("--seed") ? args[args.indexOf("--seed") + 1] : 7);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const lines = (f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

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
const isbnCount = new Map();
for (const p of products) { const i = isbnOf(p); if (i) isbnCount.set(i, (isbnCount.get(i) ?? 0) + 1); }

const handlePlan = new Map();
const hp = join(outDir, "live-handles-analyze.json");
if (existsSync(hp)) for (const r of JSON.parse(readFileSync(hp, "utf8")).plan) handlePlan.set(r.id, r);

const publications = JSON.parse(readFileSync(join(dir, "butikk.json"), "utf8")).publications.map((p) => p.id);
const have = new Map();
const kf = join(outDir, "skjulte-kanaler.jsonl");
if (existsSync(kf)) for (const l of readFileSync(kf, "utf8").split("\n").filter(Boolean)) {
  const o = JSON.parse(l);
  if (!o.__parentId) have.set(o.id, []); else if (o.publication?.id && have.has(o.__parentId)) have.get(o.__parentId).push(o.publication.id);
}

const cacheDir = join(outDir, "onix-gjennomgang");
const eligible = [];
for (const p of products) {
  const isbn = isbnOf(p);
  if (!isbn || protectedProduct(p) || (isbnCount.get(isbn) ?? 0) > 1) continue;
  const f = join(cacheDir, `${isbn}.xml`);
  if (!existsSync(f)) continue; // bare det som allerede ligger i hurtigbufferen
  const xml = readFileSync(f, "utf8");
  if (notBookSkip(xml)) continue;
  const code = extractAvailabilityCode(xml) || "";
  const rule = availabilityRule(code);
  const plan = planBookUpdate(asBookProduct(p), xml);
  const pub = resolvePublication(xml);
  const v = p.variants[0];
  const ap = planAvailability({
    status: p.status, tilgjengelighet: mf(p, "bok.tilgjengelighet"), utgivelsesdato: mf(p, "bok.utgivelsesdato"),
    egenTilgjengelighet: mf(p, "bok.egen_tilgjengelighet"), totalInventory: p.totalInventory,
    variant: v ? { inventoryPolicy: v.inventoryPolicy, inventoryItem: { tracked: v.inventoryItem?.tracked } } : null,
  }, rule, pub.date, pub.check);
  const newStatus = ap.changes.status?.to ?? p.status;
  const bf = bookFieldsFromOnix(xml);
  const hidden = p.status === "ACTIVE" && !p.publishedAt;
  const tags = [];
  const add = (c, t) => { if (c) tags.push(t); };
  add(isbn.startsWith("97882"), "norsk");
  add(!isbn.startsWith("97882"), "utenlandsk");
  add(["10", "11", "12"].includes(code), "kommende");
  add(!extractDescription(xml)?.trim(), "uten forlagstekst");
  add(bf.authors.length > 1, "flere forfattere");
  add(bf.institutions.length > 0, "institusjon");
  add(!/^97[89]\d{10}$/.test(p.handle), "lesbar adresse");
  add(p.status === "DRAFT" && newStatus === "ACTIVE", "utkast blir aktiv");
  add(p.status === "ACTIVE" && newStatus !== "ACTIVE", "aktiv blir utkast/arkivert");
  add(hidden, "aktiv men skjult i nettbutikken");
  eligible.push({ p, isbn, code, newStatus, plan, tags, bf, hidden, newHandle: handlePlan.get(p.id)?.newHandle ?? "" });
}
console.log(`${products.length} produkter; ${eligible.length} kan vurderes (ISBN, ikke beskyttet, ikke duplikat, ONIX i hurtigbufferen, bok).`);

// ── Pilot: minst én fra hver gruppe, 50 totalt ───────────────────────────────
const groups = ["norsk", "utenlandsk", "kommende", "uten forlagstekst", "flere forfattere", "institusjon", "lesbar adresse", "utkast blir aktiv", "aktiv blir utkast/arkivert", "aktiv men skjult i nettbutikken"];
const perGroup = { "norsk": 3, "utenlandsk": 3, "kommende": 3, "uten forlagstekst": 4, "flere forfattere": 4, "institusjon": 4, "lesbar adresse": 4, "utkast blir aktiv": 4, "aktiv blir utkast/arkivert": 5, "aktiv men skjult i nettbutikken": 5 };
const picked = new Map();
const dekning = {};
for (const g of groups) {
  const pool = shuffle(eligible.filter((e) => e.tags.includes(g) && !picked.has(e.isbn)));
  dekning[g] = { tilgjengelig: eligible.filter((e) => e.tags.includes(g)).length, valgt: 0 };
  for (const e of pool.slice(0, perGroup[g])) { picked.set(e.isbn, e); dekning[g].valgt++; }
}
for (const e of shuffle(eligible.filter((e) => !picked.has(e.isbn) && e.tags.length === 0 || (!picked.has(e.isbn) && e.p.status === "ACTIVE" && e.newStatus === "ACTIVE")))) {
  if (picked.size >= 50) break;
  picked.set(e.isbn, e);
}
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csv = ["Tittel;ISBN;Grupper;Status i dag;Ny status;Handle nå;Ny handle;Produkttype nå;Skjult i nettbutikken"];
for (const e of picked.values()) csv.push([e.p.title, e.isbn, e.tags.join(" + "), e.p.status, e.newStatus, e.p.handle, e.newHandle, e.p.productType, e.hidden ? "ja" : "nei"].map(q).join(";"));
writeFileSync(join(outDir, "pilot-forslag-50.csv"), "﻿" + csv.join("\n") + "\n", "utf8");
console.log("Pilot:", picked.size, "bøker →", join(outDir, "pilot-forslag-50.csv"));
console.log("Dekning per gruppe:", JSON.stringify(dekning));

// ── Stikkprøve: 10 tilfeldige bøker ─────────────────────────────────────────
seed = 12345;
const sample = shuffle(eligible).slice(0, 10).map((e) => {
  const field = (k) => e.plan.changes.find((c) => c.field === k);
  const mfv = (k) => e.plan.metafields.find((m) => m.key === k)?.value ?? null;
  return {
    isbn: e.isbn, tittel: e.p.title, status_i_dag: e.p.status, ny_status: e.newStatus, onix: e.code,
    handle_nå_er_isbn: /^97[89]\d{10}$/.test(e.p.handle), ny_handle: e.newHandle,
    seo_tittel_nå: e.p.mf["global.title_tag"] ?? null, seo_tittel_ny: mfv("title_tag"),
    seo_beskrivelse_nå: (e.p.mf["global.description_tag"] ?? "").slice(0, 70), seo_beskrivelse_ny: (mfv("description_tag") ?? "").slice(0, 70),
    tagger_nå: e.p.tags, tagger_ny: e.plan.product.tags ?? null,
    produkttype_nå: e.p.productType, produkttype_ny: e.plan.product.productType ?? null,
    felt_som_endres: e.plan.changes.map((c) => c.field).sort(), merknader: e.plan.notes,
  };
});
writeFileSync(join(outDir, "stikkprove-10.json"), JSON.stringify(sample, null, 1));
console.log("Stikkprøve → scripts/out/stikkprove-10.json");
