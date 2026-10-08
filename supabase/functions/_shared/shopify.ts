// supabase/functions/_shared/shopify.ts
// Felles Shopify-klient for alle Edge Functions.
//
// Bokadmin 2.0 bruker en Dev Dashboard-app med client credentials grant:
// det finnes ingen fast shpat_-nøkkel. Tilgangsnøkkelen hentes med
// butikkens Client ID + Client secret, gjelder i 24 timer og fornyes her.
// Aktiv butikk velges i Innstillinger («Butikker»: tabellene shop_settings/shop_profiles,
// secret i Vault). Er ingen valgt, brukes hemmelighetene SHOPIFY_SHOP_DOMAIN,
// SHOPIFY_CLIENT_ID og SHOPIFY_CLIENT_SECRET (Testbutikk).
//
// SHOPIFY_API_VERSION står kun her. Ikke definer den lokalt i funksjonene.

export const SHOPIFY_API_VERSION = "2026-07";

import { checkShopAllowed, checkWriteAllowed, liveReadOnly } from "./shop-guard.js";

// Søkefilter for spørringer som skal treffe hele katalogen, også utkast og
// arkiverte produkter: products(query: …) og productsCount(query: …).
// Samme tekst står i _shared/handle-migration.js (ren JS, kan ikke importere TS).
export const ALL_PRODUCT_STATUSES = "status:active OR status:draft OR status:archived";

// Forny nøkkelen 5 minutter før den utløper
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_THROTTLE_RETRIES = 3;
// Aktiv butikk leses fra databasen høyst hvert 15. sekund per funksjonsinstans. Bytte er
// sperret mens jobber kjører, og jobbene har butikkstempel, så 15 s forsinkelse er trygt.
const SHOP_CACHE_MS = 15_000;
const SAFE_SHOP = "testbutikk-9434.myshopify.com";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Mangler Supabase-hemmeligheten ${name}`);
  return value;
}

// ── Aktiv butikk (live-sjekk 1, Del 2) ───────────────────────────────────────
// Kilde: tabellen shop_settings (aktiv profil, «åpen til», skrivesperre) og shop_profiles
// (domene, Client ID). Client secret hentes fra Vault med shop_secret_get (bare service_role).
// Er ingen profil valgt, brukes hemmelighetene SHOPIFY_* som før (Testbutikk), med
// LIVE_SHOP_CONFIRMED / LIVE_SHOP_UNTIL som bekreftelse hvis de peker på en annen butikk.
// Secret forlater aldri denne fila: den returneres ikke, logges ikke og står ikke i feilmeldinger.

export interface ActiveShop {
  domain: string;
  clientId: string;
  source: "profile" | "env";
  profileId: string | null;
  profileName: string | null;
  live: boolean;
  confirmed: string | null;
  until: string | null;
  /** Lås 1 av 2 (shop_settings.read_only). Lås 2 er hemmeligheten LIVE_READ_ONLY. */
  readOnlyDb: boolean;
}
interface ResolvedShop extends ActiveShop { secret: string }

let shopCache: { shop: ResolvedShop; at: number } | null = null;

async function serviceRest(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

/** Leser en butikkprofils Client secret fra Vault. Bare for denne fila og «Test tilkobling». */
export async function readProfileSecret(profileId: string): Promise<string | null> {
  const res = await serviceRest("rpc/shop_secret_get", { method: "POST", body: JSON.stringify({ p_profile_id: profileId }) });
  if (!res.ok) throw new Error(`Kunne ikke lese Client secret (Supabase ${res.status})`);
  const v = await res.json();
  return typeof v === "string" && v ? v : null;
}

async function loadActiveShop(): Promise<ResolvedShop> {
  const res = await serviceRest(
    "shop_settings?select=active_profile_id,confirmed_domain,live_until,read_only,profile:shop_profiles(id,name,domain,client_id)&limit=1",
  );
  // Tabellen finnes ikke ennå (eldre database): bruk hemmelighetene som før
  if (res.status === 404) { await res.body?.cancel(); return envShop(true); }
  if (!res.ok) throw new Error(`Kunne ikke lese aktiv butikk (Supabase ${res.status})`);
  const rows = await res.json() as Array<{
    active_profile_id: string | null; confirmed_domain: string | null; live_until: string | null; read_only: boolean | null;
    profile: { id: string; name: string; domain: string; client_id: string } | null;
  }>;
  const row = rows[0];
  const readOnlyDb = row?.read_only !== false;
  if (!row?.active_profile_id || !row.profile) return envShop(readOnlyDb);

  const secret = await readProfileSecret(row.profile.id);
  if (!secret) throw new Error(`Client secret mangler for butikken ${row.profile.domain}. Lagre den i Innstillinger.`);
  const domain = row.profile.domain.trim().toLowerCase();
  return {
    domain, clientId: row.profile.client_id, secret, source: "profile",
    profileId: row.profile.id, profileName: row.profile.name,
    live: domain !== SAFE_SHOP, confirmed: row.confirmed_domain, until: row.live_until, readOnlyDb,
  };
}

function envShop(readOnlyDb: boolean): ResolvedShop {
  const domain = requireEnv("SHOPIFY_SHOP_DOMAIN").trim().toLowerCase();
  return {
    domain, clientId: requireEnv("SHOPIFY_CLIENT_ID"), secret: requireEnv("SHOPIFY_CLIENT_SECRET"), source: "env",
    profileId: null, profileName: null, live: domain !== SAFE_SHOP,
    confirmed: Deno.env.get("LIVE_SHOP_CONFIRMED") ?? null, until: Deno.env.get("LIVE_SHOP_UNTIL") ?? null, readOnlyDb,
  };
}

async function resolveShop(): Promise<ResolvedShop> {
  if (shopCache && Date.now() - shopCache.at < SHOP_CACHE_MS) return shopCache.shop;
  const shop = await loadActiveShop();
  shopCache = { shop, at: Date.now() };
  return shop;
}

/** Den aktive butikken uten hemmeligheten (til visning, stempel og sperre). */
export async function getActiveShop(): Promise<ActiveShop> {
  const { secret: _secret, ...shop } = await resolveShop();
  return shop;
}

export async function getShopDomain(): Promise<string> {
  return (await resolveShop()).domain;
}

/** Tømmer butikk- og nøkkelbufferen (etter bytte av butikk). */
export function clearShopCache(): void {
  shopCache = null;
  tokenCache.clear();
}

// Shopify svarer med en hel HTML-side når token-kallet feiler. Hent ut den
// lesbare linjen («Oauth error app_not_installed: …»), ellers kort ned teksten.
function describeTokenError(body: string): string {
  const matches = body.match(/Oauth error [^<]+/g) ?? [];
  const detail = matches.sort((a, b) => b.length - a.length)[0];
  const text = detail ?? body.replace(/<[^>]*>/g, " ");
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}

// Sperre mot livebutikken (pakke I del B): Testbutikk er alltid tillatt, alt annet krever
// bekreftet domene og «åpen til» høyst 24 t fram (fra Innstillinger, eller LIVE_SHOP_CONFIRMED /
// LIVE_SHOP_UNTIL når butikken kommer fra hemmelighetene). Reglene står i shop-guard.js.
function shopCheck(shop: ActiveShop): { live: boolean } {
  const check = checkShopAllowed({ domain: shop.domain, confirmed: shop.confirmed, until: shop.until });
  if (!check.ok) throw new Error(`Shopify-sperre: ${check.reason}`);
  return { live: check.live };
}

export async function assertShopAllowed(): Promise<{ live: boolean }> {
  return shopCheck(await resolveShop());
}

// Skrivesperre: i live er den på med mindre BEGGE låsene er av: shop_settings.read_only = false
// OG hemmeligheten LIVE_READ_ONLY = "false". Gjelder alle GraphQL-kall, uansett jobb og modus.
// Bare bulkOperationRunQuery (lesing) slipper gjennom.
export function isReadOnly(shop: Pick<ActiveShop, "readOnlyDb">): boolean {
  return shop.readOnlyDb || liveReadOnly(Deno.env.get("LIVE_READ_ONLY"));
}

function writeCheck(shop: ActiveShop, query: string): void {
  const { live } = shopCheck(shop);
  const check = checkWriteAllowed({ live, readOnly: isReadOnly(shop), query });
  if (!check.ok) throw new Error(`Shopify-sperre: ${check.reason}`);
}

export async function assertWriteAllowed(query: string): Promise<void> {
  writeCheck(await resolveShop(), query);
}

// ── Tilgangsnøkkel (client credentials), bufret per butikk + Client ID ───────
interface TokenCacheEntry { token: string; expiry: number }
const tokenCache = new Map<string, TokenCacheEntry>();
// Jobbene kaller Shopify 10 i parallell — del ett pågående token-kall i stedet
// for å sende 10 samtidige forespørsler ved kald start.
const pendingTokens = new Map<string, Promise<string>>();
const tokenKey = (shop: { domain: string; clientId: string }) => `${shop.domain}|${shop.clientId}`;

async function requestAccessToken(shop: { domain: string; clientId: string; secret: string }): Promise<string> {
  const res = await fetch(`https://${shop.domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: shop.clientId, client_secret: shop.secret, grant_type: "client_credentials" }),
  });
  // Samme "Shopify HTTP <status>"-format som GraphQL-feil, slik at jobbenes
  // 401/403 → failed-sjekk også fanger ugyldige app-nøkler.
  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: token-forespørsel feilet: ${describeTokenError(await res.text())}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache.set(tokenKey(shop), { token: data.access_token, expiry: Date.now() + data.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS });
  return data.access_token;
}

async function tokenFor(shop: ResolvedShop): Promise<string> {
  const key = tokenKey(shop);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiry) return cached.token;
  let pending = pendingTokens.get(key);
  if (!pending) {
    pending = requestAccessToken(shop).finally(() => pendingTokens.delete(key));
    pendingTokens.set(key, pending);
  }
  return await pending;
}

export async function getShopifyAccessToken(): Promise<string> {
  const shop = await resolveShop();
  shopCheck(shop);
  return await tokenFor(shop);
}

export function clearShopifyTokenCache(): void {
  tokenCache.clear();
}

// deno-lint-ignore no-explicit-any
export interface ShopifyGraphQLResponse<T = any> {
  data: T;
  extensions?: Record<string, unknown>;
}

// Kjører en GraphQL Admin API-operasjon mot SHOPIFY_SHOP_DOMAIN.
// - THROTTLED: prøver igjen etter 1 / 2 / 4 s
// - HTTP 401: tømmer token-cachen, henter ny nøkkel og prøver én gang til
// - Andre HTTP-feil: kaster "Shopify HTTP <status>: …"
// - GraphQL-feil: kaster "Shopify GraphQL errors: …"
// Returnerer hele svaret; les resultatet fra `.data`.
// deno-lint-ignore no-explicit-any
export async function shopifyGraphQL<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<ShopifyGraphQLResponse<T>> {
  let throttleAttempt = 0;
  let tokenRefreshed = false;

  while (true) {
    const shop = await resolveShop();
    writeCheck(shop, query);
    const accessToken = await tokenFor(shop);
    const url = `https://${shop.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 && !tokenRefreshed) {
      await res.body?.cancel();
      tokenCache.delete(tokenKey(shop));
      tokenRefreshed = true;
      continue;
    }
    if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);

    const json = await res.json() as {
      data?: T;
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
      extensions?: Record<string, unknown>;
    };

    const isThrottled = json.errors?.some(e => e.extensions?.code === "THROTTLED");
    if (isThrottled) {
      if (throttleAttempt >= MAX_THROTTLE_RETRIES) {
        throw new Error(`Shopify rate limit exceeded after ${MAX_THROTTLE_RETRIES} retries`);
      }
      await new Promise(r => setTimeout(r, 1000 * 2 ** throttleAttempt)); // 1s, 2s, 4s
      throttleAttempt++;
      continue;
    }

    if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
    return { data: json.data as T, extensions: json.extensions };
  }
}

/**
 * Venter til Shopifys kostnadsbudsjett (extensions.cost.throttleStatus) har
 * plass til `needed` poeng, slik at lange jobber holder seg innenfor grensen i
 * stedet for å bli THROTTLED. Gjør ingenting når svaret mangler kostnadsdata.
 */
export async function waitForShopifyBudget(extensions: Record<string, unknown> | undefined, needed: number): Promise<void> {
  const status = (extensions?.cost as { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } | undefined)?.throttleStatus;
  if (!status || typeof status.currentlyAvailable !== "number" || !status.restoreRate) return;
  if (status.currentlyAvailable >= needed) return;
  const seconds = Math.min(20, (needed - status.currentlyAvailable) / status.restoreRate);
  await new Promise((r) => setTimeout(r, Math.ceil(seconds * 1000)));
}

// ── «Test tilkobling» for en profil (Innstillinger) ──────────────────────────
// Bare lesing: én fast spørring, sjekket av skrivesperren som om butikken var live og
// sperret. Krever ikke at butikken er aktiv eller at live-vinduet er åpent, siden ingenting
// kan endres. Secret leses fra Vault her og forlater aldri serveren.
export const SHOP_TEST_QUERY = `{
  shop { name myshopifyDomain primaryDomain { host } }
  productsCount(query: "${ALL_PRODUCT_STATUSES}", limit: null) { count }
  collectionsCount { count }
  currentAppInstallation { accessScopes { handle } }
}`;

export async function testShopProfile(profile: { id: string; domain: string; client_id: string }): Promise<{
  shopName: string | null; shopDomain: string | null; primaryDomain: string | null;
  productsCount: number | null; collectionsCount: number | null; scopes: string[];
}> {
  const check = checkWriteAllowed({ live: true, readOnly: true, query: SHOP_TEST_QUERY });
  if (!check.ok) throw new Error(`Shopify-sperre: ${check.reason}`);
  const secret = await readProfileSecret(profile.id);
  if (!secret) throw new Error("Client secret er ikke lagret ennå.");
  const shop = { domain: profile.domain.trim().toLowerCase(), clientId: profile.client_id, secret };
  const token = await requestAccessToken(shop);
  const res = await fetch(`https://${shop.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: SHOP_TEST_QUERY }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  const d = json.data ?? {};
  return {
    shopName: d.shop?.name ?? null,
    shopDomain: d.shop?.myshopifyDomain ?? null,
    primaryDomain: d.shop?.primaryDomain?.host ?? null,
    productsCount: d.productsCount?.count ?? null,
    collectionsCount: d.collectionsCount?.count ?? null,
    scopes: (d.currentAppInstallation?.accessScopes ?? []).map((a: { handle: string }) => a.handle).sort(),
  };
}

