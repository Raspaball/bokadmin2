// supabase/functions/_shared/onix-cache.ts
// ONIX-cache (pakke B del 8): rå ONIX per ISBN i tabellen onix_cache, så en
// jobb over hele katalogen ikke betyr ett Bokbasen-kall per bok hver gang.
// Cache yngre enn 7 dager brukes. Ellers hentes ONIX fra Bokbasen og lagres.
// Brukes av book-update og push (shopify). Skriver med service-nøkkelen.

import { BOKBASEN_ONIX_URL, type BokbasenCredentials, getBokbasenToken } from "./bokbasen-auth.ts";

export const ONIX_CACHE_MAX_AGE_DAYS = 7;

function rest(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export interface OnixResult {
  xml: string | null;
  /** "cache" | "bokbasen" | "mangler" (Bokbasen svarte ikke / 404) */
  source: "cache" | "bokbasen" | "mangler";
}

/**
 * Rå ONIX for ISBN-et, fra cachen hvis den er fersk nok, ellers fra Bokbasen.
 * `credentials` er det getBokbasenToken() godtar (bruker-ID eller legitimasjon).
 */
export async function getOnixCached(
  isbn: string,
  credentials: BokbasenCredentials | string | null,
  maxAgeDays = ONIX_CACHE_MAX_AGE_DAYS,
): Promise<OnixResult> {
  try {
    const since = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    const res = await rest(`onix_cache?isbn=eq.${encodeURIComponent(isbn)}&fetched_at=gte.${encodeURIComponent(since)}&select=xml&limit=1`);
    if (res.ok) {
      const xml = (await res.json())?.[0]?.xml as string | undefined;
      if (xml) return { xml, source: "cache" };
    }
  } catch { /* cache utilgjengelig: hent fra Bokbasen */ }

  try {
    const token = await getBokbasenToken(credentials);
    const res = await fetch(`${BOKBASEN_ONIX_URL}/${isbn}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { xml: null, source: "mangler" };
    const xml = await res.text();
    await rest("onix_cache?on_conflict=isbn", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ isbn, xml, fetched_at: new Date().toISOString() }),
    }).catch(() => undefined);
    return { xml, source: "bokbasen" };
  } catch {
    return { xml: null, source: "mangler" };
  }
}
