// supabase/functions/_shared/shopify.ts
// Felles Shopify-klient for alle Edge Functions.
//
// Bokadmin 2.0 bruker en Dev Dashboard-app med client credentials grant:
// det finnes ingen fast shpat_-nøkkel. Tilgangsnøkkelen hentes med
// SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET, gjelder i 24 timer og fornyes her.
// Butikk og nøkler kommer kun fra Supabase-hemmelighetene
// SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID og SHOPIFY_CLIENT_SECRET.
//
// SHOPIFY_API_VERSION står kun her. Ikke definer den lokalt i funksjonene.

export const SHOPIFY_API_VERSION = "2026-07";

// Forny nøkkelen 5 minutter før den utløper
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_THROTTLE_RETRIES = 3;

interface TokenCacheEntry {
  token: string;
  expiry: number;
}

let tokenCache: TokenCacheEntry | null = null;
// Jobbene kaller Shopify 10 i parallell — del ett pågående token-kall i stedet
// for å sende 10 samtidige forespørsler ved kald start.
let pendingToken: Promise<string> | null = null;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Mangler Supabase-hemmeligheten ${name}`);
  return value;
}

export function getShopDomain(): string {
  return requireEnv("SHOPIFY_SHOP_DOMAIN");
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

async function requestAccessToken(): Promise<string> {
  const res = await fetch(`https://${getShopDomain()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("SHOPIFY_CLIENT_ID"),
      client_secret: requireEnv("SHOPIFY_CLIENT_SECRET"),
      grant_type: "client_credentials",
    }),
  });
  // Samme "Shopify HTTP <status>"-format som GraphQL-feil, slik at jobbenes
  // 401/403 → failed-sjekk også fanger ugyldige app-nøkler.
  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: token-forespørsel feilet: ${describeTokenError(await res.text())}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache = {
    token: data.access_token,
    expiry: Date.now() + data.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS,
  };
  return data.access_token;
}

export async function getShopifyAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiry) return tokenCache.token;
  if (!pendingToken) {
    pendingToken = requestAccessToken().finally(() => { pendingToken = null; });
  }
  return pendingToken;
}

export function clearShopifyTokenCache(): void {
  tokenCache = null;
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
  const url = `https://${getShopDomain()}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  let throttleAttempt = 0;
  let tokenRefreshed = false;

  while (true) {
    const accessToken = await getShopifyAccessToken();
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
      clearShopifyTokenCache();
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
