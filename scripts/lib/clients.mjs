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
export const SAFE_STORES = ["testbutikk-9434.myshopify.com"];

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

/** Butikken fra SHOPIFY_SHOP_DOMAIN. Stopper hvis det ikke er Testbutikk. */
export function testShop() {
  const shop = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
  if (!shop || !process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
    fail("Mangler SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID eller SHOPIFY_CLIENT_SECRET (scripts/.env.local).");
  }
  if (!SAFE_STORES.includes(shop)) fail(`${shop} er ikke Testbutikk. Stopper.`);
  return shop;
}

let shopToken = null;
async function getShopToken(shop) {
  if (shopToken) return shopToken;
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
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
