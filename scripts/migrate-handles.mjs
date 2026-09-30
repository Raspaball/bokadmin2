#!/usr/bin/env node
// scripts/migrate-handles.mjs
// Endrer handles fra ISBN (/products/9788202921538) til
// tittel-forfatter-ISBN (/products/glukoserevolusjonens-metode-jessie-inchauspe-9788202921538).
// Shopify lager automatisk 301-videresending fra gammel adresse (redirectNewHandle).
//
// Regelen ligger i supabase/functions/_shared/handle.js og er den samme som
// Bokadmin 2.0 bruker ved eksport.
//
// KJØRING (fra prosjektmappa):
//   node scripts/migrate-handles.mjs --dry-run              # lag plan, endrer ingenting
//   node scripts/migrate-handles.mjs --dry-run --limit 20   # plan for de 20 første
//   node scripts/migrate-handles.mjs --execute              # utfør planen (bulk-operasjon)
//   node scripts/migrate-handles.mjs --execute --direct     # utfør ett og ett produkt (for små tester)
//   node scripts/migrate-handles.mjs --execute --skip-flagged  # hopp over rader med duplikat/kollisjon
//   node scripts/migrate-handles.mjs --dry-run --input fil.json # tørrkjøring mot eksportert produktliste, uten nøkler
//   node scripts/migrate-handles.mjs --verify               # sjekk at videresendinger finnes
//   node scripts/migrate-handles.mjs --rollback             # sett tilbake handles fra siste kjøring
//
// NØKLER: scripts/.env.local (git-ignorert) eller miljøvariabler:
//   SHOPIFY_SHOP_DOMAIN=testbutikk-9434.myshopify.com
//   SHOPIFY_CLIENT_ID=...
//   SHOPIFY_CLIENT_SECRET=...
//
// SIKKERHET: skriptet kjører bare mot Testbutikk. Andre butikker krever
// --confirm-store=<butikkens myshopify-domene>, og skal bare brukes av Eirik
// ved overgangen til Bokadmin 2.0. Dagens live-Bokadmin tåler IKKE nye handles
// (eksport og sjangersynk finner bøker på handle = ISBN).

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBookHandle, normalizeIsbn } from "../supabase/functions/_shared/handle.js";

const API_VERSION = "2026-07"; // samme som supabase/functions/_shared/shopify.ts
const SAFE_STORES = ["testbutikk-9434.myshopify.com"];
const PLAN_MAX_AGE_HOURS = 24;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");

// ── Argumenter ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const MODE = flag("execute") ? "execute" : flag("rollback") ? "rollback" : flag("verify") ? "verify" : "dry-run";
const LIMIT = option("limit") ? Number(option("limit")) : Infinity;
const DIRECT = flag("direct");
const INCLUDE_CUSTOM = flag("include-custom");
const SKIP_FLAGGED = flag("skip-flagged"); // hopp over rader med duplikat/kollisjon i stedet for å stoppe
const INPUT_FILE = option("input"); // tørrkjøring mot eksportert produktliste (JSON), uten API-kall

// ── Miljø ──────────────────────────────────────────────────────────────────
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(join(here, ".env.local"));

const SHOP = (process.env.SHOPIFY_SHOP_DOMAIN || (option("input") ? "testbutikk-9434.myshopify.com" : "")).trim();
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}
if (INPUT_FILE && MODE !== "dry-run") fail("--input kan bare brukes med --dry-run.");
if (!INPUT_FILE && (!SHOP || !CLIENT_ID || !CLIENT_SECRET)) {
  fail("Mangler SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID eller SHOPIFY_CLIENT_SECRET (scripts/.env.local).");
}
if (!SAFE_STORES.includes(SHOP) && option("confirm-store") !== SHOP) {
  fail(`${SHOP} er ikke Testbutikk. Stopper.\nFor å kjøre mot en annen butikk: --confirm-store=${SHOP}\n(Kun ved overgang til Bokadmin 2.0. Dagens live-Bokadmin tåler ikke nye handles.)`);
}

mkdirSync(outDir, { recursive: true });
const shopSlug = SHOP.replace(".myshopify.com", "");
const planFile = join(outDir, `handles-plan-${shopSlug}.json`);
const planCsv = join(outDir, `handles-plan-${shopSlug}.csv`);
const doneFile = join(outDir, `handles-done-${shopSlug}.json`);
const logFile = join(outDir, `handles-log-${shopSlug}.jsonl`);
const log = (entry) => appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Shopify ────────────────────────────────────────────────────────────────
let token = null;
async function getToken() {
  if (token) return token;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  const text = await res.text();
  if (!res.ok) fail(`Kunne ikke hente tilgangsnøkkel (HTTP ${res.status}). Sjekk klient-ID/hemmelighet og at appen er installert.\n${text.slice(0, 300)}`);
  token = JSON.parse(text).access_token;
  return token;
}

async function gql(query, variables = {}, attempt = 0) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && attempt === 0) { token = null; return gql(query, variables, 1); }
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
  if (throttled && attempt < 5) { await sleep(1000 * 2 ** attempt); return gql(query, variables, attempt + 1); }
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

const PRODUCTS_QUERY = `
query Products($cursor: String) {
  products(first: 250, after: $cursor, query: "status:active OR status:draft OR status:archived") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title productType status
      forfatter: metafield(namespace: "bok", key: "forfatter") { value }
      isbnFelt: metafield(namespace: "bok", key: "isbn") { value }
      variants(first: 1) { nodes { barcode sku } }
    }
  }
}`;

const PRODUCT_UPDATE = `
mutation ($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id handle }
    userErrors { field message }
  }
}`;

// ── Hjelpere ───────────────────────────────────────────────────────────────
const isIsbnHandle = (h) => /^\d{10,13}$/.test(h);
function productIsbn(p) {
  const v = p.variants?.nodes?.[0];
  return normalizeIsbn(p.isbnFelt?.value) || normalizeIsbn(v?.barcode) || normalizeIsbn(v?.sku)
    || (isIsbnHandle(p.handle) ? normalizeIsbn(p.handle) : null);
}
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function fetchAllProducts() {
  const all = [];
  let cursor = null;
  do {
    const data = await gql(PRODUCTS_QUERY, { cursor });
    all.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    process.stdout.write(`\r  Hentet ${all.length} produkter …`);
  } while (cursor);
  process.stdout.write("\n");
  return all;
}

// ── Tørrkjøring: lag plan ──────────────────────────────────────────────────
async function dryRun() {
  console.log(`\nTørrkjøring mot ${SHOP} (ingenting endres)\n`);
  const products = INPUT_FILE ? JSON.parse(readFileSync(INPUT_FILE, "utf8")) : await fetchAllProducts();
  const existing = new Set(products.map((p) => p.handle));
  const plan = [];
  const skipped = { ingenIsbn: 0, alleredeRiktig: 0, egendefinert: 0 };
  const warnings = [];

  for (const p of products) {
    if (plan.length >= LIMIT) break;
    const isbn = productIsbn(p);
    if (!isbn) { skipped.ingenIsbn++; continue; }
    const authors = p.forfatter?.value || p.productType;
    const newHandle = buildBookHandle({ title: p.title, authors, isbn });
    if (!newHandle || newHandle === p.handle) { skipped.alleredeRiktig++; continue; }
    if (!isIsbnHandle(p.handle) && !INCLUDE_CUSTOM) { skipped.egendefinert++; continue; }
    const flags = [];
    if (!authors) flags.push("mangler forfatter");
    if (newHandle.length > 120) flags.push("lang handle");
    plan.push({ id: p.id, status: p.status, title: p.title, author: authors || "", isbn, oldHandle: p.handle, newHandle, flags });
  }

  // Samme ISBN på flere produkter (duplikater i katalogen)
  const byIsbn = new Map();
  for (const p of products) {
    const isbn = productIsbn(p);
    if (isbn) byIsbn.set(isbn, (byIsbn.get(isbn) ?? 0) + 1);
  }
  for (const row of plan) if (byIsbn.get(row.isbn) > 1) row.flags.push("DUPLIKAT: samme ISBN på flere produkter");

  // Kollisjoner: to produkter med samme nye handle, eller ny handle som allerede er i bruk
  const seen = new Map();
  for (const row of plan) {
    if (seen.has(row.newHandle)) { row.flags.push("DUPLIKAT i planen"); seen.get(row.newHandle).flags.push("DUPLIKAT i planen"); }
    else seen.set(row.newHandle, row);
    if (existing.has(row.newHandle)) row.flags.push("handle finnes allerede");
  }
  for (const row of plan) if (row.flags.length) warnings.push(row);

  writeFileSync(planFile, JSON.stringify({ shop: SHOP, createdAt: new Date().toISOString(), plan }, null, 2));
  writeFileSync(planCsv, "﻿" + ["status,tittel,forfatter,isbn,gammel_handle,ny_handle,merknad",
    ...plan.map((r) => [r.status, r.title, r.author, r.isbn, r.oldHandle, r.newHandle, r.flags.join("; ")].map(csvCell).join(","))].join("\n"));

  console.log(`Produkter totalt:            ${products.length}`);
  console.log(`Skal få ny handle:           ${plan.length}`);
  console.log(`Hoppet over, uten ISBN:      ${skipped.ingenIsbn}`);
  console.log(`Hoppet over, allerede riktig:${String(skipped.alleredeRiktig).padStart(3)}`);
  console.log(`Hoppet over, egendefinert:   ${skipped.egendefinert}${skipped.egendefinert ? "  (bruk --include-custom for å ta med)" : ""}`);
  console.log(`Med merknader:               ${warnings.length}`);
  console.log(`\nEksempler:`);
  for (const r of plan.slice(0, 5)) console.log(`  /products/${r.oldHandle}\n    → /products/${r.newHandle}`);
  for (const r of warnings.slice(0, 10)) console.log(`  ⚠ ${r.oldHandle}: ${r.flags.join(", ")}`);
  console.log(`\nPlan: ${planCsv}\nNeste steg: se over CSV-en, og kjør --execute.\n`);
  log({ mode: "dry-run", total: products.length, planned: plan.length, skipped, warnings: warnings.length });
}

// ── Utfør ──────────────────────────────────────────────────────────────────
function readPlan() {
  if (!existsSync(planFile)) fail("Fant ingen plan. Kjør --dry-run først.");
  const data = JSON.parse(readFileSync(planFile, "utf8"));
  if (data.shop !== SHOP) fail(`Planen er laget for ${data.shop}, ikke ${SHOP}.`);
  const ageH = (Date.now() - Date.parse(data.createdAt)) / 36e5;
  if (ageH > PLAN_MAX_AGE_HOURS) fail(`Planen er ${ageH.toFixed(0)} timer gammel. Kjør --dry-run på nytt.`);
  const blocked = data.plan.filter((r) => r.flags.some((f) => f.startsWith("DUPLIKAT") || f === "handle finnes allerede"));
  if (blocked.length && !SKIP_FLAGGED) fail(`${blocked.length} rader har duplikat eller kollisjon. Rett dem, eller kjør med --skip-flagged for å hoppe over dem (se CSV).`);
  if (blocked.length) console.log(`  Hopper over ${blocked.length} rader med duplikat eller kollisjon (--skip-flagged).`);
  const blockedIds = new Set(blocked.map((r) => r.id));
  return data.plan.filter((r) => !blockedIds.has(r.id));
}

async function runDirect(rows, label) {
  const done = [];
  let i = 0;
  for (const row of rows) {
    i++;
    const input = { id: row.id, handle: row.targetHandle, redirectNewHandle: true };
    try {
      const data = await gql(PRODUCT_UPDATE, { product: input });
      const errs = data.productUpdate.userErrors;
      if (errs.length) { log({ mode: label, id: row.id, error: errs }); console.log(`\n  ✖ ${row.fromHandle}: ${errs.map((e) => e.message).join("; ")}`); }
      else { done.push({ ...row, resultHandle: data.productUpdate.product.handle }); log({ mode: label, id: row.id, from: row.fromHandle, to: data.productUpdate.product.handle }); }
    } catch (e) {
      log({ mode: label, id: row.id, error: String(e) });
      console.log(`\n  ✖ ${row.fromHandle}: ${e.message}`);
    }
    process.stdout.write(`\r  ${i}/${rows.length}`);
  }
  process.stdout.write("\n");
  return done;
}

async function runBulk(rows, label) {
  const jsonl = rows.map((r) => JSON.stringify({ product: { id: r.id, handle: r.targetHandle, redirectNewHandle: true } })).join("\n");
  const staged = await gql(`mutation { stagedUploadsCreate(input: [{ resource: BULK_MUTATION_VARIABLES, filename: "handles.jsonl", mimeType: "text/jsonl", httpMethod: POST }]) { stagedTargets { url parameters { name value } } userErrors { field message } } }`);
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) fail(`Opplasting feilet: ${JSON.stringify(staged.stagedUploadsCreate.userErrors)}`);
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "handles.jsonl");
  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) fail(`Opplasting til Shopify feilet (HTTP ${up.status}).`);
  const key = target.parameters.find((p) => p.name === "key").value;

  const run = await gql(`mutation ($mutation: String!, $path: String!) { bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) { bulkOperation { id status } userErrors { field message } } }`,
    { mutation: PRODUCT_UPDATE, path: key });
  const op = run.bulkOperationRunMutation.bulkOperation;
  if (!op) fail(`Bulk-jobben startet ikke: ${JSON.stringify(run.bulkOperationRunMutation.userErrors)}`);
  console.log(`  Bulk-jobb startet: ${op.id}`);
  log({ mode: label, bulkOperation: op.id, rows: rows.length });

  let status;
  do {
    await sleep(5000);
    const d = await gql(`query ($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode objectCount url partialDataUrl } } }`, { id: op.id });
    status = d.node;
    process.stdout.write(`\r  Status: ${status.status}, ${status.objectCount} behandlet   `);
  } while (["CREATED", "RUNNING"].includes(status.status));
  process.stdout.write("\n");
  if (status.status !== "COMPLETED") fail(`Bulk-jobben endte med ${status.status} (${status.errorCode ?? "ingen feilkode"}).`);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const done = [];
  const resultUrl = status.url || status.partialDataUrl;
  if (resultUrl) {
    const lines = (await (await fetch(resultUrl)).text()).split("\n").filter(Boolean);
    for (const line of lines) {
      const r = JSON.parse(line);
      const res = r.data?.productUpdate;
      const id = res?.product?.id;
      if (res?.userErrors?.length) log({ mode: label, error: res.userErrors, line: r.__lineNumber });
      else if (id && byId.has(id)) { done.push({ ...byId.get(id), resultHandle: res.product.handle }); log({ mode: label, id, to: res.product.handle }); }
    }
  }
  return done;
}

async function execute() {
  const plan = readPlan();
  console.log(`\nUtfører ${plan.length} handle-endringer i ${SHOP}${DIRECT ? " (ett og ett)" : " (bulk-operasjon)"}\n`);
  // Sjekk at produktene fortsatt har den gamle handle-en (planen kan være utdatert)
  const current = new Map((await fetchAllProducts()).map((p) => [p.id, p.handle]));
  const rows = plan
    .filter((r) => current.get(r.id) === r.oldHandle)
    .map((r) => ({ id: r.id, fromHandle: r.oldHandle, targetHandle: r.newHandle, oldHandle: r.oldHandle, newHandle: r.newHandle }));
  const stale = plan.length - rows.length;
  if (stale) console.log(`  ${stale} produkter er endret siden planen ble laget, og hoppes over.`);
  if (!rows.length) return console.log("Ingenting å gjøre.\n");

  const done = DIRECT ? await runDirect(rows, "execute") : await runBulk(rows, "execute");
  const previous = existsSync(doneFile) ? JSON.parse(readFileSync(doneFile, "utf8")) : [];
  writeFileSync(doneFile, JSON.stringify([...previous, ...done.map((d) => ({ id: d.id, oldHandle: d.oldHandle, newHandle: d.resultHandle, at: new Date().toISOString() }))], null, 2));
  const mismatch = done.filter((d) => d.resultHandle !== d.newHandle);
  console.log(`\n✔ ${done.length} av ${rows.length} endret.`);
  if (mismatch.length) console.log(`  ⚠ ${mismatch.length} fikk en annen handle enn planlagt (Shopify la til suffiks). Se ${doneFile}.`);
  console.log(`Neste steg: node scripts/migrate-handles.mjs --verify\n`);
}

// ── Kontroll ───────────────────────────────────────────────────────────────
async function verify() {
  if (!existsSync(doneFile)) fail("Ingen utførte endringer å kontrollere.");
  const done = JSON.parse(readFileSync(doneFile, "utf8"));
  const sample = done.length <= 25 ? done : done.filter((_, i) => i % Math.ceil(done.length / 25) === 0);
  console.log(`\nKontrollerer videresending for ${sample.length} av ${done.length}\n`);
  let ok = 0;
  for (const d of sample) {
    const path = `/products/${d.oldHandle}`;
    const data = await gql(`query ($q: String!) { urlRedirects(first: 5, query: $q) { nodes { path target } } }`, { q: `path:${path}` });
    const hit = data.urlRedirects.nodes.find((n) => n.path === path);
    const good = hit && hit.target.endsWith(`/products/${d.newHandle}`);
    if (good) ok++;
    console.log(`  ${good ? "✔" : "✖"} ${path} → ${hit?.target ?? "(ingen videresending)"}`);
  }
  console.log(`\n${ok} av ${sample.length} videresendinger er riktige.\n`);
  log({ mode: "verify", checked: sample.length, ok });
}

// ── Angre ──────────────────────────────────────────────────────────────────
async function rollback() {
  if (!existsSync(doneFile)) fail("Ingen utførte endringer å angre.");
  const done = JSON.parse(readFileSync(doneFile, "utf8"));
  console.log(`\nSetter tilbake ${done.length} handles i ${SHOP}\n`);
  // Fjern videresendingen fra gammel adresse først, ellers kan ikke produktet få adressen tilbake
  for (const d of done) {
    const path = `/products/${d.oldHandle}`;
    const data = await gql(`query ($q: String!) { urlRedirects(first: 5, query: $q) { nodes { id path } } }`, { q: `path:${path}` });
    for (const n of data.urlRedirects.nodes.filter((n) => n.path === path)) {
      await gql(`mutation ($id: ID!) { urlRedirectDelete(id: $id) { deletedUrlRedirectId userErrors { message } } }`, { id: n.id });
    }
  }
  const rows = done.map((d) => ({ id: d.id, fromHandle: d.newHandle, targetHandle: d.oldHandle }));
  const restored = await runDirect(rows, "rollback");
  const restoredIds = new Set(restored.map((r) => r.id));
  writeFileSync(doneFile, JSON.stringify(done.filter((d) => !restoredIds.has(d.id)), null, 2));
  console.log(`\n✔ ${restored.length} av ${done.length} satt tilbake.\n`);
}

// ── Start ──────────────────────────────────────────────────────────────────
const run = { "dry-run": dryRun, execute, verify, rollback }[MODE];
run().catch((e) => { log({ mode: MODE, fatal: String(e) }); fail(e.message); });
