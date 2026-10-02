#!/usr/bin/env node
// scripts/isbn-definition.mjs
// Gjør metafeltdefinisjonen bok.isbn om til typen «id» i Testbutikk, slik at
// productByIdentifier(identifier: { customId: { namespace: "bok", key: "isbn", value } })
// fungerer. Shopify kan ikke endre typen på en definisjon, så den slettes og
// lages på nytt, og verdiene settes inn igjen fra strekkode/SKU.
//
// KJØRING (fra prosjektmappa), i denne rekkefølgen:
//   node scripts/isbn-definition.mjs --status     # tell og ta vare på verdiene (endrer ingenting)
//   node scripts/isbn-definition.mjs --recreate   # slett definisjonen (med verdier) og lag den med typen id
//                                                 # (--redo: også når den allerede har typen id)
//   node scripts/isbn-definition.mjs --restore    # vis hvilke verdier som vil bli satt (endrer ingenting)
//   node scripts/isbn-definition.mjs --restore --execute   # sett verdiene
//   node scripts/isbn-definition.mjs --verify     # slå opp alle med customId og sammenlign
//
// Sikkerhetskopi: scripts/out/bok-isbn-backup-<butikk>.json (git-ignorert).
// --recreate krever en sikkerhetskopi som er under 2 timer gammel.
// --restore venter til den nye definisjonen er ALL_VALID og uten verdier (de
// gamle slettes asynkront). Ble verdiene satt for tidlig i Testbutikk 2026-10-01,
// hang Shopifys unik-migrering («Metafields have not completed migrating»).
// --force hopper over denne kontrollen.
// Kjører bare mot Testbutikk (se scripts/lib/clients.mjs).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeIsbn } from "../supabase/functions/_shared/handle.js";
import { shopifyGql, testShop, ensureOutDir, fail } from "./lib/clients.mjs";
import { protectedMessage, protectedTag } from "../supabase/functions/_shared/protected.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const MODE = ["status", "recreate", "restore", "verify"].find(flag);
if (!MODE) fail("Velg --status, --recreate, --restore eller --verify.");
const EXECUTE = flag("execute");
const BACKUP_MAX_AGE_H = 2;

const SHOP = testShop();
const backupFile = join(ensureOutDir(), `bok-isbn-backup-${SHOP.replace(".myshopify.com", "")}.json`);

// ── GraphQL ────────────────────────────────────────────────────────────────
const DEFINITION_QUERY = `
query bokIsbnDefinition {
  metafieldDefinitions(first: 5, ownerType: PRODUCT, namespace: "bok", key: "isbn") {
    nodes {
      id name namespace key description pinnedPosition metafieldsCount validationStatus
      type { name }
      access { admin storefront customerAccount }
      capabilities {
        adminFilterable { enabled }
        smartCollectionCondition { enabled }
        uniqueValues { enabled }
      }
      validations { name value }
    }
  }
}`;

const PRODUCTS_QUERY = `
query bokIsbnProducts($cursor: String) {
  products(first: 250, after: $cursor, query: "status:active OR status:draft OR status:archived") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status tags
      bokIsbn: metafield(namespace: "bok", key: "isbn") { id value type }
      variants(first: 1) { nodes { barcode sku } }
    }
  }
}`;

const DEFINITION_DELETE = `
mutation bokIsbnDelete($id: ID!) {
  metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: true) {
    deletedDefinitionId
    userErrors { field message code }
  }
}`;

const DEFINITION_CREATE = `
mutation bokIsbnCreate($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id name type { name } access { storefront } capabilities { uniqueValues { enabled } } }
    userErrors { field message code }
  }
}`;

const METAFIELDS_SET = `
mutation bokIsbnSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id ownerType value }
    userErrors { field message code }
  }
}`;

const PRODUCT_BY_CUSTOM_ID = `
query bokIsbnLookup($isbn: String!) {
  productByIdentifier(identifier: { customId: { namespace: "bok", key: "isbn", value: $isbn } }) { id handle }
}`;

// ── Hjelpere ───────────────────────────────────────────────────────────────
async function getDefinition() {
  const nodes = (await shopifyGql(DEFINITION_QUERY)).metafieldDefinitions.nodes;
  if (nodes.length > 1) fail("Fant flere definisjoner for bok.isbn. Stopper.");
  return nodes[0] ?? null;
}

async function fetchAllProducts() {
  const all = [];
  let cursor = null;
  do {
    const data = await shopifyGql(PRODUCTS_QUERY, { cursor });
    all.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

/** Eksakt ISBN-13 i feltet: bare de 13 sifrene, og gyldig etter normalizeIsbn. */
function exactIsbn13(raw) {
  const v = (raw ?? "").trim();
  return /^\d{13}$/.test(v) && normalizeIsbn(v) === v ? v : null;
}

/** ISBN som skal settes: strekkode, ellers SKU. Ulike gyldige verdier gir konflikt. */
function isbnFromVariant(product) {
  const v = product.variants?.nodes?.[0] ?? {};
  const fromBarcode = exactIsbn13(v.barcode);
  const fromSku = exactIsbn13(v.sku);
  if (fromBarcode && fromSku && fromBarcode !== fromSku) return { isbn: null, note: `strekkode ${fromBarcode} ≠ SKU ${fromSku}` };
  return { isbn: fromBarcode ?? fromSku, source: fromBarcode ? "strekkode" : fromSku ? "SKU" : null };
}

async function waitFor(label, check, maxMinutes = 30) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > maxMinutes * 60_000) fail(`Ventet ${maxMinutes} min uten at ${label}. Prøv igjen senere.`);
    process.stdout.write(`
  Venter til ${label} … ${Math.round((Date.now() - start) / 1000)} s`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log(`
  OK: ${label}`);
}

function readBackup() {
  if (!existsSync(backupFile)) fail(`Fant ingen sikkerhetskopi (${backupFile}). Kjør --status først.`);
  return JSON.parse(readFileSync(backupFile, "utf8"));
}

// ── Moduser ────────────────────────────────────────────────────────────────
async function status() {
  const definition = await getDefinition();
  const products = await fetchAllProducts();
  const withValue = products.filter((p) => p.bokIsbn?.value);
  writeFileSync(backupFile, JSON.stringify({
    shop: SHOP,
    createdAt: new Date().toISOString(),
    definition,
    values: withValue.map((p) => ({ id: p.id, handle: p.handle, title: p.title, status: p.status, value: p.bokIsbn.value, type: p.bokIsbn.type })),
    products: products.map((p) => ({ id: p.id, handle: p.handle, barcode: p.variants?.nodes?.[0]?.barcode ?? null, sku: p.variants?.nodes?.[0]?.sku ?? null })),
  }, null, 2));

  console.log(`\nButikk: ${SHOP}`);
  if (definition) {
    console.log(`Definisjon: ${definition.name} (${definition.namespace}.${definition.key}), type ${definition.type.name}`);
    console.log(`  storefront: ${definition.access.storefront}, unik: ${definition.capabilities.uniqueValues.enabled}, festet: ${definition.pinnedPosition != null}`);
    console.log(`  metafieldsCount: ${definition.metafieldsCount}`);
  } else {
    console.log("Definisjon: finnes ikke");
  }
  console.log(`Produkter totalt: ${products.length}`);
  console.log(`Med bok.isbn: ${withValue.length}`);
  const types = Object.entries(withValue.reduce((m, p) => ((m[p.bokIsbn.type] = (m[p.bokIsbn.type] ?? 0) + 1), m), {}));
  console.log(`Typer på verdiene: ${types.map(([t, n]) => `${t}: ${n}`).join(", ") || "-"}`);
  const invalid = withValue.filter((p) => exactIsbn13(p.bokIsbn.value) !== p.bokIsbn.value);
  if (invalid.length) console.log(`Verdier som ikke er eksakt ISBN-13: ${invalid.map((p) => `${p.handle}=${p.bokIsbn.value}`).join(", ")}`);
  console.log(`\nSikkerhetskopi: ${backupFile}\n`);
}

async function recreate() {
  const backup = readBackup();
  const ageH = (Date.now() - Date.parse(backup.createdAt)) / 36e5;
  if (ageH > BACKUP_MAX_AGE_H) fail(`Sikkerhetskopien er ${ageH.toFixed(1)} timer gammel. Kjør --status på nytt.`);
  const current = await getDefinition();
  if (current?.type.name === "id" && !flag("redo")) fail("bok.isbn har allerede typen id. Ingenting å gjøre (--redo lager den på nytt likevel).");
  if (current && current.id !== backup.definition?.id) fail("Definisjonen i butikken er ikke den samme som i sikkerhetskopien. Kjør --status på nytt.");
  // Finnes ikke definisjonen (slettet i en kjøring der opprettelsen feilet), lages den fra sikkerhetskopien
  const old = current ?? backup.definition;
  if (!old) fail("Fant ingen definisjon i butikken eller i sikkerhetskopien.");

  // Sletting av definisjonen sletter også verdiene på beskyttede produkter (protected.ts): ikke lov
  if (current) {
    const hit = (await fetchAllProducts()).filter((p) => p.bokIsbn && protectedTag(p.tags));
    if (hit.length) fail(`${hit.length} beskyttede produkter har bok.isbn, og verdien ville blitt slettet: ${hit.slice(0, 10).map((p) => `${p.handle} (${protectedMessage(p.tags)})`).join(", ")}`);
  }

  if (current) {
    console.log(`\nSletter ${old.namespace}.${old.key} (type ${old.type.name}, ${old.metafieldsCount} verdier) …`);
    const del = (await shopifyGql(DEFINITION_DELETE, { id: old.id })).metafieldDefinitionDelete;
    if (del.userErrors.length) fail(`Sletting feilet: ${JSON.stringify(del.userErrors)}`);
    console.log(`  Slettet: ${del.deletedDefinitionId}`);
  }

  // De gamle verdiene slettes i bakgrunnen. Lages definisjonen før de er borte,
  // kan Shopifys unik-migrering henge (Testbutikk 2026-10-01).
  await waitFor("gamle verdier slettet", async () => (await fetchAllProducts()).every((p) => !p.bokIsbn));

  const definition = {
    name: old.name,
    namespace: old.namespace,
    key: old.key,
    description: old.description,
    ownerType: "PRODUCT",
    type: "id",
    access: { storefront: old.access.storefront },
    capabilities: {
      uniqueValues: { enabled: true },
      ...(old.capabilities.adminFilterable.enabled ? { adminFilterable: { enabled: true } } : {}),
    },
    pin: old.pinnedPosition != null,
  };
  console.log(`Lager på nytt med typen id …`);
  const created = (await shopifyGql(DEFINITION_CREATE, { definition })).metafieldDefinitionCreate;
  if (created.userErrors.length) {
    fail(`Oppretting feilet: ${JSON.stringify(created.userErrors)}\nDefinisjonen er slettet. Gamle innstillinger ligger i ${backupFile} (definition); --recreate kan kjøres igjen.`);
  }
  console.log(`  Laget: ${JSON.stringify(created.createdDefinition)}`);
  await waitFor("definisjonen er ALL_VALID", async () => (await getDefinition())?.validationStatus === "ALL_VALID");
  console.log(`\nNeste steg: node scripts/isbn-definition.mjs --restore\n`);
}

async function restore() {
  const backup = readBackup();
  const definition = await getDefinition();
  if (definition?.type.name !== "id") fail("bok.isbn har ikke typen id ennå. Kjør --recreate først.");
  if (EXECUTE && !flag("force") && (definition.validationStatus !== "ALL_VALID" || definition.metafieldsCount > 0)) {
    fail(`Definisjonen er ${definition.validationStatus} med ${definition.metafieldsCount} verdier. Vent til den er ALL_VALID med 0 verdier (de gamle slettes i bakgrunnen), eller bruk --force.`);
  }

  const products = await fetchAllProducts();
  const backedUp = new Map(backup.values.map((v) => [v.id, v.value]));
  const rows = [];
  const skipped = [];
  const seen = new Map();
  for (const p of products) {
    const before = backedUp.get(p.id) ?? null;
    if (protectedTag(p.tags)) { skipped.push({ handle: p.handle, before, note: protectedMessage(p.tags) }); continue; }
    const { isbn, source, note } = isbnFromVariant(p);
    if (!isbn) {
      if (before || note) skipped.push({ handle: p.handle, before, note: note ?? "ingen eksakt ISBN-13 i strekkode/SKU" });
      continue;
    }
    if (seen.has(isbn)) { skipped.push({ handle: p.handle, before, note: `samme ISBN som ${seen.get(isbn)}` }); continue; }
    seen.set(isbn, p.handle);
    if (p.bokIsbn?.value === isbn) continue; // allerede satt
    rows.push({ id: p.id, handle: p.handle, isbn, source, before, changed: before != null && before !== isbn });
  }

  console.log(`\nSkal settes: ${rows.length}  (fra strekkode: ${rows.filter((r) => r.source === "strekkode").length}, fra SKU: ${rows.filter((r) => r.source === "SKU").length})`);
  console.log(`Hadde bok.isbn før: ${backup.values.length}. Av radene over hadde ${rows.filter((r) => r.before).length} verdi før, ${rows.filter((r) => !r.before).length} er nye.`);
  for (const r of rows.filter((r) => r.changed)) console.log(`  ! ${r.handle}: før ${r.before}, nå ${r.isbn}`);
  for (const s of skipped) console.log(`  – hoppes over: ${s.handle}${s.before ? ` (hadde ${s.before})` : ""}: ${s.note}`);
  if (!EXECUTE) return console.log("\nIngenting endret. Kjør med --execute for å sette verdiene.\n");

  let ok = 0;
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25);
    const res = (await shopifyGql(METAFIELDS_SET, {
      metafields: batch.map((r) => ({ ownerId: r.id, namespace: "bok", key: "isbn", type: "id", value: r.isbn })),
    })).metafieldsSet;
    if (res.userErrors.length) console.log(`  ✖ ${JSON.stringify(res.userErrors)}`);
    ok += res.metafields?.length ?? 0;
  }
  console.log(`\nSatt: ${ok} av ${rows.length}\n`);
}

async function verify() {
  const products = await fetchAllProducts();
  const withValue = products.filter((p) => p.bokIsbn?.value);
  let hit = 0;
  const misses = [];
  for (const p of withValue) {
    const found = (await shopifyGql(PRODUCT_BY_CUSTOM_ID, { isbn: p.bokIsbn.value })).productByIdentifier;
    if (found?.id === p.id) hit++;
    else misses.push(`${p.handle} (${p.bokIsbn.value}) → ${found?.handle ?? "ingen"}`);
  }
  console.log(`\nMed bok.isbn: ${withValue.length}. Funnet med customId: ${hit}.`);
  for (const m of misses) console.log(`  ✖ ${m}`);
  console.log();
}

await { status, recreate, restore, verify }[MODE]();
