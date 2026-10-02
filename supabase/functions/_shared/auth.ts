// supabase/functions/_shared/auth.ts
// Hvem som kaller en Edge Function. Funksjonene deployes med --no-verify-jwt,
// så tokenet MÅ verifiseres her: getCaller() spør Supabase Auth (auth.getUser),
// som sjekker signatur og utløp. Les aldri «sub» eller «email» rett fra tokenet;
// et forfalsket token ville da gitt tilgang som en annen bruker.
//
// Anon- og service-nøkkelen er ikke brukere: de gir userId = null uten oppslag.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

export interface Caller {
  userId: string | null;
  email: string | null;
}

const NOBODY: Caller = { userId: null, email: null };

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** «role» fra tokenet, bare for å slippe et unødvendig oppslag for nøklene (aldri til tilgang). */
function unverifiedRole(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))).role ?? null;
  } catch {
    return null;
  }
}

/** Verifisert bruker for forespørselen, eller { userId: null } (anon/service/ugyldig/utløpt). */
export async function getCaller(req: Request): Promise<Caller> {
  const token = bearer(req);
  if (!token) return NOBODY;
  const role = unverifiedRole(token);
  if (role === "anon" || role === "service_role") return NOBODY;
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return NOBODY;
    return { userId: data.user.id, email: data.user.email ?? null };
  } catch {
    return NOBODY;
  }
}

/**
 * user_id i body fra pg_cron (run-scheduled-tasks kaller med anon-nøkkelen).
 * Godtas bare når kalleren ikke er en verifisert bruker, og bare hvis brukeren
 * har en aktiv planlagt oppgave av denne typen. Ellers null.
 */
// deno-lint-ignore no-explicit-any
export async function scheduledUserId(supabase: any, bodyUserId: unknown, taskType: "price_update" | "availability_check"): Promise<string | null> {
  if (typeof bodyUserId !== "string" || !/^[0-9a-f-]{36}$/i.test(bodyUserId)) return null;
  const { data } = await supabase.from("scheduled_tasks").select("id")
    .eq("user_id", bodyUserId).eq("type", taskType).eq("enabled", true).limit(1);
  return data?.length ? bodyUserId : null;
}
