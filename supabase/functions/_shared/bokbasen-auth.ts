// supabase/functions/_shared/bokbasen-auth.ts
// Felles Bokbasen-innlogging for alle Edge Functions (bokbasen, shopify,
// price-update, availability-check, sjangre-sync). Ikke lag egne kopier.
//
// Legitimasjon: user_settings.bokbasen_client_id + bokbasen_client_secret for
// brukeren (begge må være satt), ellers Supabase-hemmelighetene
// BOKBASEN_CLIENT_ID / BOKBASEN_CLIENT_SECRET. Abonnement:
// user_settings.bokbasen_subscription / BOKBASEN_SUBSCRIPTION, ellers "extended".
//
// Tokenet caches i minnet per klient-ID og fornyes 60 s før det utløper.

const BOKBASEN_AUTH_URL = "https://auth.bokbasen.io/oauth/token";
const BOKBASEN_AUDIENCE = "https://api.bokbasen.io/metadata/";
const TOKEN_REFRESH_MARGIN_S = 60;

/** ONIX-eksport fra metadata-API-et: `${BOKBASEN_ONIX_URL}/<isbn>` eller `?<parametere>`. */
export const BOKBASEN_ONIX_URL = "https://api.bokbasen.io/metadata/export/onix/v2";

export interface BokbasenCredentials {
  clientId: string;
  clientSecret: string;
  subscription: string;
}

interface TokenCacheEntry {
  token: string;
  expiry: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

const cacheKey = (c: BokbasenCredentials) => `${c.clientId}:${c.clientSecret}`;

/**
 * Bokbasen-legitimasjon for brukeren, eller serverens hemmeligheter.
 * null hvis ingen av delene er satt.
 */
export async function getBokbasenCredentials(userId: string | null): Promise<BokbasenCredentials | null> {
  if (userId) {
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const res = await fetch(
        `${supabaseUrl}/rest/v1/user_settings?user_id=eq.${userId}&select=bokbasen_client_id,bokbasen_client_secret,bokbasen_subscription&limit=1`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      );
      const s = (await res.json())?.[0];
      if (s?.bokbasen_client_id && s?.bokbasen_client_secret) {
        return {
          clientId: s.bokbasen_client_id,
          clientSecret: s.bokbasen_client_secret,
          subscription: s.bokbasen_subscription || "extended",
        };
      }
    } catch {
      // bruk serverens hemmeligheter
    }
  }
  const clientId = Deno.env.get("BOKBASEN_CLIENT_ID");
  const clientSecret = Deno.env.get("BOKBASEN_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, subscription: Deno.env.get("BOKBASEN_SUBSCRIPTION") || "extended" };
}

/**
 * Tilgangstoken for Bokbasens metadata-API. Tar enten legitimasjon eller en
 * bruker-ID (da hentes legitimasjonen med getBokbasenCredentials).
 * Kaster "Bokbasen auth failed: <status> …" hvis innloggingen avvises.
 */
export async function getBokbasenToken(who: BokbasenCredentials | string | null): Promise<string> {
  const credentials = who !== null && typeof who === "object" ? who : await getBokbasenCredentials(who);
  if (!credentials) throw new Error("Bokbasen auth failed: mangler BOKBASEN_CLIENT_ID / BOKBASEN_CLIENT_SECRET");

  const cached = tokenCache.get(cacheKey(credentials));
  if (cached && Date.now() < cached.expiry) return cached.token;

  const res = await fetch(BOKBASEN_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      audience: BOKBASEN_AUDIENCE,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Bokbasen auth failed: ${res.status} ${(await res.text()).slice(0, 200)}`);

  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache.set(cacheKey(credentials), {
    token: data.access_token,
    expiry: Date.now() + (data.expires_in - TOKEN_REFRESH_MARGIN_S) * 1000,
  });
  return data.access_token;
}

/** Glem cachet token (f.eks. etter HTTP 401 fra ONIX-API-et). Uten argument: alle. */
export function clearBokbasenToken(credentials?: BokbasenCredentials): void {
  if (credentials) tokenCache.delete(cacheKey(credentials));
  else tokenCache.clear();
}
