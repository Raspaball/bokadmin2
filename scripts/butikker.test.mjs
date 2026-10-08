// Butikker i Innstillinger (live-sjekk 1, Del 2): statiske kontroller av at Client secret aldri
// går tilbake til nettleseren, at nøkkelbufferen er per butikk, og at alle Shopify-kall går via
// den aktive butikken. Reglene for bytte (jobb kjører, bekreftelse, 24 t, administrator) ligger
// i databasefunksjonen shop_switch og testes med SQL (se oppgaver/live-sjekk-1.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const shopifyTs = read("supabase/functions/_shared/shopify.ts");
const shopifyFn = read("supabase/functions/shopify/index.ts");
const butikker = read("src/app/components/Butikker.tsx");
const api = read("src/app/utils/api.ts");

function* files(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(f)) yield p;
  }
}

test("Client secret leses fra Vault bare i shopify.ts", () => {
  const users = [...files(join(root, "supabase/functions"))].filter((f) => /shop_secret_get|readProfileSecret/.test(readFileSync(f, "utf8")));
  assert.deepEqual(users.map((f) => f.replace(root, "").replace(/\\/g, "/")), ["supabase/functions/_shared/shopify.ts"]);
});

test("getActiveShop() returnerer aldri secret", () => {
  assert.match(shopifyTs, /const \{ secret: _secret, \.\.\.shop \} = await resolveShop\(\);\s*return shop;/);
});

test("/shops svarer bare med secretSaved (sant/usant), aldri secret eller secret_id", () => {
  const block = shopifyFn.slice(shopifyFn.indexOf("async function handleShops"), shopifyFn.indexOf("// ── Main handler"));
  assert.match(block, /secretSaved: !!p\.secret_id/);
  assert.doesNotMatch(block, /return \{[^}]*\bsecret(_id)?:/);
  assert.match(block, /return \{ ok: true, secretSaved: true \};/);
  // Feilmeldinger fra databasen tar bare med meldingen, aldri argumentene
  assert.doesNotMatch(block, /JSON\.stringify\(args\)\)\s*\+/);
});

test("nøkkelbufferen er per butikk og Client ID, og tømmes ved bytte", () => {
  assert.match(shopifyTs, /tokenKey = \(shop: \{ domain: string; clientId: string \}\) => `\$\{shop\.domain\}\|\$\{shop\.clientId\}`/);
  assert.match(shopifyTs, /export function clearShopCache\(\): void \{\s*shopCache = null;\s*tokenCache\.clear\(\);/);
  const sw = shopifyFn.slice(shopifyFn.indexOf('path === "shops/switch"'));
  assert.match(sw.slice(0, 600), /clearShopCache\(\)/);
  const cl = shopifyFn.slice(shopifyFn.indexOf('path === "shops/close"'));
  assert.match(cl.slice(0, 300), /clearShopCache\(\)/);
});

test("hvert GraphQL-kall bruker aktiv butikk og skrivesperren", () => {
  const fn = shopifyTs.slice(shopifyTs.indexOf("export async function shopifyGraphQL"));
  assert.match(fn, /const shop = await resolveShop\(\);\s*writeCheck\(shop, query\);/);
  assert.match(fn, /https:\/\/\$\{shop\.domain\}\/admin\/api/);
});

test("skrivesperre: dobbel lås (databasen ELLER hemmeligheten holder den på)", () => {
  assert.match(shopifyTs, /return shop\.readOnlyDb \|\| liveReadOnly\(Deno\.env\.get\("LIVE_READ_ONLY"\)\);/);
});

test("«Test tilkobling» er bare lesing", () => {
  const t = shopifyTs.slice(shopifyTs.indexOf("export const SHOP_TEST_QUERY"));
  assert.doesNotMatch(t.slice(0, t.indexOf("export async function testShopProfile")), /mutation/);
  assert.match(t, /checkWriteAllowed\(\{ live: true, readOnly: true, query: SHOP_TEST_QUERY \}\)/);
});

test("skjermen: secret er passordfelt, tømmes etter lagring og logges aldri", () => {
  assert.match(butikker, /type="password"/);
  assert.match(butikker, /await shops\.saveSecret\(r\.id, secret\);\s*setSecret\(''\);/);
  assert.doesNotMatch(butikker, /console\./);
  assert.doesNotMatch(api.slice(api.indexOf("export const shops")), /console\./);
});

test("domeneregelen er lik i databasen og på serveren", () => {
  const sql = read("supabase/migrations/20261008151207_shop_profiles.sql");
  assert.match(sql, /domain ~ '\^\[a-z0-9\]\[a-z0-9-\]\*\\\.myshopify\\\.com\$'/);
  const re = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
  for (const ok of ["testbutikk-9434.myshopify.com", "3abc61-58.myshopify.com"]) assert.ok(re.test(ok), ok);
  for (const bad of ["bobokogpapir.no", "https://x.myshopify.com", "x.myshopify.com/", "X.myshopify.com", "-x.myshopify.com"]) assert.ok(!re.test(bad), bad);
  assert.match(shopifyFn, /const SHOP_DOMAIN_RE = \/\^\[a-z0-9\]\[a-z0-9-\]\*\\\.myshopify\\\.com\$\/;/);
});
