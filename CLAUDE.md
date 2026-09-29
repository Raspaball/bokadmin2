# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server
npm run build      # Production build

# Deploy a Supabase Edge Function (must be run from project root)
supabase functions deploy <function-name> --no-verify-jwt

# Set secrets for Edge Functions
supabase secrets set KEY=value
```

Frontend env vars go in `.env` (see `.env.example`). Edge Function secrets are set via `supabase secrets set`.


## Eierens ønske — felles datakilder

Prøv i så stor grad som mulig å bruke felles datakilder for viktige data som brukes i flere funksjoner, i stedet for at disse defineres lokalt på flere steder. Dette gjelder to nivåer:

**1. Supabase-tabeller** — data som lever mellom sesjoner eller deles mellom Edge Functions og frontend brukes alltid via DB, ikke som hardkodede lister.

**2. Delte TypeScript-moduler** — konstanter og mappings som brukes på tvers av komponenter defineres ett sentralt sted i `src/app/utils/`. Edge Functions (Deno) kan ikke importere fra `src/`, men skal ha sin egen kopi med en kommentar som peker til den kanoniske kilden.

### Kanoniske felles datakilder (per 2026-02-27)

| Data | Kilde | Brukt av |
|---|---|---|
| ONIX List 65 (tilgjengelighetskoder) | `src/app/utils/availabilityCodes.ts` | Import.tsx, BokbasenOppslag.tsx, TilgjengelighetTab.tsx; availability-check/index.ts har kopi. Full referanse: https://ns.editeur.org/onix/en/65 |
| Bokgruppekode → navn-mapping | `COLLECTION_NAMES` i shopify/index.ts | shopify-edge function (autoritativ) |
| Bokgruppekode → bkg-tagg-hierarki | `bokgruppeTagsForKode()` i shopify/index.ts | pushOneBook (tagging ved eksport til Shopify) |
| Formatfilter (ONIX ProductForm) | `FORMAT_OPTIONS` i Import.tsx | Kun Import.tsx — kan flyttes til utils/ hvis det trengs andre steder |

### Regel for nye datatyper

Hvis du legger til data som brukes i mer enn én komponent eller Edge Function, plasser definisjonen i `src/app/utils/<navn>.ts` og importer derfra. Dokumenter den i tabellen over.

### Planlagte konsolideringsoppgaver (ikke gjennomført ennå)

1. **Bokbasen auth-URL i sjangre-sync** — `sjangre-sync/index.ts` bruker `https://login.bokbasen.io/oauth/token` mens alle andre funksjoner bruker `https://auth.bokbasen.io/oauth/token`. Bør standardiseres (én linjefiks + redeploy). Lav risiko siden auth.bokbasen.io er den kanoniske URL-en brukt av alle andre funksjoner.

2. **`BOKGRUPPE_LABELS` i Sjangre.tsx → bruk COLLECTION_NAMES** — Sjangre.tsx vedlikeholder sin egen kopi av bokgruppe-labelene (kun 3-sifrede koder + separat `HOOFDKATEGORI` for 1-sifrede). Den autoritative kilden er `COLLECTION_NAMES` i `shopify/index.ts` som har 1-, 2- og 3-sifrede koder. Plan: opprett `src/app/utils/bokgruppe.ts` som eksporterer COLLECTION_NAMES, importer i Sjangre.tsx, fjern BOKGRUPPE_LABELS og HOOFDKATEGORI.

3. **`FORMAT_OPTIONS` → flytt til `src/app/utils/formatCodes.ts`** — Definert i Import.tsx, duplikert som `FORMAT_ORDER` (bare labels) i ShopifyKatalog.tsx. Flytt til utils og importer begge steder.

## Architecture

**Bokadmin** is a Norwegian bookstore admin tool: it pulls book metadata from Bokbasen, stores it in a Supabase database, and pushes products to Shopify.

### Data flow

```
Bokbasen (ONIX v2 API)
    → Supabase DB (books table)
        → Shopify (GraphQL Admin API 2025-01)
```

### Frontend — `src/`

React + TypeScript + Tailwind + shadcn/ui, built with Vite.

- `src/main.tsx` — entry point
- `src/app/App.tsx` — auth gate (Supabase Auth login form) + top-level layout (Sidebar + ContentArea)
- `src/app/components/ContentArea.tsx` — route switch on `activeItem` string from Sidebar
- `src/app/utils/api.ts` — all Supabase client calls and Edge Function wrappers

**Page components** (rendered by ContentArea based on sidebar selection):
- `Import.tsx` — main work list: ISBN lookup, CSV batch import, date-range Bokbasen extraction, push to Shopify
- `BokbasenOppslag.tsx` — single ISBN search widget used inside Import
- `Oppdatering.tsx` — price and availability update jobs
- `Sjangre.tsx` — genre/collection management
- `ShopifyKatalog.tsx` — Shopify catalog browser with inline edit
- `TilgjengelighetTab.tsx` — availability check job UI
- `Feeder.tsx` — manual Shopify collections (feeds) with drag-and-drop product ordering and mosaic cover thumbnail

UI primitives live in `src/app/components/ui/` (shadcn/ui components, do not edit).

### Backend — `supabase/functions/`

Deno-based Edge Functions, each in its own subdirectory with `index.ts`.

| Function | Purpose |
|---|---|
| `bokbasen/` | Bokbasen ONIX v2 metadata: ISBN lookup, date-range, enrich-db |
| `shopify/` | Shopify product push (single + bulk), catalog sync, CSV export, Smart Collections, feeds (manual collections) |
| `price-update/` | Long-running job: fetch current prices from Bokbasen and update Shopify variants. Endpoints: `/start`, `/status/:jobId`, `/cancel/:jobId`, `/resume/:jobId`, `/resume-paused`, `/active`, `/recent` |
| `availability-check/` | Long-running job: check ONIX availability codes and optionally update Shopify. Same endpoints as price-update, plus `start` accepts `mode: analyze|update` |
| `sjangre-sync/` | Long-running job: enrich bokgruppekode → tag products → create Smart Collections. Endpoints: `/start`, `/resume/:jobId`, `/resume-paused`, `/status/:jobId`, `/analyze`, `/active`, `/recent`, `/catalog-bkg-stats`, `/delete-empty-collections` |

All functions are called via `callEdgeFunction()` in `api.ts`. Passes the user's JWT (not anon key) so Edge Functions can identify the user and look up their credentials from `user_settings`. Falls back to anon key if no session.

### Database tables (Supabase PostgreSQL)

`books`, `banners`, `featured_books`, `sync_log`, `shopify_catalog_snapshots`, `scheduled_tasks`, `jobs` tables. Schema in `supabase/migrations/`.

All tables have a `user_id uuid` column (nullable) for multi-tenant isolation. Table `user_settings` stores per-user Shopify + Bokbasen credentials + `setup_completed` flag. A trigger `set_user_id_on_insert()` auto-fills `user_id = auth.uid()` on every insert from an authenticated session.

## Critical API Constraints

**Bokbasen:** Only ISBN lookup is supported — no free-text title/author search. Multi-ISBN queries are handled by looping individual lookups.

**Shopify Admin GraphQL API 2025-01:**
- Use `productVariantsBulkUpdate`, NOT the removed `productVariantUpdate`
- SKU and weight live on `InventoryItem`, not `ProductVariant`
- The `seo` field in `ProductInput` is silently ignored — use `metafieldsSet` with `namespace: "global"`, keys `title_tag` / `description_tag`

**Field mapping (Shopify):**
- ISBN → handle, SKU, barcode
- Author → productType
- Publisher → vendor
- Tags = `"author, title"` + bokgruppekode hierarchy tags (`bkg-N`, `bkg-NN`, `bkg-NNN`)

**Bokgruppekode:** A 1–3 digit Norwegian publisher category code (SubjectSchemeIdentifier 37 in ONIX). Smart Collections in Shopify are keyed by `bkg-{code}` tags at all three hierarchy levels.

## Jobs — long-running background tasks

Both `price-update` and `availability-check` share the same job pattern:
- PAGE_SIZE = 250 products per Shopify page
- `shopifyGql()` wrapper auto-retries on THROTTLED (1s / 2s, max 3 retries)
- Cancellation: `POST /cancel/:jobId` sets status to `failed` with `error_message: "Avbrutt av bruker"`. The processing loop checks DB status each iteration.
- `sync_log` entries include `job_id` for per-job log views, and can be deleted individually via `syncLog.deleteEntry(id)` (RLS: owner or NULL rows)

**ONIX List 58 → Bokbasen-pris (price-update):**
Full referanse: https://ns.editeur.org/onix/nb/58 | Bokbasen-dok: https://bokbasen.jira.com/wiki/spaces/api/pages/3049947145/Fixed+prices+in+Onix+from+Bokbasen
Norge har fastprislov for bøker fra 1. januar 2024. Norske bøker har 0% mva, så eks/inkl-beløp er like i praksis.
Prioritetsrekkefølge i `fetchBokbasenPrice()` (høyest prioritet først):
- **04** Fastpris inkl. mva. — bunden pris etter fastprisloven (høyest prioritet)
- **03** Fastpris uten mva.
- **02** Veiledende utsalgspris inkl. mva.
- **01** Veiledende utsalgspris uten mva.
- Fallback: første pris med beløp uansett type
- **NB**: Ikke ta første prisblokk i XML-rekkefølge — iterer alle og velg etter prioritet (se `fetchBokbasenPrice()` i price-update/index.ts)

**ONIX List 65 → Shopify status (availability-check):**
Full referanse (norsk): https://ns.editeur.org/onix/nb/65
Kanonisk kilde: `src/app/utils/availabilityCodes.ts` — kopi i `availability-check/index.ts` (må holdes i sync).
- **ACTIVE**: 20 (tilgjengelig), 21 (på lager), 22 (skaffes på bestilling), 23 (POD)
- **ARCHIVED** (kun genuint permanente): 43 (ikke lenger distribuert), 46 (trukket tilbake fra salg), 49 (tilbakekalt)
- **DRAFT** — alt annet, inkl.:
  - 01 (vil ikke utkomme), 09–12 (ikke tilgjengelig ennå)
  - 30–34 (midlertidig utilgjengelig, under opptrykk, nytt opplag ventes)
  - 40 (ikke tilgjengelig generisk), 41 (erstattet av nytt produkt), 42 (annet format)
  - 44 (bestilles direkte fra vareeier — IKKE permanent), 45 (selges ikke enkeltvis — IKKE permanent)
  - 47 (nedsettelse), 48 (utsolgt/POD), 50 (selges kun enkeltvis), 51 (utgiver angir utsolgt), 52 (ikke dette marked)
  - 97–99 (ukjent / kontakt kundetjeneste)
- **NB**: Shopify `products`-query MÅ bruke `query: "status:active OR status:draft OR status:archived"` — uten dette hentes bare ACTIVE-produkter

### Job resume-arkitektur (kritisk — ikke endre uten å lese dette)

Jobber kjører i 45s-pulser (Supabase Edge Function timeout). Hvert kall til `processBatch(jobId)` prosesserer produkter inntil timeout, lagrer cursor og setter status til `"paused"`. pg_cron gjenopptar jobben innen 1 minutt.

**`processBatch(jobId)` leser `user_id` FRA JOBBENS EGET RAD i DB** — ikke fra request-konteksten. Alle API-kall til Shopify og Bokbasen skjer med disse per-jobb-credentials.

**`resume-paused`-endepunktet (pg_cron kaller dette med anon JWT):**
- Anon JWT har ingen `sub`-claim → `userId = null`
- Skal finne EN hvilken som helst pauset jobb — filtrer IKKE på `user_id IS NULL` når `userId` er null
- Hvis du legger til tilbake `else { .is("user_id", null) }`, vil pg_cron aldri gjenoppta brukerens jobber (de har riktig user_id), og jobber vil aldri fullføres uten at nettleserfanen er åpen
- Se linjene med kommentaren "If called without userId (pg_cron with anon key)" i begge edge-funksjoner

**Cursor-håndtering ved timeout:**
- Når timeout inntreffer midt i produktloopen, lagres `cursor` (start-cursor for siden som hentes) — IKKE `page.endCursor`
- Å lagre `page.endCursor` ved timeout ville hoppet over alle ubehandlede produkter på siden (siden er 250 produkter, men ~45s timeout rekker bare ~30-45 Bokbasen-kall). Bug fikset 2026-03-02.
- Neste resume re-henter den samme siden fra start — re-prosessering er idempotent (pris/status-sammenligning)
- `cursor` (start-cursor) brukes KORREKT i timeout-blokken OG i det ytre catch-blokken (der `page` kanskje ikke eksisterer)

**Feil-håndtering i `processBatch`:**
- Ytre `catch`-blokk setter status til `"paused"` for forbigående feil (nettverk, throttle)
- For fatale feil (HTTP 401/403) → sett til `"failed"` for å unngå uendelig retry-loop
- Sjekk `errMsg.includes("HTTP 401") || errMsg.includes("HTTP 403")`

### pg_cron-jobber

| pg_cron-navn | Frekvens | Kaller | Funksjon |
|---|---|---|---|
| `resume-paused-jobs` | hvert minutt | `/price-update/resume-paused` | Gjenopptar pauset prisjobb |
| `resume-paused-availability-jobs` | hvert minutt | `/availability-check/resume-paused` | Gjenopptar pauset tilgjengelighetsjobb |
| `run-scheduled-tasks` | hvert minutt | `/price-update/start` eller `/availability-check/start` | Trigger planlagte oppgaver fra `scheduled_tasks`-tabellen |

`run-scheduled-tasks` sender `user_id` i POST-body (siden migrasjon `20260226000002`) slik at per-bruker credentials fungerer.

### Scheduled tasks-atferd

- Ny oppgave opprettes med `next_run_at = NULL` → pg_cron trigger den UMIDDELBART (innen ~1 minutt), ikke ved det planlagte tidspunktet
- Etter første kjøring settes `next_run_at = IMORGEN kl HH:00`
- Kjøringer fra planlagte oppgaver vises i "Siste oppdateringer"/"Siste sjekker" i UI-et — det er ingen distinksjon mellom manuelle og planlagte kjøringer i jobbtabellen
- Toggle-knappen (▷/⏸) i UI setter `enabled = true/false` — avbryter IKKE en allerede kjørende jobb, forhindrer bare fremtidige kjøringer

## Feeder (manual collections)

`GET /shopify/feeds/list` returns only manual collections (`collection_type:custom`) — bkg-* Smart Collections are excluded. Each collection includes `productImages: string[]` (up to 4 featured images for mosaic thumbnail).

The `FeedMosaic` component in `Feeder.tsx` renders: 1 image=full, 2=side-by-side, 3–4=2×2 grid.

**Catalog browser (inside feed editor):** Auto-loads when a feed is opened. Supports sort by `CREATED_AT` (nyeste/eldste importert), `TITLE`, `VENDOR` — passed as `sortKey`/`reverse` to `POST /shopify/catalog`. Sort is disabled during text search (uses Shopify RELEVANCE ranking).

## Lokale engangsverktøy — `scripts/`

### clean-tags.mjs — fjerne forfatter/tittel-tags fra Shopify (2026-03-02)

Engangsoppgave: Alle ~16 000 produkter ble tagget med forfatter og tittel ved import. Disse må fjernes slik at bkg-samlingssystemet fungerer rent.

**Kjøring:**
```bash
# Steg 1 — analyser uten endringer (anbefalt først):
node scripts/clean-tags.mjs --dry-run

# Steg 2 — slett state/logg fra dry-run, kjør faktisk:
node scripts/clean-tags.mjs --execute

# Ved avbrudd — gjenoppta fra siste cursor:
node scripts/clean-tags.mjs --execute --resume
```

**Tag-logikk:** Beholder `lokal`, `gave`, og alle `bkg-*` tags. Sletter alt annet.
**Outputfiler** (git-ignorert): `scripts/clean-tags-state.json`, `scripts/clean-tags-log.jsonl`

## Git branches

**Aktiv branch:** `utvikling` (utviklingsbranch, merges til master)

### Credential-flyt (multi-tenant)

```
Frontend (user JWT) → Edge Function → getUserIdFromJWT() → getShopifyCredentials()
                                          ↓ user_settings funnet?
                                    Ja: bruk DB-credentials
                                    Nei: fall tilbake til env vars (admin/single-tenant)
```

### Nødprosedyre — fullstendig tilbakestilling til single-tenant

```bash
# 1. Deploy gammel Edge Function fra master (eller checkout av gammel commit)
supabase functions deploy shopify --no-verify-jwt

# 2. Gjenopprett RLS i Supabase SQL Editor
#    Lim inn og kjør: supabase/migrations/ROLLBACK_multi_tenant.sql
```

DB-kolonnene (`user_id`) og `user_settings`-tabellen forblir, men er ufarlige for single-tenant kode.

## Shopify Access Token — tokenmodell og levetid

Vi bruker **Custom App**-modellen (merchant oppretter app i Shopify Dev Dashboard og kopierer token). Dette gir tokens med prefiks `shpat_`.

**`shpat_`-tokens er permanente** — de utløper ikke automatisk. De blir ugyldige kun hvis:
- Appen slettes/avinstalleres av merchant
- Tokenet revokeres manuelt i Shopify Admin

Dette skiller seg fra OAuth public app-tokens (`shpoa_`/`shpus_`) som har 90-dagers refresh-syklus. Vår arkitektur trenger derfor **ikke** refresh token-logikk.

Eneste risiko: merchant reinstallerer appen i Shopify uten å oppdatere token i Bokadmin → alle API-kall returnerer 401. Vi håndterer ikke dette grasiøst per nå (ingen re-autentiseringsflyt). Lav-frekvens hendelse, men bør håndteres før kommersiell drift.

## Skalerbarhet og veikart

### Kjente begrensninger ved store kataloger

- **Shopify filterbegrensning:** Collections med >5 000 produkter mister automatisk filtervisning i storefront (Dawn/OS 2.0). Planlegg informasjonsarkitektur slik at ingen bkg-collection overstiger denne grensen. Hierarkiet vi allerede har (bkg-N/bkg-NN/bkg-NNN) er designet riktig for dette.
- **Per-bok API-loop:** Nåværende `pushOneBook` i en loop skalerer ikke til 17 000+ bøker. Ved fullkatalogeksport vil dette ta mange timer og throttles. Riktig løsning er Shopify Bulk Operations (bulkOperationRunMutation + staged upload).
- **Supabase 1000-rad standardgrense:** Løst — `books.getStats()` bruker `count: exact, head: true` for ekte antall.

### Prioritert roadmap mot kommersiell drift

| Prioritet | Oppgave | Hvorfor |
|---|---|---|
| Høy | Shopify Bulk Operations for fullkatalog-push | Eneste som skalerer til 17k bøker |
| Høy | Graceful 401-håndtering (ugyldig token) | Unngå stille feil ved avinstallert app |
| Middels | Observability på jobber (feilrate, antall prosessert) | Vet ikke i dag om prisjobb feilet stille |
| Middels | Webhook for `app/uninstalled` | Rydd opp credentials når butikk kobler fra |
| Lav | Standard Shopify metafields (`facts.isbn`, `descriptors.subtitle`) | Bedre Dawn-interoperabilitet |
| Lav | Theme App Extension + app blocks for Dawn | Rik produktvisning uten manuell temaredigering |

## Backup og trygg utvikling

### Supabase backups
- **Free/Pro:** daglige snapshots, tilgjengelig 7 dager bakover — Dashboard → Settings → Backups
- **Pro:** Point-in-time recovery (PITR) ned til minuttnivå

### Regler for trygge endringer

**1. Migrasjoner er alltid additive** — aldri editer en eksisterende migrasjonsfil. Alltid opprett ny fil med neste timestamp. Da er historikken alltid rekonstruerbar.

**2. Skriv rollback-seksjon i nye migrasjoner** — vi har `ROLLBACK_multi_tenant.sql` som mal. Fortsett denne vanen.

**3. Dump data før store skjemaendringer:**
```bash
supabase db dump --data-only -t books > backup_books_$(date +%Y%m%d).sql
# eller eksporter som CSV fra Supabase Table Editor
```

**4. Branch-workflow:** Kode og Edge Functions utvikles på `utvikling`-branchen og testes der. Migrasjoner er det eneste som ikke kan isoleres per branch (én felles Supabase-instans).

**5. Edge Functions er alltid reverserbare** — revert til gammel git-commit og redeploye:
```bash
git checkout <commit-hash> -- supabase/functions/shopify/index.ts
supabase functions deploy shopify --no-verify-jwt
```

### Risikomatrise

| Endring | Risiko | Reversibel? |
|---|---|---|
| Kodeendring (frontend) | Lav | Ja — git revert |
| Edge Function deploy | Lav | Ja — redeploye gammel commit |
| Ny additivt migrasjon (ADD COLUMN) | Lav | Ja — DROP COLUMN i ny migrasjon |
| Migrasjon som endrer data (UPDATE) | Høy | Nei uten backup |
| Migrasjon som sletter data (DROP/DELETE) | Kritisk | Nei uten backup |

## Smart Collections system

When a book with bokgruppekode `417` is pushed to Shopify, it gets three tags: `bkg-4`, `bkg-41`, `bkg-417`. The `sync-collections` endpoint then creates (or verifies) one Smart Collection per tag, each with a rule `TAG = bkg-{code}`. Books are automatically assigned to all matching collections by Shopify.

**The complete `COLLECTION_NAMES` map** in `supabase/functions/shopify/index.ts` is the authoritative source for all bokgruppe codes and their Norwegian names. All 1-, 2- and 3-digit codes are defined there. Do NOT simplify or truncate this map.

**Sync workflow (2-fase):**
1. `POST /bokbasen/enrich-db` — fills in missing `bokgruppekode` on books in Supabase from Bokbasen ONIX
2. `GET /shopify/analyze-collections` — read-only pre-sync analysis (product count, bkg-tag coverage, collection status). Only counts collections derived from actual product koder — not all possible COLLECTION_NAMES entries.
3. `POST /shopify/sync-collections` — tags all Shopify products with `bkg-*` tags and creates Smart Collections. Only runs after user confirms the analysis.

**Other endpoints:**
- `GET /shopify/count` — single-query product count via `productsCount { count }` (avoids paginating all products just to count)

**Shopify constraints:**
- Menus support max 3 nesting levels total. `buildMenuStructure(maxDepth)` defaults to 2, so bokgruppe categories nest as: Nettbutikk (L1) → bkg-N (L2) → bkg-NN (L3).
- `pushOneBook` checks if the product already has an image before calling `productCreateMedia` — prevents duplicate images on re-export.
- `shopifyGraphQL` auto-retries on THROTTLED errors with exponential backoff (1s / 2s / 4s, max 3 retries).

**buildMegaMenu:**
Calls `getActiveBkgCodes()` to fetch only bkg-* collections that have ≥1 product, then builds the menu tree via `buildMenuStructureFromCodes()`. Falls back to the full static tree if no active codes are found. Merges bokgruppe structure under the existing "Nettbutikk" item — all other top-level menu items are preserved.
