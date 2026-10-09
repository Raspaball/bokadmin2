#!/usr/bin/env node
// scripts/publiser-skjulte.mjs — styrer publiseringsfasen (09.10.2026) mot Edge Function publish-books.
// Sender lista (scripts/out/publiseringsliste.json, lokal, ikke i git) i omganger, stopper ved første feil,
// logger hvert svar i scripts/out/publisering-resultat.jsonl, og kan rulle tilbake akkurat det som ble publisert.
//
//   node scripts/publiser-skjulte.mjs --lag-pilot                       # velger 10 bøker (lokal fil)
//   node scripts/publiser-skjulte.mjs --modus sjekk --pilot             # tørrkjøring: leser bare, ingenting skrives
//   node scripts/publiser-skjulte.mjs --modus publiser --pilot          # publiserer de 10
//   node scripts/publiser-skjulte.mjs --modus publiser --fra 10 --til 510   # en omgang på 500
//   node scripts/publiser-skjulte.mjs --modus tilbakerull-sjekk         # viser hva en tilbakerulling ville gjort
//   node scripts/publiser-skjulte.mjs --modus tilbakerull               # avpubliserer det som er publisert i denne kjøringen
//
// Krever i scripts/.env.local: SUPABASE_URL, SUPABASE_ANON_KEY, PUBLISH_BOOKS_TOKEN, LIVE_SHOPIFY_SHOP_DOMAIN.
// Publisering krever at live er aktiv for denne fasen (Innstillinger → Butikker) og at skrivesperren er åpnet.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fail, outDir } from "./lib/clients.mjs";

const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const listFile = join(outDir, "publiseringsliste.json");
const pilotFile = join(outDir, "pilot-publisering-10.json");
const resultFile = join(outDir, "publisering-resultat.jsonl");
const runFile = join(outDir, "publisering-runid.txt");

if (!existsSync(listFile)) fail("Fant ikke scripts/out/publiseringsliste.json. Lag lista først (skjulte-boker.mjs --fersk).");
const all = JSON.parse(readFileSync(listFile, "utf8")).items;

if (args.includes("--lag-pilot")) {
  // 10 bøker fra ulike forlag: minst 3 Gyldendal, minst 1 uten forfatter i produkttypen (tom produkttype)
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = (pool, n, used) => { const r = []; const p = [...pool].sort(() => rnd() - 0.5); for (const x of p) { if (r.length >= n) break; if (!used.has(x.id)) { used.add(x.id); r.push(x); } } return r; };
  const used = new Set();
  const gyl = all.filter((x) => /gyldendal/i.test(x.forlag));
  const out = [
    ...pick(gyl.filter((x) => !x.produkttype), 1, used),
    ...pick(gyl.filter((x) => x.produkttype), 2, used),
    ...pick(all.filter((x) => /cappelen/i.test(x.forlag)), 2, used),
    ...pick(all.filter((x) => /vigmostad/i.test(x.forlag)), 1, used),
    ...pick(all.filter((x) => /fagbok/i.test(x.forlag)), 1, used),
    ...pick(all.filter((x) => /bonnier|aschehoug|egmont|samlaget|gyldendal/i.test(x.forlag) && !/gyldendal/i.test(x.forlag)), 3, used),
  ].slice(0, 10);
  while (out.length < 10) out.push(...pick(all, 1, used));
  writeFileSync(pilotFile, JSON.stringify({ items: out }, null, 1));
  const f = (re) => out.filter((x) => re.test(x.forlag)).length;
  console.log(`Pilot: ${out.length} bøker (Gyldendal ${f(/gyldendal/i)}, uten produkttype ${out.filter((x) => !x.produkttype).length}) → ${pilotFile}`);
  process.exit(0);
}

const modus = opt("modus", "sjekk");
if (!["sjekk", "publiser", "tilbakerull-sjekk", "tilbakerull"].includes(modus)) fail("Ukjent --modus");
const rollback = modus.startsWith("tilbakerull");
const mode = modus === "publiser" || modus === "tilbakerull" ? "publish" : "check";
const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const anon = process.env.SUPABASE_ANON_KEY, token = process.env.PUBLISH_BOOKS_TOKEN;
const shop = (process.env.LIVE_SHOPIFY_SHOP_DOMAIN || "").trim();
if (!base.includes("chwpqwblqummlufqdefe")) fail("SUPABASE_URL er ikke Bokadmin 2.0. Stopper.");
if (!anon || !shop) fail("Mangler SUPABASE_ANON_KEY eller LIVE_SHOPIFY_SHOP_DOMAIN.");
if (mode === "publish" && !token) fail("Mangler PUBLISH_BOOKS_TOKEN.");
const batchSize = Math.min(100, Number(opt("omgang", 50)));

let runId = existsSync(runFile) ? readFileSync(runFile, "utf8").trim() : null;
if (!runId) { runId = randomUUID(); writeFileSync(runFile, runId); }

let items;
if (rollback) {
  // Akkurat det som faktisk ble publisert (fra resultatloggen), uten dem som siden er avpublisert
  const log = existsSync(resultFile) ? readFileSync(resultFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const published = new Set(), undone = new Set();
  for (const r of log) { if (r.rollback) { if (r.outcome === "publisert") undone.add(r.id); } else if (r.outcome === "publisert") published.add(r.id); }
  items = [...published].filter((id) => !undone.has(id)).map((id) => ({ id }));
} else {
  const src = args.includes("--pilot") ? JSON.parse(readFileSync(pilotFile, "utf8")).items : all;
  items = src.slice(Number(opt("fra", 0)), opt("til") ? Number(opt("til")) : undefined).map((x) => ({ id: x.id, isbn: x.isbn }));
}
console.log(`Modus: ${modus}. ${items.length} bøker i ${Math.ceil(items.length / batchSize)} omganger på ${batchSize}.`);
if (!items.length) process.exit(0);

const total = { publisert: 0, uendret: 0, hoppet_over: 0, feil: 0 };
for (let i = 0; i < items.length; i += batchSize) {
  const chunk = items.slice(i, i + batchSize);
  const res = await fetch(`${base}/functions/v1/publish-books/${rollback ? "rollback" : "run"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${anon}`, apikey: anon, "Content-Type": "application/json", ...(token ? { "x-publish-token": token } : {}) },
    body: JSON.stringify({ mode, expectedShop: shop, runId, items: chunk }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.counts) fail(`Omgang ${i / batchSize + 1}: HTTP ${res.status} ${JSON.stringify(j)?.replace(shop, "<live>").slice(0, 300)}. Stopper.`);
  for (const r of j.results) appendFileSync(resultFile, JSON.stringify({ ...r, rollback, mode, at: new Date().toISOString() }) + "\n");
  for (const k of Object.keys(total)) total[k] += j.counts[k] ?? 0;
  console.log(`Omgang ${i / batchSize + 1}: ${JSON.stringify(j.counts)}`);
  if (j.counts.feil > 0 || (j.notProcessed?.length ?? 0) > 0) {
    const bad = j.results.filter((r) => r.outcome === "feil").slice(0, 3).map((r) => r.message);
    fail(`Stopper etter omgang ${i / batchSize + 1}: ${j.counts.feil} feil, ${j.notProcessed?.length ?? 0} ikke behandlet. ${bad.join(" | ")}`);
  }
}
console.log(`\nFerdig. Totalt: ${JSON.stringify(total)}  (${mode === "check" ? "tørrkjøring, ingenting skrevet" : rollback ? "avpublisert" : "publisert"})`);
