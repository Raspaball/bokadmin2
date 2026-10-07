// supabase/functions/_shared/shop-guard.js
// Sperre mot livebutikken (pakke I del B). Ren ESM, brukes av _shared/shopify.ts (Deno)
// og av scripts/lib/clients.mjs (Node), slik at regelen står ett sted.
//
// Regel: Testbutikk er alltid tillatt. Enhver annen butikk (live) er bare tillatt
// når BEGGE hemmelighetene er satt bevisst:
//   LIVE_SHOP_CONFIRMED = butikkdomenet skrevet ut i sin helhet (må være lik SHOPIFY_SHOP_DOMAIN)
//   LIVE_SHOP_UNTIL     = tidspunkt (ISO 8601) som ligger fram i tid, høyst 24 timer unna
// Vinduet utløper av seg selv: glemmer man å skru av, stopper alle Shopify-kall etter
// høyst 24 timer. Fjern begge hemmelighetene for å lukke med en gang.

export const SAFE_SHOPS = ["testbutikk-9434.myshopify.com"];
export const MAX_LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ domain?: string|null, confirmed?: string|null, until?: string|null, now?: number }} p
 * @returns {{ ok: boolean, live: boolean, reason?: string, expiresAt?: string }}
 */
export function checkShopAllowed({ domain, confirmed, until, now = Date.now() }) {
  const d = String(domain ?? "").trim().toLowerCase();
  if (!d) return { ok: false, live: false, reason: "Butikkdomenet er ikke satt." };
  if (SAFE_SHOPS.includes(d)) return { ok: true, live: false };

  const fix = `Sperret: ${d} er ikke Testbutikk.`;
  if (String(confirmed ?? "").trim().toLowerCase() !== d) {
    return { ok: false, live: true, reason: `${fix} Mangler LIVE_SHOP_CONFIRMED=${d} (hele domenet, som bekreftelse).` };
  }
  const t = Date.parse(String(until ?? ""));
  if (!Number.isFinite(t)) return { ok: false, live: true, reason: `${fix} Mangler LIVE_SHOP_UNTIL (ISO-tidspunkt, høyst 24 timer fram).` };
  if (t <= now) return { ok: false, live: true, reason: `${fix} LIVE_SHOP_UNTIL (${until}) er utløpt.` };
  if (t - now > MAX_LIVE_WINDOW_MS) return { ok: false, live: true, reason: `${fix} LIVE_SHOP_UNTIL ligger mer enn 24 timer fram.` };
  return { ok: true, live: true, expiresAt: new Date(t).toISOString() };
}
