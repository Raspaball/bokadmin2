// supabase/functions/_shared/price-approvals.ts
// Lagring for sperren mot store prishopp (regelen står i price-guard.ts):
//   - getMaxPriceChangePct: user_settings.max_price_change_pct (standard 30)
//   - recordPendingApproval: én ventende rad per variant i price_approvals
// Brukes av price-update (prisjobben og godkjenning) og shopify (push).
// Skriver med service-nøkkelen; tabellen kan bare leses av innloggede brukere.

import { DEFAULT_MAX_PRICE_CHANGE_PCT, normalizeMaxPct } from "./price-guard.ts";

function rest(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

/** Grensen for brukeren, ellers standard (30). Feil ved oppslag gir standard. */
export async function getMaxPriceChangePct(userId: string | null): Promise<number> {
  if (!userId) return DEFAULT_MAX_PRICE_CHANGE_PCT;
  try {
    const res = await rest(`user_settings?user_id=eq.${userId}&select=max_price_change_pct&limit=1`);
    if (!res.ok) return DEFAULT_MAX_PRICE_CHANGE_PCT;
    return normalizeMaxPct((await res.json())?.[0]?.max_price_change_pct);
  } catch {
    return DEFAULT_MAX_PRICE_CHANGE_PCT;
  }
}

export interface PendingApproval {
  isbn: string;
  title: string | null;
  shopify_product_id: string;
  shopify_variant_id: string;
  old_price: number | null;
  new_price: number;
  change_pct: number | null;
  source: "price-update" | "push";
  job_id?: string | null;
  user_id?: string | null;
}

/**
 * Legger inn (eller oppdaterer) den ventende godkjenningen for varianten.
 * Kaster ved feil, slik at kalleren kan logge det.
 */
export async function recordPendingApproval(row: PendingApproval): Promise<void> {
  const existing = await rest(
    `price_approvals?shopify_variant_id=eq.${encodeURIComponent(row.shopify_variant_id)}&status=eq.pending&select=id&limit=1`,
  );
  if (!existing.ok) throw new Error(`price_approvals: HTTP ${existing.status} ${await existing.text()}`);
  const id = (await existing.json())?.[0]?.id as string | undefined;
  const body = JSON.stringify({ ...row, updated_at: new Date().toISOString() });
  const res = id
    ? await rest(`price_approvals?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body })
    : await rest(`price_approvals`, { method: "POST", headers: { Prefer: "return=minimal" }, body });
  if (!res.ok) throw new Error(`price_approvals: HTTP ${res.status} ${await res.text()}`);
}
