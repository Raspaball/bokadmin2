#!/usr/bin/env node
// scripts/duplicates.mjs — duplikater: samme ISBN på flere produkter (pakke D del 3b).
// Reglene ligger i supabase/functions/_shared/duplicates.ts.
//
// KJØRING (fra prosjektmappa):
//   node scripts/duplicates.mjs --report                 # Testbutikk: rapport → scripts/out/duplikater-<butikk>.json/.csv
//   node scripts/duplicates.mjs --report --csv fil.csv   # fra en Shopify-eksport (f.eks. live), uten API-kall
//   node scripts/duplicates.mjs --merge                  # vis taggene som legges til på produktet som beholdes
//   node scripts/duplicates.mjs --merge --execute        # legg dem til (tagsAdd: bare tillegg)
//   node scripts/duplicates.mjs --redirects              # vis videresendinger for duplikater Eirik har slettet
//   node scripts/duplicates.mjs --redirects --execute    # lag dem (urlRedirectCreate)
//
// Bokadmin sletter aldri produkter: Eirik sletter duplikatene i Shopify admin etter
// å ha sett rapporten. Beskyttede produkter (protected.ts) røres ikke.
// Ordrer: regelen er «behold produktet med ordrer, ellers det eldste». Ordrene telles
// med en bulk-spørring over alle ordrer (produktet på hver ordrelinje). Uten read_orders
// er ordrene «ukjent» og regelen blir «eldst»; uten read_all_orders ser Shopify bare
// de siste 60 dagene. Begge deler sies tydelig fra om, i terminalen og i rapporten.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ORDERS_BY_PRODUCT_BULK_QUERY, OrderCounter, decideDuplicate, groupDuplicates, orderAccess, orderAccessWarning, tagsToMerge,
} from "../supabase/functions/_shared/duplicates.ts";
import { protectedMessage, protectedTag } from "../supabase/functions/_shared/protected.ts";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const option = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const MODE = flag("merge") ? "merge" : flag("redirects") ? "redirects" : "report";
const EXECUTE = flag("execute");
const CSV = option("csv");

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// ── Kilder ─────────────────────────────────────────────────────────────────
/** Enkel RFC 4180-leser (anførselstegn, linjeskift i felt). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ""), r[i] ?? ""])));
}

function productsFromCsv(file) {
  const byHandle = new Map();
  for (const r of parseCsv(readFileSync(file, "utf8"))) {
    if (!byHandle.has(r.Handle)) {
      byHandle.set(r.Handle, {
        id: `csv:${r.Handle}`, handle: r.Handle, title: r.Title, status: (r.Status || "").toUpperCase(), createdAt: null,
        productType: r.Type, tags: (r.Tags || "").split(",").map((t) => t.trim()).filter(Boolean), forfatter: [], orders: null,
        variants: { nodes: [{ barcode: r["Variant Barcode"] ?? r["Variant Barcodes"] ?? null, sku: r["Variant SKU"] || null }] },
      });
    }
  }
  return [...byHandle.values()];
}

const PRODUCT_FIELDS = `id handle title status createdAt productType tags
  forfatter: metafield(namespace: "bok", key: "forfatter") { value }
  bokIsbn: metafield(namespace: "bok", key: "isbn") { value }
  variants(first: 1) { nodes { barcode sku } }`;

/** Ordretilgang og ordrer per produkt (bare for produktene i duplikatgruppene). */
async function loadOrders(shopifyGql, sleep) {
  const scopes = (await shopifyGql(`{ currentAppInstallation { accessScopes { handle } } }`)).currentAppInstallation.accessScopes.map((x) => x.handle);
  const access = orderAccess(scopes);
  if (access === "ingen") return { access, counts: null };
  const run = await shopifyGql(`mutation ($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id } userErrors { message } } }`, { q: ORDERS_BY_PRODUCT_BULK_QUERY });
  const opId = run.bulkOperationRunQuery.bulkOperation?.id;
  if (!opId) throw new Error(`Ordrespørringen startet ikke: ${JSON.stringify(run.bulkOperationRunQuery.userErrors)}`);
  let op;
  do {
    await sleep(2000);
    op = (await shopifyGql(`query ($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode url objectCount } } }`, { id: opId })).node;
  } while (["CREATED", "RUNNING", "CANCELING"].includes(op.status));
  if (op.status !== "COMPLETED") throw new Error(`Ordrespørringen endte med ${op.status} (${op.errorCode ?? "ingen feilkode"})`);
  const counter = new OrderCounter();
  if (op.url) for (const line of (await (await fetch(op.url)).text()).split("\n")) counter.add(line);
  return { access, counts: counter.counts };
}

async function shopProducts(shopifyGql) {
  const all = [];
  let cursor = null;
  do {
    const d = await shopifyGql(`query ($c: String) { products(first: 250, after: $c, query: "status:active OR status:draft OR status:archived") { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } } }`, { c: cursor });
    all.push(...d.products.nodes);
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);
  return all.map((p) => ({ ...p, forfatter: parseList(p.forfatter?.value), orders: null }));
}

function parseList(v) {
  try { const x = JSON.parse(v ?? "[]"); return Array.isArray(x) ? x : []; } catch { return []; }
}

// ── Rapport ────────────────────────────────────────────────────────────────
function buildReport(products, source, access = "ingen") {
  const groups = groupDuplicates(products).map(({ isbn, products: ps }) => {
    const d = decideDuplicate(ps, access);
    const keep = ps.find((p) => p.id === d.keepId) ?? null;
    return {
      isbn, decision: d.reason, flags: d.flags, automatic: d.automatic,
      keepId: d.keepId, deleteIds: d.deleteIds,
      products: ps.map((p) => ({
        id: p.id, handle: p.handle, title: p.title, status: p.status, createdAt: p.createdAt, productType: p.productType,
        tags: p.tags, orders: p.orders === null ? "ukjent" : p.orders,
        action: !d.automatic ? "Eirik avgjør" : p.id === d.keepId ? "beholdes" : "slettes (av Eirik)",
        mergeTags: keep && p.id !== d.keepId ? tagsToMerge(keep, p) : [],
      })),
    };
  });
  return { source, createdAt: new Date().toISOString(), totalProducts: products.length, orderAccess: access, orderWarning: orderAccessWarning(access), groups };
}

function printReport(r) {
  if (r.orderWarning) console.log(`\n⚠ ORDRER: ${r.orderWarning}`);
  console.log(`\nKilde: ${r.source}. Produkter: ${r.totalProducts}. ISBN med flere produkter: ${r.groups.length}. Ordretilgang: ${r.orderAccess}\n`);
  for (const g of r.groups) {
    console.log(`${g.isbn}  → ${g.decision}${g.flags.length ? `  [${g.flags.join(", ")}]` : ""}`);
    for (const p of g.products) {
      console.log(`   ${p.action.padEnd(18)} ${p.status.padEnd(8)} ${(p.createdAt ?? "dato ukjent").slice(0, 10)}  ordrer: ${String(p.orders).padEnd(6)} ${p.handle}`);
      console.log(`   ${"".padEnd(18)} tagger: ${p.tags.join(", ") || "-"}`);
      if (p.mergeTags.length) console.log(`   ${"".padEnd(18)} legges til på det som beholdes: ${p.mergeTags.join(", ")}`);
    }
  }
}

function writeReport(r, name) {
  const dir = join(process.cwd(), "scripts", "out");
  const json = join(dir, `duplikater-${name}.json`);
  writeFileSync(json, JSON.stringify(r, null, 2));
  const lines = ["isbn,beslutning,merknader,handling,status,opprettet,handle,tittel,tagger,ordrer,legges_til"];
  for (const g of r.groups) for (const p of g.products) {
    lines.push([g.isbn, g.decision, g.flags.join("; "), p.action, p.status, p.createdAt ?? "", p.handle, p.title, p.tags.join("; "), p.orders, p.mergeTags.join("; ")].map(csvCell).join(","));
  }
  if (r.orderWarning) lines.unshift(csvCell(`ORDRER: ${r.orderWarning}`));
  writeFileSync(json.replace(/\.json$/, ".csv"), "﻿" + lines.join("\n"));
  console.log(`\nRapport: ${json} (+ .csv)\n`);
  return json;
}

// ── Kjøring ────────────────────────────────────────────────────────────────
if (MODE === "report" && CSV) {
  const r = buildReport(productsFromCsv(CSV), `CSV ${CSV}`);
  printReport(r);
  writeReport(r, "csv");
  process.exit(0);
}

const { shopifyGql, testShop, fail, sleep } = await import("./lib/clients.mjs");
const SHOP = testShop();
const reportFile = join(process.cwd(), "scripts", "out", `duplikater-${SHOP.replace(".myshopify.com", "")}.json`);

if (MODE === "report") {
  const products = await shopProducts(shopifyGql);
  const { access, counts } = await loadOrders(shopifyGql, sleep);
  if (counts) for (const p of products) p.orders = counts.get(p.id) ?? 0;
  const r = buildReport(products, SHOP, access);
  printReport(r);
  writeReport(r, SHOP.replace(".myshopify.com", ""));
} else {
  if (!existsSync(reportFile)) fail("Fant ingen rapport. Kjør --report først.");
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const groups = report.groups.filter((g) => g.automatic);

  if (MODE === "merge") {
    let added = 0;
    for (const g of groups) {
      const want = [...new Set(g.products.flatMap((p) => p.mergeTags))];
      if (!want.length) continue;
      // Nåværende tagger rett før skriving (protected.ts)
      const cur = (await shopifyGql(`query ($id: ID!) { product(id: $id) { handle tags } }`, { id: g.keepId })).product;
      if (!cur) { console.log(`  ${g.isbn}: produktet som beholdes finnes ikke`); continue; }
      if (protectedTag(cur.tags)) { console.log(`  ${cur.handle}: ${protectedMessage(cur.tags)}`); continue; }
      const missing = want.filter((t) => !cur.tags.some((c) => c.toLowerCase() === t.toLowerCase()));
      if (!missing.length) { console.log(`  ${cur.handle}: har allerede ${want.join(", ")}`); continue; }
      console.log(`  ${cur.handle}: ${EXECUTE ? "legger til" : "ville lagt til"} ${missing.join(", ")}`);
      if (EXECUTE) {
        const r = await shopifyGql(`mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: g.keepId, tags: missing });
        if (r.tagsAdd.userErrors.length) console.log(`    ✖ ${JSON.stringify(r.tagsAdd.userErrors)}`);
        else added++;
      }
    }
    console.log(`\n${EXECUTE ? `${added} produkter fikk nye tagger.` : "Ingenting endret. Kjør med --execute."}\n`);
  }

  if (MODE === "redirects") {
    let made = 0, waiting = 0;
    for (const g of groups) {
      const keep = (await shopifyGql(`query ($id: ID!) { product(id: $id) { handle tags } }`, { id: g.keepId })).product;
      if (!keep) { console.log(`  ${g.isbn}: produktet som beholdes finnes ikke lenger — hopper over`); continue; }
      for (const id of g.deleteIds) {
        const p = g.products.find((x) => x.id === id);
        const still = (await shopifyGql(`query ($id: ID!) { product(id: $id) { id } }`, { id })).product;
        if (still) { waiting++; console.log(`  ${p.handle}: ikke slettet ennå`); continue; }
        const path = `/products/${p.handle}`, target = `/products/${keep.handle}`;
        const ex = (await shopifyGql(`query ($q: String!) { urlRedirects(first: 5, query: $q) { nodes { id path target } } }`, { q: `path:${path}` })).urlRedirects.nodes.find((n) => n.path === path);
        if (ex) { console.log(`  ${path}: finnes allerede → ${ex.target}`); continue; }
        console.log(`  ${path} → ${target}${EXECUTE ? "" : "  (ville laget)"}`);
        if (EXECUTE) {
          const r = await shopifyGql(`mutation ($r: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $r) { urlRedirect { id } userErrors { field message } } }`, { r: { path, target } });
          if (r.urlRedirectCreate.userErrors.length) console.log(`    ✖ ${JSON.stringify(r.urlRedirectCreate.userErrors)}`);
          else made++;
        }
      }
    }
    console.log(`\n${EXECUTE ? `${made} videresendinger laget.` : "Ingenting endret. Kjør med --execute."} ${waiting} duplikater er ikke slettet ennå.\n`);
  }
}
