// scripts/lib/clients.mjs
// Felles oppsett for lokale engangsskript: nøkler fra scripts/.env.local
// (git-ignorert), Shopify Admin GraphQL og Bokbasen ONIX (bare lesing).
//
// Edge Functions bruker supabase/functions/_shared/shopify.ts — dette er bare
// for skript som kjøres fra Eiriks maskin.

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const API_VERSION = "2026-07"; // samme som supabase/functions/_shared/shopify.ts
import { checkShopAllowed, SAFE_SHOPS } from "../../supabase/functions/_shared/shop-guard.js";

export const SAFE_STORES = SAFE_SHOPS;

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const outDir = join(scriptsDir, "out");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(join(scriptsDir, ".env.local"));

export function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

export function ensureOutDir() {
  mkdirSync(outDir, { recursive: true });
  return outDir;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Shopify ────────────────────────────────────────────────────────────────

/**
 * Butikken fra SHOPIFY_SHOP_DOMAIN. Stopper hvis det ikke er Testbutikk, med mindre
 * enableLive() er kalt (bare skriptene som er laget for live, pakke I del B).
 */
export function testShop() {
  if (liveMode) return liveMode.shop;
  const shop = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
  if (!shop || !process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
    fail("Mangler SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID eller SHOPIFY_CLIENT_SECRET (scripts/.env.local).");
  }
  if (!SAFE_STORES.includes(shop)) fail(`${shop} er ikke Testbutikk. Stopper.`);
  return shop;
}

// ── Live (pakke I del B) ────────────────────────────────────────────────────
// SHOPIFY_* i .env.local peker alltid på Testbutikk. Live har egne variabler
// (LIVE_SHOPIFY_SHOP_DOMAIN + enten LIVE_SHOPIFY_ACCESS_TOKEN eller
// LIVE_SHOPIFY_CLIENT_ID/SECRET) og slås bare på når skriptet kaller enableLive() OG
// kommandolinjen har både --live og --bekreft-butikk <hele domenet>. Mutasjoner er
// forbudt, bortsett fra de skriptet navngir i allowedMutations (bulkOperationRunQuery
// er en lese-mutasjon og er alltid tillatt).
let liveMode = null;

export function enableLive({ allowedMutations = [] } = {}) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--bekreft-butikk");
  const confirmed = i >= 0 ? args[i + 1] : "";
  if (!args.includes("--live")) fail("Dette skriptet kjører mot live bare med --live --bekreft-butikk <hele domenet>.");
  const shop = (process.env.LIVE_SHOPIFY_SHOP_DOMAIN || "").trim();
  if (!shop) fail("Mangler LIVE_SHOPIFY_SHOP_DOMAIN (scripts/.env.local).");
  if (SAFE_STORES.includes(shop)) fail("LIVE_SHOPIFY_SHOP_DOMAIN er Testbutikk. Kjør uten --live.");
  const check = checkShopAllowed({ domain: shop, confirmed, until: new Date(Date.now() + 3600e3).toISOString() });
  if (!check.ok) fail(`${check.reason} Skriv --bekreft-butikk ${shop}`);
  if (!process.env.LIVE_SHOPIFY_ACCESS_TOKEN && !(process.env.LIVE_SHOPIFY_CLIENT_ID && process.env.LIVE_SHOPIFY_CLIENT_SECRET)) {
    fail("Mangler LIVE_SHOPIFY_ACCESS_TOKEN eller LIVE_SHOPIFY_CLIENT_ID/LIVE_SHOPIFY_CLIENT_SECRET.");
  }
  liveMode = { shop, allowedMutations: ["bulkOperationRunQuery", ...allowedMutations] };
  console.log(`⚠ LIVE: ${shop} (mutasjoner tillatt: ${allowedMutations.join(", ") || "ingen, bare lesing"})`);
  return shop;
}

export const isLive = () => liveMode !== null;

const WRITE_NAME = /\b([a-z]\w*(?:Create|Update|Delete|Set|Add|Remove|Publish|Unpublish|Run|Cancel|Upsert|Reorder|Redirect|Migrate|Archive))\s*\(/g;
function assertAllowedOperation(query) {
  if (!liveMode || !/\bmutation\b/.test(query)) return;
  for (const m of query.matchAll(WRITE_NAME)) {
    if (!liveMode.allowedMutations.includes(m[1])) throw new Error(`Live: mutasjonen ${m[1]} er ikke tillatt i dette skriptet.`);
  }
}

let shopToken = null;
async function getShopToken(shop) {
  if (shopToken) return shopToken;
  if (liveMode && process.env.LIVE_SHOPIFY_ACCESS_TOKEN) return (shopToken = process.env.LIVE_SHOPIFY_ACCESS_TOKEN);
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: liveMode ? process.env.LIVE_SHOPIFY_CLIENT_ID : process.env.SHOPIFY_CLIENT_ID,
      client_secret: liveMode ? process.env.LIVE_SHOPIFY_CLIENT_SECRET : process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const text = await res.text();
  if (!res.ok) fail(`Kunne ikke hente Shopify-nøkkel (HTTP ${res.status}).\n${text.slice(0, 300)}`);
  shopToken = JSON.parse(text).access_token;
  return shopToken;
}

/** Kjører en GraphQL-operasjon mot Testbutikk. Returnerer `data`, kaster ved GraphQL-feil. */
export async function shopifyGql(query, variables = {}, attempt = 0) {
  const shop = testShop();
  assertAllowedOperation(query);
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getShopToken(shop) },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && attempt === 0) { shopToken = null; return shopifyGql(query, variables, 1); }
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
  if (throttled && attempt < 5) { await sleep(1000 * 2 ** attempt); return shopifyGql(query, variables, attempt + 1); }
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

// ── Bokbasen (bare lesing) ─────────────────────────────────────────────────

let bokbasenToken = null;
async function getBokbasenToken() {
  if (bokbasenToken) return bokbasenToken;
  if (!process.env.BOKBASEN_CLIENT_ID || !process.env.BOKBASEN_CLIENT_SECRET) {
    fail("Mangler BOKBASEN_CLIENT_ID eller BOKBASEN_CLIENT_SECRET (scripts/.env.local).");
  }
  const res = await fetch("https://auth.bokbasen.io/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.BOKBASEN_CLIENT_ID,
      client_secret: process.env.BOKBASEN_CLIENT_SECRET,
      audience: "https://api.bokbasen.io/metadata/",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) fail(`Bokbasen-innlogging feilet (HTTP ${res.status}).`);
  bokbasenToken = (await res.json()).access_token;
  return bokbasenToken;
}

/** Rå ONIX-XML for ett ISBN (samme URL som Edge Functions bruker). null ved 404. */
export async function fetchOnixXml(isbn) {
  const res = await fetch(`https://api.bokbasen.io/metadata/export/onix/v2/${isbn}`, {
    headers: { Authorization: `Bearer ${await getBokbasenToken()}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Bokbasen HTTP ${res.status} for ${isbn}`);
  return res.text();
}
