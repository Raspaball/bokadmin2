// supabase/functions/_shared/protected-load.ts
// Laster produktene i de beskyttede manuelle samlingene (protected.ts) med
// Edge-funksjonenes Shopify-klient. Kalles ved start av hver jobbpuls og hvert
// kall som skriver til Shopify. Finnes ikke samlingen, kaster den: da stopper jobben.

import { shopifyGraphQL } from "./shopify.ts";
import { loadProtectedMembers } from "./protected.ts";

let loadedAt = 0;

/** Laster lista på nytt når den er eldre enn `maxAgeMs` (0 = alltid). */
export async function ensureProtectedMembers(maxAgeMs = 0): Promise<void> {
  if (loadedAt && Date.now() - loadedAt < maxAgeMs) return;
  await loadProtectedMembers(async (query, variables) => (await shopifyGraphQL(query, variables ?? {})).data);
  loadedAt = Date.now();
}
