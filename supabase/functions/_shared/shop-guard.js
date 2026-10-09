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

// ── Skrivesperre mot live (LIVE_READ_ONLY, live-sjekk 1, 07.10.2026) ─────────────────
// Når butikken er live, er skrivesperren PÅ med mindre LIVE_READ_ONLY er satt til nøyaktig
// "false". Med sperren på avvises alle GraphQL-mutasjoner, også i oppdateringsmodus.
// Unntak: bulkOperationRunQuery, som er en mutasjon i navnet, men bare starter en lesing.

export const READ_ONLY_MUTATIONS = ["bulkOperationRunQuery"];

/** Skrivesperren er på for alt annet enn nøyaktig "false". */
export function liveReadOnly(value) {
  return String(value ?? "").trim().toLowerCase() !== "false";
}

// Fjerner kommentarer og tekststrenger, så ord inne i strenger (for eksempel en bulk-spørring
// sendt som variabel) ikke telles.
function stripGraphQL(src) {
  let out = "";
  let i = 0;
  const s = String(src ?? "");
  while (i < s.length) {
    const c = s[i];
    if (c === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (s.startsWith('"""', i)) {
      const end = s.indexOf('"""', i + 3);
      i = end < 0 ? s.length : end + 3; out += ' "" '; continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === "\\") i++; i++; }
      i++; out += ' "" '; continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * Finner operasjonene i et GraphQL-dokument og rotfeltene i hver mutasjon.
 * @returns {{ ok: boolean, mutations: string[][], hasMutation: boolean }}
 *   ok=false betyr at teksten ikke kunne leses sikkert (behandles som skriving).
 */
export function graphQLOperations(query) {
  const s = stripGraphQL(query);
  const mutations = [];
  let depth = 0, paren = 0, head = "", current = null, expectField = false;
  const re = /\.\.\.|[A-Za-z_][A-Za-z0-9_]*|[{}():@$!=\[\],]|\S/g;
  let m;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (depth === 0) {
      if (t === "{") {
        const kind = (head.trim().split(/\s+/)[0] || "query");
        current = kind === "mutation" ? [] : null;
        if (kind === "mutation") mutations.push(current);
        else if (kind === "subscription") return { ok: false, mutations, hasMutation: true };
        depth = 1; head = ""; expectField = true; continue;
      }
      if (t === "}") return { ok: false, mutations, hasMutation: true };
      head += " " + t; continue;
    }
    if (t === "(") { paren++; continue; }
    if (t === ")") { paren--; if (paren < 0) return { ok: false, mutations, hasMutation: true }; continue; }
    if (paren > 0) continue;
    if (t === "{") { depth++; continue; }
    if (t === "}") { depth--; if (depth === 0) current = null; else if (depth === 1) expectField = true; continue; }
    if (depth !== 1 || !current) continue;
    if (t === "...") { current.push("..."); continue; }           // fragment på roten: ukjent → skriving
    if (t === "@") { re.exec(s); continue; }                     // direktiv: hopp over navnet
    if (t === ":") { current.pop(); expectField = true; continue; } // alias: neste navn er feltet
    if (/^[A-Za-z_]/.test(t)) { current.push(t); expectField = false; continue; }
  }
  if (depth !== 0 || paren !== 0) return { ok: false, mutations, hasMutation: true };
  return { ok: true, mutations, hasMutation: mutations.length > 0 };
}

/**
 * Avgjør om et GraphQL-kall er tillatt mot butikken.
 * @param {{ live: boolean, readOnly: boolean, query: string, allowed?: string[] }} p
 * @returns {{ ok: boolean, reason?: string, fields?: string[] }}
 */
export function checkWriteAllowed({ live, readOnly, query, allowed = READ_ONLY_MUTATIONS }) {
  if (!live || !readOnly) return { ok: true };
  const ops = graphQLOperations(query);
  if (!ops.ok) {
    return { ok: false, reason: "Skrivesperre (LIVE_READ_ONLY): kallet kunne ikke leses sikkert og avvises i live." };
  }
  const fields = ops.mutations.flat();
  const blocked = fields.filter((f) => !allowed.includes(f));
  if (blocked.length) {
    return { ok: false, fields: blocked, reason: `Skrivesperre (LIVE_READ_ONLY): mutasjonen ${blocked.join(", ")} er avvist i live. Live er bare åpen for lesing.` };
  }
  return { ok: true };
}

/**
 * Smal liste (publiseringsfasen 09.10.2026): kalleren sier hvilke mutasjoner den selv har lov til å sende.
 * Gjelder i tillegg til skrivesperren og også når sperren er åpen: alt annet avvises. bulkOperationRunQuery
 * (lesing) er alltid tillatt. Kan ikke teksten leses sikkert, avvises den.
 * @param {{ query: string, allowedOnly: string[] }} p
 * @returns {{ ok: boolean, reason?: string, fields?: string[] }}
 */
export function checkMutationAllowlist({ query, allowedOnly }) {
  const ops = graphQLOperations(query);
  if (!ops.ok) return { ok: false, reason: "Smal mutasjonsliste: kallet kunne ikke leses sikkert og avvises." };
  const allowed = [...allowedOnly, ...READ_ONLY_MUTATIONS];
  const blocked = ops.mutations.flat().filter((f) => !allowed.includes(f));
  if (blocked.length) return { ok: false, fields: blocked, reason: `Smal mutasjonsliste: ${blocked.join(", ")} er ikke tillatt her (bare ${allowedOnly.join(", ")}).` };
  return { ok: true };
}

// ── Butikkstempel på jobber (jobs.shop_domain, live-sjekk 1 punkt 3) ─────────────────────
/**
 * Sammenligner butikken jobben ble startet mot med butikken som er aktiv nå.
 * Returnerer feilmeldingen (jobben skal stoppes) eller null (alt i orden).
 * En aktiv jobb uten stempel stoppes også: den er startet før stempelet fantes.
 */
export function jobShopMismatch(jobDomain, currentDomain) {
  const j = String(jobDomain ?? "").trim().toLowerCase();
  const c = String(currentDomain ?? "").trim().toLowerCase();
  if (!c) return "Butikkdomenet er ikke satt. Jobben er stoppet.";
  if (!j) return "Jobben mangler butikkstempel (startet før stempelet fantes). Jobben er stoppet. Start en ny jobb.";
  if (j !== c) return `Butikken er byttet siden jobben startet (${j} → ${c}). Jobben er stoppet. Start en ny jobb.`;
  return null;
}
