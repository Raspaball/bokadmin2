#!/usr/bin/env node
/**
 * clean-tags.mjs
 *
 * Fjerner uønskede tags fra alle Shopify-produkter.
 * Beholder: "lokal", "gave", og alle "bkg-*" tags (bokgruppe-system).
 * Sletter: alt annet (typisk forfatter- og titteltagger).
 *
 * Bruk:
 *   node scripts/clean-tags.mjs --dry-run     # analyser uten endringer (standard)
 *   node scripts/clean-tags.mjs --execute     # utfør faktiske endringer (krever bekreftelse)
 *   node scripts/clean-tags.mjs --execute --resume  # fortsett fra sist lagrede cursor
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import cliProgress from "cli-progress";

// ── Konfigurasjon ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SHOPIFY_API_VERSION = "2025-01";
const PAGE_SIZE = 250;
const STATE_FILE = path.join(__dirname, "clean-tags-state.json");
const LOG_FILE = path.join(__dirname, "clean-tags-log.jsonl");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--execute");
const RESUME = args.includes("--resume");

// ── Tag-filter ────────────────────────────────────────────────────────────────

/**
 * Returner true for tags som skal BEHOLDES.
 * Kritisk: "lokal", "gave" og alle bkg-* tags berøres ALDRI.
 */
function shouldKeepTag(tag) {
  return (
    tag === "lokal" ||
    tag === "gave" ||
    tag === "gaver" ||
    /^bkg-/.test(tag)
  );
}

// ── Credentials ───────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return {};
  const result = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)\s*=\s*"?([^"#\n]*)"?/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

async function loadCredentials() {
  // Prioriter env-variabler (SHOPIFY_DOMAIN / SHOPIFY_TOKEN)
  if (process.env.SHOPIFY_DOMAIN && process.env.SHOPIFY_TOKEN) {
    return { shopDomain: process.env.SHOPIFY_DOMAIN, accessToken: process.env.SHOPIFY_TOKEN };
  }

  // Les fra .env og prøv Supabase user_settings
  const env = loadEnv();
  const supabaseUrl = env.VITE_SUPABASE_URL;
  const serviceKey = env.VITE_SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && serviceKey) {
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/user_settings?select=shopify_shop_domain,shopify_access_token&shopify_shop_domain=not.is.null&limit=1`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      );
      const rows = await res.json();
      const s = rows?.[0];
      if (s?.shopify_shop_domain && s?.shopify_access_token) {
        console.log(`[credentials] Laster fra Supabase user_settings: ${s.shopify_shop_domain}`);
        return { shopDomain: s.shopify_shop_domain, accessToken: s.shopify_access_token };
      }
    } catch (e) {
      console.warn("[credentials] Supabase-oppslag feilet:", e.message);
    }
  }

  throw new Error(
    "Fant ingen Shopify-credentials.\n" +
    "Sett env-variablene SHOPIFY_DOMAIN og SHOPIFY_TOKEN, eller sørg for at .env har VITE_SUPABASE_* keys."
  );
}

// ── Shopify GraphQL ───────────────────────────────────────────────────────────

async function shopifyGql(shopDomain, accessToken, query, variables = {}) {
  const MAX_RETRIES = 3;
  let wait = 1000;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      }
    );
    if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
    const json = await res.json();
    const isThrottled = json.errors?.some(e => e.extensions?.code === "THROTTLED");
    if (isThrottled && attempt < MAX_RETRIES - 1) {
      await sleep(wait);
      wait *= 2;
      continue;
    }
    if (json.errors?.length) throw new Error(`Shopify GQL: ${json.errors[0].message}`);
    return json.data;
  }
  throw new Error("Shopify throttled etter maks antall forsøk");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── State / logging ───────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
    catch { /* korrupt state — start på nytt */ }
  }
  return { cursor: null, processed: 0, updated: 0, skipped: 0, errors: 0, completed: false };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendLog(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

// ── Bekreftelse ───────────────────────────────────────────────────────────────

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question + " (ja/nei): ", answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "ja");
    });
  });
}

// ── Hoved-logikk ──────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== Shopify Tag-renser ===");
  console.log(`Modus: ${DRY_RUN ? "DRY-RUN (ingen endringer)" : "EXECUTE (faktiske endringer)"}`);
  console.log(`Resume: ${RESUME ? "ja" : "nei"}\n`);

  // Credentials
  let shopDomain, accessToken;
  try {
    ({ shopDomain, accessToken } = await loadCredentials());
  } catch (e) {
    console.error("FEIL:", e.message);
    process.exit(1);
  }

  // State
  let state = RESUME ? loadState() : { cursor: null, processed: 0, updated: 0, skipped: 0, errors: 0, completed: false };

  if (state.completed) {
    console.log("Forrige kjøring er allerede fullført. Slett", STATE_FILE, "for å kjøre på nytt.");
    process.exit(0);
  }

  if (RESUME && state.cursor) {
    console.log(`Gjenopptar fra cursor: ...${state.cursor.slice(-20)}`);
    console.log(`Allerede behandlet: ${state.processed} produkter\n`);
  }

  // Hent total antall for progress bar
  let totalProducts = 0;
  try {
    const countData = await shopifyGql(shopDomain, accessToken, `{ productsCount { count } }`);
    totalProducts = countData?.productsCount?.count ?? 0;
    console.log(`Totalt i Shopify: ${totalProducts} produkter`);
  } catch (e) {
    console.warn("Klarte ikke hente produkttall:", e.message);
  }

  // Bekreftelse for --execute
  if (!DRY_RUN) {
    console.log("\nADVARSEL: Dette vil oppdatere tags på opp til", totalProducts, "produkter.");
    console.log("Beholder: lokal, gave, bkg-* tags");
    console.log("Fjerner: alle andre tags (forfatter, tittel, osv.)\n");
    const ok = await confirm("Er du sikker på at du vil fortsette?");
    if (!ok) { console.log("Avbrutt."); process.exit(0); }
    console.log("");
  }

  // Progress bar
  const bar = new cliProgress.SingleBar(
    {
      format: "[{bar}] {percentage}% | {value}/{total} | Oppdatert: {updated} | Hoppet over: {skipped} | Feil: {errors}",
      hideCursor: true,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(totalProducts || 1, state.processed, { updated: state.updated, skipped: state.skipped, errors: state.errors });

  // SIGINT — lagre state og avslutt rent
  process.on("SIGINT", () => {
    bar.stop();
    saveState(state);
    console.log(`\nAvbrutt. State lagret i ${STATE_FILE}`);
    console.log(`Kjør med --execute --resume for å fortsette.`);
    process.exit(0);
  });

  // Hoved-loop
  let cursor = state.cursor;

  while (true) {
    // Hent en side med produkter
    let pageData;
    try {
      pageData = await shopifyGql(shopDomain, accessToken, `
        query($first: Int!, $after: String) {
          products(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { id handle tags } }
          }
        }
      `, { first: PAGE_SIZE, after: cursor });
    } catch (e) {
      bar.stop();
      console.error("\nFeil ved henting av produkter:", e.message);
      saveState(state);
      process.exit(1);
    }

    const products = pageData?.products?.edges?.map(e => e.node) ?? [];
    const pageInfo = pageData?.products?.pageInfo;

    if (products.length === 0) break;

    // Behandle hvert produkt på siden
    for (const product of products) {
      const keptTags = product.tags.filter(shouldKeepTag);
      const removedTags = product.tags.filter(t => !shouldKeepTag(t));
      const needsUpdate = removedTags.length > 0;

      const logEntry = {
        ts: new Date().toISOString(),
        handle: product.handle,
        id: product.id,
        removed: removedTags,
        kept: keptTags,
        mode: DRY_RUN ? "dry-run" : "execute",
        result: null,
      };

      if (!needsUpdate) {
        state.skipped++;
        logEntry.result = "no-change";
      } else if (DRY_RUN) {
        state.updated++; // teller "ville blitt oppdatert"
        logEntry.result = "would-update";
      } else {
        // Faktisk oppdatering
        try {
          const mutResult = await shopifyGql(shopDomain, accessToken, `
            mutation($input: ProductInput!) {
              productUpdate(input: $input) {
                userErrors { field message }
              }
            }
          `, { input: { id: product.id, tags: keptTags } });

          const userErrors = mutResult?.productUpdate?.userErrors ?? [];
          if (userErrors.length) {
            state.errors++;
            logEntry.result = "error: " + userErrors.map(e => e.message).join(", ");
          } else {
            state.updated++;
            logEntry.result = "ok";
          }
          // Liten pause for å unngå throttling
          await sleep(100);
        } catch (e) {
          state.errors++;
          logEntry.result = "error: " + e.message;
        }
      }

      state.processed++;
      appendLog(logEntry);
      bar.update(state.processed, { updated: state.updated, skipped: state.skipped, errors: state.errors });
    }

    // Lagre cursor etter siden
    cursor = pageInfo?.endCursor ?? null;
    state.cursor = cursor;
    saveState(state);

    if (!pageInfo?.hasNextPage) break;
  }

  // Ferdig
  state.completed = true;
  saveState(state);
  bar.update(totalProducts || state.processed, { updated: state.updated, skipped: state.skipped, errors: state.errors });
  bar.stop();

  console.log("\n\n=== Ferdig ===");
  console.log(`Behandlet:  ${state.processed}`);
  console.log(`${DRY_RUN ? "Ville oppdatert" : "Oppdatert"}:  ${state.updated}`);
  console.log(`Hoppet over: ${state.skipped} (ingen tags å fjerne)`);
  console.log(`Feil:        ${state.errors}`);
  console.log(`\nLogg: ${LOG_FILE}`);

  if (DRY_RUN && state.updated > 0) {
    console.log(`\n→ Kjør med --execute for å faktisk utføre de ${state.updated} oppdateringene.`);
    console.log(`  Husk å slette ${STATE_FILE} og ${LOG_FILE} først om du vil ha frisk logg.`);
  }
  if (state.errors > 0) {
    console.log(`\nOBS: ${state.errors} feil — sjekk ${LOG_FILE} for detaljer.`);
  }
}

main().catch(e => {
  console.error("Uventet feil:", e);
  process.exit(1);
});
