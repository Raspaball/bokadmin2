// supabase/functions/_shared/job-shop.ts
// Butikkstempel på jobber (live-sjekk 1, punkt 3). Hver jobb lagrer butikkdomenet den ble
// startet mot (jobs.shop_domain). Hver puls sammenligner det med den aktive butikken; er den
// byttet (eller stempelet mangler), settes jobben til failed før noe kall til Shopify.
// Regelen står i shop-guard.js (jobShopMismatch, testet i scripts/shop-guard.test.mjs).

import { getShopDomain } from "./shopify.ts";
import { jobShopMismatch } from "./shop-guard.js";

/** Den aktive butikken, slik den lagres i jobs.shop_domain. */
export async function currentShopDomain(): Promise<string> {
  return (await getShopDomain()).trim().toLowerCase();
}

// deno-lint-ignore no-explicit-any
export async function jobShopError(job: any): Promise<string | null> {
  let current = "";
  try { current = await currentShopDomain(); } catch { /* ikke satt: jobShopMismatch gir meldingen */ }
  // Handle-jobbene har hatt butikken i config.shop fra før
  return jobShopMismatch(job?.shop_domain ?? job?.config?.shop, current);
}

/** Stopper jobben (failed) hvis butikken ikke stemmer. Returnerer true når jobben ble stoppet. */
// deno-lint-ignore no-explicit-any
export async function stopIfShopChanged(supabase: any, job: any): Promise<boolean> {
  const err = await jobShopError(job);
  if (!err) return false;
  console.error(`Jobb ${job?.id}: ${err}`);
  await supabase.from("jobs").update({
    status: "failed", error_message: err, completed_at: new Date().toISOString(),
  }).eq("id", job.id);
  return true;
}
