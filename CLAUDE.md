# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server
npm run build      # Production build
node --test scripts/*.test.mjs   # Tester for _shared-modulene (handle, onix, price)

# Deploy a Supabase Edge Function (must be run from project root).
# Bokadmin 2.0: ALWAYS pass the 2.0 project ref — never link or deploy to the live project.
supabase functions deploy <function-name> --no-verify-jwt --use-api --project-ref chwpqwblqummlufqdefe

# Set secrets for Edge Functions
supabase secrets set KEY=value --project-ref chwpqwblqummlufqdefe
```

Frontend env vars go in `.env` (see `.env.example`). Edge Function secrets are set via `supabase secrets set`.
See `BOKADMIN2_OPPSETT.md` for the separation from live Bokadmin and the current setup status.


## Eierens ønske — felles datakilder

Prøv i så stor grad som mulig å bruke felles datakilder for viktige data som brukes i flere funksjoner, i stedet for at disse defineres lokalt på flere steder. Dette gjelder to nivåer:

**1. Supabase-tabeller** — data som lever mellom sesjoner eller deles mellom Edge Functions og frontend brukes alltid via DB, ikke som hardkodede lister.

**2. Delte TypeScript-moduler** — konstanter og mappings som brukes på tvers av komponenter defineres ett sentralt sted i `src/app/utils/`. Edge Functions (Deno) kan ikke importere fra `src/`, men skal ha sin egen kopi med en kommentar som peker til den kanoniske kilden.

### Kanoniske felles datakilder (per 2026-02-27)

| Data | Kilde | Brukt av |
|---|---|---|
| ONIX List 65 (tilgjengelighetsregel) | `availabilityRule()` i `supabase/functions/_shared/availability.ts` (status, `bok.tilgjengelighet`, kjøpbarhet) | availability-check, pushOneBook, CSV-eksport; frontend-kopi i `src/app/utils/availabilityCodes.ts` (Import.tsx, BokbasenOppslag.tsx). Full referanse: https://ns.editeur.org/onix/en/65 |
| Tilgjengelighetskode og utgivelsesdato fra ONIX | `extractAvailabilityCode()` / `extractPublishingDate()` i `_shared/onix.js` | bokbasen (import), availability-check, shopify (push) |
| Bokgruppekode → navn-mapping | `COLLECTION_NAMES` i `supabase/functions/_shared/collection-names.ts` (autoritativ, flyttet fra shopify/index.ts i pakke A2 del 6) | shopify (samlinger, megameny), sjangre-sync |
| Samlingskall (2026-07) | `COLLECTION_CREATE_MUTATION` / `COLLECTION_UPDATE_MUTATION` / `tagSources()` i `_shared/collections.ts` (`collection:` + `sources`, ikke utfaset `input:` + `ruleSet`) | shopify (bkg-samlinger, strømmer), sjangre-sync |
| Pris ved push/CSV (aldri 0) | `decidePushPrice()` / `csvPriceAndStatus()` i `_shared/push-price.ts` | pushOneBook, CSV-eksport |
| Sperre mot store prishopp | `checkPriceChange()` i `_shared/price-guard.ts`; grense og ventende rader i `_shared/price-approvals.ts` (`user_settings.max_price_change_pct`, tabellen `price_approvals`) | price-update (jobb + `/approvals/decide`), pushOneBook, PrisGodkjenning.tsx |
| Egen pris / tilbud (prisen røres ikke) | `priceLock()` / `EGEN_PRIS_FIELD` i `_shared/price-lock.ts` (metafelt `bok.egen_pris` eller `compareAtPrice`) | price-update, pushOneBook, godkjenning |
| Prisjobbens sammendrag | `summarizeCounts()` i `_shared/price-summary.ts` → `jobs.result.summary` | price-update, Oppdatering.tsx (viser teksten) |
| ISBN → bokgruppekode (cache) | Tabellen `bokgruppe_cache` + `books.bokgruppekode` via `loadKodeMap()` i sjangre-sync | sjangre-sync (enrich skriver, tagging leser). **Skriv aldri minimale rader i `books`** — books er arbeidslista på Import-siden, og «Tøm liste» sletter hele tabellen |
| Bokgruppekode → bkg-tagg-hierarki | `bokgruppeTagsForKode()` / `missingBokgruppeTags()` / `bokgruppeCollectionCodes()` i `_shared/bokgruppe.ts` (flyttet fra shopify og sjangre-sync i pakke E) | pushOneBook, CSV, sync-collections (shopify), sjangre-sync |
| Hvilke bkg-samlinger som lages/får nytt navn | `bkgCollectionPlan()` i `_shared/collections.ts` (én liste over samlingene, ingen oppslag per kode) | sjangre-sync (bulk og side for side) |
| Egen tilgjengelighet og arkiverte (pakke E) | `planAvailability()` / `availabilitySkip()` / `ownAvailability()` / `EGEN_TILGJENGELIGHET_FIELD` / `availabilityLogMessage()` i `_shared/availability.ts`. `bok.egen_tilgjengelighet` = true: status, `inventoryPolicy` og `bok.tilgjengelighet` står («Hoppet over: egen tilgjengelighet»). ARCHIVED endres aldri av tilgjengelighetsjobben («Hoppet over: arkivert»). Definisjonen: `scripts/egen-tilgjengelighet-definisjon.mjs` | availability-check (side og bulk), pushOneBook |
| Statusrapport (ny status før live) | `StatusChangeRow` i `_shared/availability.ts` → `jobs.result.statusChanges`; CSV og visning i `src/app/utils/statusReport.ts` | availability-check, TilgjengelighetTab.tsx, scripts/statusrapport.mjs |
| Bulk-jobber over hele katalogen | `runBulkJob()` / `emptyBulkJobState()` / `freshOnixIsbns()` / `loadOnixXml()` / `insertLogs()` i `_shared/bulk-job.ts` (spørring → ONIX til `onix_cache` → plan i biter på 1000 → én bulk-mutasjon per type og bit → avslutning). Jobben gir bare spørring, plan og avslutning | availability-check, sjangre-sync (book-update bruker hjelperne, har egne faser) |
| Tilgjengelighet i bulk | `AVAILABILITY_BULK_QUERY` / `availabilityBulkLines()` i `_shared/availability-bulk.ts` (CONTINUE først, så status + metafelt). ONIX fra cachen bare når den er under 2 timer gammel | availability-check |
| Handle-regel (tittel-forfatter-ISBN-13) | `buildBookHandle()` i `supabase/functions/_shared/handle.js`, med forfatterlisten (`authors`) — `firstAuthor()` bare som reserve for gamle data | pushOneBook, CSV-eksport, handle-migrering, scripts/migrate-handles.mjs |
| Standarden for en bok i Shopify (pakke B) | `bookFieldsFromOnix()` / `bookMetafields()` / `bookDescription()` i `_shared/book-standard.ts`; `planBookUpdate()` i `_shared/book-update.ts` (én ren funksjon: ONIX + produkt → endringer) | pushOneBook, book-update (jobben), senere bulk |
| Forfatterne som liste | `extractContributors()` i `_shared/onix.js` → `books.authors text[]` | bokbasen (import), push, book-update |
| Format, productType og kategori | `bookFormat()` / `CATEGORY_IDS` i `_shared/book-format.ts` (godkjent formatliste) | bokbasen, push, CSV, book-update |
| SEO-tittel og metabeskrivelse | `bookSeo()` / `decideSeo()` i `_shared/book-seo.ts` (+ `bokadmin.seo_auto`) | push, book-update |
| Omslag (alt-tekst, filnavn) | `coverAlt()` / `coverFilename()` i `_shared/book-cover.ts` | push, book-update |
| Tagger | `cleanBookTags()` i `_shared/book-tags.ts` (bare bkg-*, forfatter/tittel fjernes) | push, book-update |
| Tittel og forlagstekst fra ONIX | `onixText()` / `extractTitle()` / `extractDescription()` i `_shared/onix.js` | bokbasen, push, book-update |
| ONIX-cache | tabellen `onix_cache` via `getOnixCached()` i `_shared/onix-cache.ts` (7 dager) | book-update, push |
| ISBN fra Shopify-produkt | `extractIsbn()` i `supabase/functions/_shared/isbn.js` (bok.isbn → strekkode → SKU → ISBN-handle) | price-update, availability-check, sjangre-sync, shopify (samlinger, migrering), scripts |
| Plan for handle-migrering | `planHandleMigration()` i `supabase/functions/_shared/handle-migration.js` | /shopify/handles/*, scripts/migrate-handles.mjs |
| Bokgruppekode fra ONIX (skjema 37) | `extractBokgruppekode()` i `supabase/functions/_shared/onix.js` | bokbasen, shopify, sjangre-sync |
| Bokbasen-innlogging (legitimasjon, token-cache, ONIX-URL) | `getBokbasenCredentials()` / `getBokbasenToken()` / `BOKBASEN_ONIX_URL` i `supabase/functions/_shared/bokbasen-auth.ts` | bokbasen, shopify, price-update, availability-check, sjangre-sync |
| Beskyttede produkter (fast regel 2026-10-02) | `protectedProduct()` i `_shared/protected.ts` (produktnivå: tagg → leverandør → samling). Taggene gave, lokal, lokalhistorie, lokallitteratur (`PROTECTED_TAGS`, hel tagg, uten store/små bokstaver); leverandør som inneholder «wrendale» (`PROTECTED_VENDOR_WORDS`); medlem av manuell samling `wrendale` (`PROTECTED_COLLECTION_HANDLES`, lastes hver puls med `ensureProtectedMembers()` i `_shared/protected-load.ts` / `loadProtectedMembers(gql)` i skript; mangler samlingen, stopper jobben). `isProtectedCollection()`: samlingen selv røres aldri (strømmer, sletting av tomme). `protectedTag()` bare der det er taggene som vurderes. Ligger fast i koden, ingen innstilling. Se `oppgaver/regel-beskyttede-samlinger.md` | book-update, price-update (jobb + godkjenning), availability-check, sjangre-sync, push/push-bulk, samlingstagging, handle-plan/-tilbakeføring, katalogredigering, CSV-eksport, `planBookUpdate`, `cleanBookTags`, scripts (clean-tags, migrate-handles, isbn-definition). Hver ny skriver til Shopify må hente `tags` og sjekke |
| Hvem som kaller (brukeridentitet) | `getCaller(req)` i `_shared/auth.ts` (verifiserer tokenet med `auth.getUser`; funksjonene kjører med `--no-verify-jwt`). `scheduledUserId()` godtar `user_id` i body fra pg_cron bare for brukere med aktiv planlagt oppgave av samme type. **Les aldri `sub`/`email` rett fra tokenet** | alle Edge Functions |
| Shopify Bulk Operations | `startBulkMutation()` / `startBulkQuery()` / `waitForBulkOperation()` / `streamJsonlLines()` i `_shared/shopify-bulk.ts` (staged upload + `bulkOperationRunMutation`/`RunQuery`) | handle-migrering (shopify), book-update (bulk) |
| Bulk-filene for «Oppdater eksisterende bøker» | `BULK_PRODUCTS_QUERY`, `BulkProductAssembler`, `bulkUpdateLine()` (productUpdate med metafelt), `bulkCoverLine()` (fileUpdate), `parseBulkResult()` i `_shared/book-bulk.ts`. Reglene er fortsatt `planBookUpdate()` | book-update (`bulk: true`) |
| Bare bøker (pakke F) | `isBookForm()` / `notBookSkip()` / `NOT_IN_BOKBASEN_MESSAGE` i `_shared/book-format.ts` (ProductForm B*, A*, E*; ellers «Hoppet over: ikke bok») | book-update, availability-check, price-update, sjangre-sync (bulk), push |
| ~~Lager går foran Bokbasen (pakke F)~~ Gjelder ikke lenger (pakke G del 2) | `STOCK_BEFORE_BOKBASEN = false` i `_shared/inventory-tracking.ts`: butikken fører ikke lager, Bokbasen avgjør status alene. Koden i `planAvailability()` (`stockKept`) står, men er død | availability-check, pushOneBook |
| Ingen bøker har «Spor beholdning» (pakke G del 2) | `TRACK_INVENTORY = false` / `needsUntrack()` / `UNTRACK_VARIANT_FIELDS` / `effectiveStock()` i `_shared/inventory-tracking.ts`. `planAvailability()` gir `untrack` (`inventoryItem.tracked → false` via `productVariantsBulkUpdate`, i bulk og side for side); da trengs ikke CONTINUE. Gjelder også med egen tilgjengelighet; beskyttede røres aldri | availability-check, pushOneBook |
| Forfatter = person (pakke G del 3) | `personAuthors()` / `isInstitutionName()` / `institutionReason()` / `INSTITUTION_NAMES` / `INSTITUTION_PATTERNS` i `_shared/contributors.js` (redigerbar liste). `extractContributors()` i `onix.js` sorterer ut CorporateName og kjente institusjonsnavn (`institutions`), `firstAuthor()`, `seoTitle()`, `metaDescription()`, `coverAlt()` og `bookMetafields()` bruker samme funksjon. CSV: `institutionsCsv()` + `scripts/institusjoner.mjs` | bokbasen, push, book-update, handle |
| Gammel SEO-automatikk (pakke G del 1) | `isLegacySeoTitle()` / `isLegacySeoDescription()` / `legacySeo()` / `decideSeo()` i `_shared/book-seo.ts`: tittel/hovedtittel, «Kjøp {tittel} hos Bø bok og papir», forlagsteksten kuttet på ca. 320 tegn (også HTML) eller hel, og tom overskrives; alt annet er manuelt. `bokadmin.seo_auto` har bare feltene som ble skrevet. `descriptionWords()` i `book-standard.ts`: samme ord = bare formatering | push, book-update |
| Bøker uten forlagstekst (pakke H del 3) | `fallbackDescription()` (`{Tittel} av {Forfatter}. {Format}, {sider} sider, utgitt {år}.`, uten forlag) / `legacyFallbackDescription()` (eldre form med forlag, bare for gjenkjenning) i `_shared/book-standard.ts`; `parseSeoAutoBody()` / `mergeSeoAutoBody()` i `book-seo.ts`: teksten lagres i `bokadmin.seo_auto.body` som generert. `canReplaceDescription()` bytter bare tom tekst, samme tekst med annen formatering eller generert tekst (forlagsteksten tar over); en eksisterende tekst overskrives aldri | push, book-update; liste: `scripts/out/uten-beskrivelse.csv` (sjekk-lokalt.mjs) |
| Videresending for arkiverte bøker (pakke H del 3b) | `wantsRedirect()` / `chooseRedirectTarget()` / `planRedirect()` / `planRemoveRedirect()` / `REDIRECT_CODES` i `_shared/redirects.ts`; `extractReplacedBy()` (RelatedProduct 05) i `_shared/onix.js`; `bokgruppeFromTags()` i `bokgruppe.ts` (reserve for `bok.bokgruppe`). ONIX-kode 41, 43, 46–49 og status ikke ACTIVE: `/products/{handle}` → ny utgave (bare 41, aktiv i butikken) ellers `/collections/bkg-{kode}` hvis samlingen finnes; `/products/{ISBN}` oppdateres rett til målet (ingen kjeder); aktiv igjen: handle-videresendingen slettes. Beskyttede og utkast uten disse kodene (40, 42, 44) røres ikke | availability-check (sjekk: telling per måltype + 10 eksempler; oppdatering: direkte `urlRedirectCreate/Update/Delete`); `scripts/videresendinger.mjs` (lokal sjekk → `scripts/out/videresendinger.csv`) |
| Kontroll av beskyttede produkter (pakke H del 4) | Innhold, ikke `updatedAt` (Shopify rører den selv, f.eks. 12 t etter CSV-import): `scripts/kontroll-beskyttede.mjs` (importfilene `scripts/data/full-del-*.csv` mot snapshot: tittel, beskrivelse, tagger, leverandør, type, status, pris, SEO, bilder, strekkode; tom beskrivelse = `<p></p>`) og `diffProduct(a, b, { ignore: ["updatedAt"] })` i `scripts/snapshot-diff.mjs` (gruppen beskyttet; bare ny `updatedAt` telles for seg) | snapshot-diff, kontroll-beskyttede |
| Format «Annet» (pakke G del 4a) | `shownFormat()` i `_shared/book-format.ts`: «Annet» vises ikke i SEO og lagres ikke som `bok.format`; en eksisterende «Annet» slettes (`metafieldDeletes` i `planBookUpdate`) | push, book-update |
| Utgivelsesår og -dato (pakke G del 4b) | `extractPublicationYear()` tar året fra `extractPublishingDate()` (samme kilde), ellers PublishingDate 01 | bokbasen, push, book-update |
| Forbigående linjefeil i bulk (pakke G del 4c) | `splitRetries()` / `isTransientLineError()` i `_shared/bulk-retry.ts`, brukt av `runBulkJob()` | availability-check, sjangre-sync |
| bok.bokgruppe (pakke F) | `BOKGRUPPE_METAFIELD` / `BOKGRUPPE_FIELD` i `_shared/bokgruppe.ts`; `bookFieldsFromOnix().bokgruppe` → `bookMetafields()`. Definisjon: `scripts/bokgruppe-definisjon.mjs` | push, book-update, sjangre-sync (bulk) |
| Logg per produkt og livstegn (pakke F) | `logRow()` / `skipRow()` / `SKIP_REASONS` i `_shared/job-log.ts` → `sync_log.outcome/reason/fields`; `jobs.heartbeat_at/last_isbn` fra trigger (migrasjon `20261002150000`). Frontend: `src/app/utils/jobLog.ts` + `JobHealth.tsx` (stillstand > 5 min, CSV med hoppet over og feil); `clearChunkLogs()` i `_shared/bulk-job.ts` hindrer doble rader | alle jobbene, Oppdatering/Tilgjengelighet/BokOppdatering/Sjangre |
| Øyeblikksbilde før/etter (pakke F) | `scripts/snapshot.mjs` (bulk-lesing av produkter, samlinger, videresendinger → `scripts/out/snapshot-*`) og `scripts/snapshot-diff.mjs` (felt for felt, grupper beskyttet/uten ISBN/med ISBN) | generalprøven, sikkerhetskopi |
| Duplikater (samme ISBN på flere produkter) | `groupDuplicates()` / `decideDuplicate()` / `tagsToMerge()` / `runDuplicateScan()` i `_shared/duplicates.ts`; `ensureDuplicates()` i `_shared/duplicate-scan.ts` lagrer listen i `jobs.config.duplicates` | book-update, price-update, availability-check, sjangre-sync, samlingstagging, push, `scripts/duplicates.mjs`. Jobbene hopper over ISBN-ene («Hoppet over: DUPLIKAT …») til de er ryddet |
| Salgskanaler (pakke H del 2) | `getAllPublicationIds()` / `publishToAllChannels()` / `channelsToPublish()` / `publishBulkLine()` / `PUBLISHED_ON_BULK_FIELD` i `_shared/publish.ts` (kanalene er alle `publications`; bare aktive bøker, ikke lydbøker/e-bøker/ikke-bøker/beskyttede). Bulk-spørringene leser kanalene som barn-linjer `ResourcePublicationV2` | push, availability-check (når en bok blir ACTIVE), book-update (aktive bøker som mangler kanaler); `scripts/kanaler-rapport.mjs` |
| Formatfilter (ONIX ProductForm) | `FORMAT_OPTIONS` i Import.tsx | Kun Import.tsx — kan flyttes til utils/ hvis det trengs andre steder |

### Regel for nye datatyper

Hvis du legger til data som brukes i mer enn én komponent eller Edge Function, plasser definisjonen i `src/app/utils/<navn>.ts` og importer derfra. Dokumenter den i tabellen over.

### Planlagte konsolideringsoppgaver (ikke gjennomført ennå)

1. ~~**Bokbasen auth-URL i sjangre-sync**~~ — **Gjort 2026-09-30.** sjangre-sync bruker nå `auth.bokbasen.io`, `/metadata/export/onix/v2/` og SubjectSchemeIdentifier 37, som `bokbasen/` og `shopify/`. Den gamle varianten (login.bokbasen.io, `/onix/v2/`, skjema 23) feilet for alle oppslag.

2. **`BOKGRUPPE_LABELS` i Sjangre.tsx → bruk COLLECTION_NAMES** — Sjangre.tsx vedlikeholder sin egen kopi av bokgruppe-labelene (kun 3-sifrede koder + separat `HOOFDKATEGORI` for 1-sifrede). Den autoritative kilden er `COLLECTION_NAMES` i `_shared/collection-names.ts` som har 1-, 2- og 3-sifrede koder. Plan: opprett `src/app/utils/bokgruppe.ts` som eksporterer COLLECTION_NAMES, importer i Sjangre.tsx, fjern BOKGRUPPE_LABELS og HOOFDKATEGORI.

3. **`FORMAT_OPTIONS` → flytt til `src/app/utils/formatCodes.ts`** — Definert i Import.tsx, duplikert som `FORMAT_ORDER` (bare labels) i ShopifyKatalog.tsx. Flytt til utils og importer begge steder.

## Architecture

**Bokadmin** is a Norwegian bookstore admin tool: it pulls book metadata from Bokbasen, stores it in a Supabase database, and pushes products to Shopify.

### Data flow

```
Bokbasen (ONIX v2 API)
    → Supabase DB (books table)
        → Shopify (GraphQL Admin API 2026-07, Dev Dashboard-app)
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
- `Sjangre.tsx` — genre/collection management («Sjekk» / «Kjør sjangre-synk», one bulk job)
- `ShopifyKatalog.tsx` — Shopify catalog browser with inline edit
- `TilgjengelighetTab.tsx` — availability check job UI (bulk checkbox, statusrapport with CSV download)
- `Feeder.tsx` — manual Shopify collections (feeds) with drag-and-drop product ordering and mosaic cover thumbnail
- `Handles.tsx` — migrate product handles from ISBN to tittel-forfatter-ISBN (analyze, run, verify redirects, undo)

UI primitives live in `src/app/components/ui/` (shadcn/ui components, do not edit).

### Backend — `supabase/functions/`

Deno-based Edge Functions, each in its own subdirectory with `index.ts`.

Shared code lives in `supabase/functions/_shared/`. The `.js` modules there (`handle.js`, `isbn.js`, `handle-migration.js`) are plain ESM with `.d.ts` types so both Deno and Node (`scripts/`) can import them — never copy their rules into a function. **`_shared/shopify.ts` is the only Shopify client:** it holds `SHOPIFY_API_VERSION`, fetches/refreshes the access token (`getShopifyAccessToken()`) and runs `shopifyGraphQL(query, variables)` → `{ data }`. Never define an API version, GraphQL wrapper or Shopify token lookup locally in a function. Likewise **`_shared/bokbasen-auth.ts` is the only Bokbasen login** (credentials from `user_settings` or env, token cached until 60 s before expiry).

| Function | Purpose |
|---|---|
| `bokbasen/` | Bokbasen ONIX v2 metadata: ISBN lookup, date-range, enrich-db |
| `shopify/` | Shopify product push (single + bulk), catalog sync, CSV export, Smart Collections, feeds (manual collections), handle migration (`/handles/*`) |
| `price-update/` | Long-running job: fetch current prices from Bokbasen and update Shopify variants. Endpoints: `/start` (`mode: analyze|update`, uten mode = `analyze`), `/status/:jobId`, `/cancel/:jobId`, `/resume/:jobId`, `/resume-paused`, `/active`, `/recent`, `/approvals/decide` (`{ ids, decision: approve|reject }`, krever innlogget bruker) |
| `availability-check/` | Long-running job: check ONIX availability codes and optionally update Shopify. Same endpoints as price-update, plus `start` accepts `mode: analyze|update` (default analyze) and `bulk` (default true: Bulk Operations + `onix_cache` via `_shared/bulk-job.ts`; `bulk: false` = page by page). Skips protected, duplicates and ARCHIVED; respects `bok.egen_tilgjengelighet`. Result has `statusChanges` (statusrapport) and `summary` |
| `book-update/` | Long-running job «Oppdater eksisterende bøker» (pakke B): applies the book standard (bok.* metafields, productType, category, SEO, cover alt/filename, description, tags) to products that already exist. Never price, status, availability, handle or title. Endpoints: `/start` (`mode: analyze|update`, default analyze; optional `isbns`; `bulk: true` = whole catalog via Bulk Operations: bulk query → ONIX prefetch to `onix_cache` (4 parallel) → plan in chunks of 1000 → one `productUpdate` + one `fileUpdate` bulk mutation per chunk, errors logged per book), `/status/:jobId`, `/cancel/:jobId`, `/resume/:jobId`, `/resume-paused`, `/active`, `/recent` |
| `sjangre-sync/` | Long-running job: bokgruppekode (cache, else ONIX) → bkg tags → Smart Collections (and fix titles from COLLECTION_NAMES). `/start { mode, bulk }`: bulk (default) does all three in one job with `tagsAdd`, `mode` default `analyze`; `bulk: false` = old page-by-page tagging (always update, codes only from cache). Other endpoints: `/resume/:jobId`, `/status/:jobId`, `/analyze`, `/active`, `/enrich-start` (old separate Bokbasen lookup), `/catalog-bkg-stats`, `/delete-empty-collections`. Resumed by the page (no pg_cron) |

All functions are called via `callEdgeFunction()` in `api.ts`. Passes the user's JWT (not anon key) so Edge Functions can identify the user (verified with `getCaller()` in `_shared/auth.ts`) and look up their Bokbasen credentials from `user_settings`. Falls back to anon key if no session. Shopify is server-wide (see the Shopify access section below).

### Database tables (Supabase PostgreSQL)

`books`, `banners`, `featured_books`, `sync_log`, `shopify_catalog_snapshots`, `scheduled_tasks`, `jobs`, `bokgruppe_cache`, `price_approvals`, `onix_cache` tables. `books.authors text[]` holds the author list (pakke B). Schema in `supabase/migrations/`.

All tables have a `user_id uuid` column (nullable) for multi-tenant isolation. Table `user_settings` stores per-user Shopify + Bokbasen credentials + `setup_completed` flag. A trigger `set_user_id_on_insert()` auto-fills `user_id = auth.uid()` on every insert from an authenticated session.

## Critical API Constraints

**Bokbasen:** Only ISBN lookup is supported — no free-text title/author search. Multi-ISBN queries are handled by looping individual lookups.

**Shopify Admin GraphQL API 2026-07** (version set only in `_shared/shopify.ts`):
- Use `productVariantsBulkUpdate`, NOT the removed `productVariantUpdate`
- SKU and weight live on `InventoryItem`, not `ProductVariant`
- SEO is set with `metafieldsSet` (`namespace: "global"`, keys `title_tag` / `description_tag`), not via product input
- `productCreate(product: ProductCreateInput)` / `productUpdate(product: ProductUpdateInput)` — the `input: ProductInput` argument is deprecated
- Collections: `collectionCreate(collection: CollectionCreateInput)` / `collectionUpdate(collection: CollectionUpdateInput)` via `_shared/collections.ts`. Tag rules go in `sources` (`tagSources(tag)`); without `sources` the collection is manual. `collectionAddProducts`/`collectionRemoveProducts` (feeds) are deprecated in favour of `collectionUpdate` selections — not yet changed
- The MCP GraphQL validator uses an older schema (no `collection:` argument): validate against Testbutikk with introspection when they disagree
- Lookups: `productByIdentifier(identifier: { handle })` / `collectionByIdentifier(identifier: { handle })` — `productByHandle` / `collectionByHandle` are deprecated
- Images: add with `productUpdate(product: { id }, media: [...])` (`productCreateMedia` is deprecated); read with `media` / `featuredMedia { preview { image { url } } }` (`images` / `featuredImage` are deprecated)
- Validate every new or changed GraphQL string against the schema (Shopify's GraphQL validator) before deploying

**Field mapping (Shopify):**
- Handle → `buildBookHandle()`: `<hovedtittel, maks 60 tegn>-<første forfatter, fornavn etternavn>-<ISBN-13>`, e.g. `avkledd-nina-brochmann-9788203461392`. Set only when the product is created; a re-push never changes it
- ISBN → metafield `bok.isbn`, SKU, barcode. **Never read ISBN from `product.handle`** — use `extractIsbn()` and fetch `bok.isbn`, barcode and SKU in the query
- Lookup before create (pushOneBook): `books.shopify_id` → customId `bok.isbn` (definition of type `id` in Testbutikk since 2026-10-01) → barcode/SKU search (also used when the customId lookup returns a GraphQL error) → handle = ISBN (legacy) → handle = new handle → create. `shopify_id` is saved to `books` after every push
- Price/status → `decidePushPrice()` i `_shared/push-price.ts`: never price 0. New book without approved price → DRAFT without price; existing book without price → price not sent. CSV: `draft` + empty price
- Existing book: price not sent when `bok.egen_pris` = true or the variant has `compareAtPrice` («Hoppet over: egen pris/tilbud»), or when the change exceeds `max_price_change_pct` (standard 30 %) → row in `price_approvals`, `approvalRequired: true`. Same rules in the price job (update mode); old price 0/missing is always set
- productType → «Bok» / «Lydbok» / «E-bok» from the format (`_shared/book-format.ts`); category → Print Books / Audiobooks / E-Books
- Publisher → vendor
- Tags = bokgruppekode hierarchy tags only (`bkg-N`, `bkg-NN`, `bkg-NNN`). Author and title are no longer tags; on existing products other tags are kept
- Metafields `bok.forfatter` (list), `format`, `sider`, `utgivelsesaar`, `spraak`, `serie`, `alder`, `thema` from ONIX; SEO in `global.title_tag`/`description_tag` with manual edits protected via `bokadmin.seo_auto`; cover alt «Omslag: {Tittel} av {Forfatter}» and filename `{handle}-omslag.jpg` via `fileUpdate`; description with `<p>` per paragraph or a fallback description

**Bokgruppekode:** A 1–3 digit Norwegian publisher category code (SubjectSchemeIdentifier 37 in ONIX). Smart Collections in Shopify are keyed by `bkg-{code}` tags at all three hierarchy levels.

## Jobs — long-running background tasks

Both `price-update` and `availability-check` share the same job pattern:
- PAGE_SIZE = 250 products per Shopify page
- `shopifyGraphQL()` from `_shared/shopify.ts` auto-retries on THROTTLED (1s / 2s / 4s) and refreshes the token once on HTTP 401. Errors are thrown as `Shopify HTTP <status>: …`, which the jobs' `HTTP 401` / `HTTP 403` → `failed` check relies on
- Cancellation: `POST /cancel/:jobId` sets status to `failed` with `error_message: "Avbrutt av bruker"`. The processing loop checks DB status each iteration.
- `sync_log` entries include `job_id` for per-job log views, and can be deleted individually via `syncLog.deleteEntry(id)` (RLS: owner or NULL rows)

**ONIX List 58 → Bokbasen-pris (`choosePrice()` i `_shared/price.ts`, brukt av import og price-update):**
Full referanse: https://ns.editeur.org/onix/nb/58 | Bokbasen-dok: https://bokbasen.jira.com/wiki/spaces/api/pages/3049947145/Fixed+prices+in+Onix+from+Bokbasen
Norge har fastprislov for bøker fra 1. januar 2024. Norske bøker har 0% mva, så eks/inkl-beløp er like i praksis.
Prioritetsrekkefølge i `choosePrice()` (høyest prioritet først, priser med mva før priser uten — endret i pakke A2 del 5):
- **04** Fastpris inkl. mva. — bunden pris etter fastprisloven (høyest prioritet)
- **02** Veiledende utsalgspris inkl. mva.
- **03** Fastpris uten mva.
- **01** Veiledende utsalgspris uten mva.
- Fallback: første pris med beløp uansett type
- **NB**: Ikke ta første prisblokk i XML-rekkefølge — iterer alle og velg etter prioritet
- Bare priser i NOK, for Norge og gyldige i dag (Europe/Oslo) godtas; ved lik type vinner nyest startdato. Ingen godkjent pris → `null` + årsak i `sync_log`. Se BOKADMIN2_OPPSETT.md

**ONIX List 65 → status, `bok.tilgjengelighet` og kjøpbarhet (pakke C, 2026-10-02):**
Full referanse (norsk): https://ns.editeur.org/onix/nb/65
Kanonisk kilde: `availabilityRule()` i `supabase/functions/_shared/availability.ts`, brukt av availability-check, pushOneBook og CSV-eksporten. Frontend-kopi i `src/app/utils/availabilityCodes.ts` (må holdes lik).
- **20–23** → ACTIVE, `tilgjengelig`, kan kjøpes
- **10, 11, 12** → ACTIVE, `kommer`, kan kjøpes (forhåndsbestilling). Ikke lenger utkast: utkast gir 404 og mister søketrafikken
- **30–34** → ACTIVE, `midlertidig_utsolgt`, kan kjøpes (vi bestiller)
- **43, 46, 49** → ARCHIVED, `utgatt`
- **Alt annet** (også tom/ukjent kode: 01, 09, 40–42, 44, 45, 47, 48, 50–52, 97–99) → DRAFT, `ikke_tilgjengelig`
- **Unntak (pakke E):** `bok.egen_tilgjengelighet` = true → status, `inventoryPolicy` og `bok.tilgjengelighet` står (jobben og push); ARCHIVED endres aldri av tilgjengelighetsjobben. Regelen er `planAvailability()`
- «Kan kjøpes» uansett lager: varianter med sporet lager og `inventoryPolicy: DENY` får `CONTINUE` (`needsContinuePolicy`). Beholdning, sporing og lokasjoner endres aldri. Varianter Bokadmin lager selv spores ikke
- `bok.utgivelsesdato` (date) fra `extractPublishingDate()` i `_shared/onix.js`: PublishingDate 01 hvis hel dato → MarketDate 01 → PublishingDate 11 → PublicationDate. Hos Bokbasen er PublishingDate 01 alltid bare årstall; kommende bøker har datoen i MarketDate 01
- Push: ny bok uten godkjent pris er alltid DRAFT (pakke A2). Bokbasen nede og ingen kode i boka: eksisterende bok beholder status, ny blir DRAFT
- Metafeltdefinisjonene lages med `node scripts/tilgjengelighet-definisjoner.mjs --create` (laget i Testbutikk; må lages i livebutikken før live)
- **NB**: Shopify `products`-/`productsCount`-spørringer som skal treffe hele katalogen bruker `query: "${ALL_PRODUCT_STATUSES}"` fra `_shared/shopify.ts` (Testbutikk 2026-10-01: arkiverte kom med også uten filter, utkast ikke kontrollert — filteret settes uansett)

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
| `resume-paused-book-update-jobs` | hvert minutt | `/book-update/resume-paused` | Gjenopptar pauset «Oppdater eksisterende bøker» |
| `run-scheduled-tasks` | hvert minutt | `/price-update/start` eller `/availability-check/start` | Trigger planlagte oppgaver fra `scheduled_tasks`-tabellen |

`run-scheduled-tasks` sender `user_id` i POST-body (siden migrasjon `20260226000002`) slik at per-bruker credentials fungerer. Siden `20261001130000` sender den også `mode` for prisjobber (`scheduled_tasks.config.mode`, uten mode: `analyze`), regner tidene i Europe/Oslo, og venter (flytter ikke `next_run_at`) mens en prisjobb for samme bruker kjører. Høyst én prisjobb startes per minutt; oppdatering går foran sjekk. URL og nøkkel hentes fra Vault (`project_url`, `anon_key`).

### Scheduled tasks-atferd

- Ny oppgave opprettes med `next_run_at = NULL` → pg_cron trigger den UMIDDELBART (innen ~1 minutt), ikke ved det planlagte tidspunktet
- Etter første kjøring settes `next_run_at = IMORGEN kl HH:00` norsk tid (neste mandag / neste 1. for ukentlig/månedlig)
- Prisoppgaver har `config.mode` (`analyze` = sjekk, `update` = endrer priser); Oppdatering-siden lar deg velge. Per 2026-10-01 er ingen planlagte oppgaver lagt inn i 2.0
- Kjøringer fra planlagte oppgaver vises i "Siste oppdateringer"/"Siste sjekker" i UI-et — det er ingen distinksjon mellom manuelle og planlagte kjøringer i jobbtabellen
- Toggle-knappen (▷/⏸) i UI setter `enabled = true/false` — avbryter IKKE en allerede kjørende jobb, forhindrer bare fremtidige kjøringer

## Handles — migrering fra nettsiden

Siden «Handles» og `supabase/functions/shopify/index.ts` (`/handles/*`). Planen lages av `planHandleMigration()` (samme som `scripts/migrate-handles.mjs`).

| Endepunkt | Hva |
|---|---|
| `GET /handles/status[/:jobId]` | Butikk, om migrering er tillatt, siste/gitt kjøring. Poller bulk-operasjonen og skriver resultatet til `sync_log` når den er ferdig |
| `POST /handles/analyze` | Tørrkjøring: tellinger + plan (gammel/ny handle, merknader) |
| `POST /handles/migrate` | `{ productIds, skipFlagged }`. Lager planen på nytt, hopper alltid over duplikat/kollisjon, starter én `bulkOperationRunMutation` med `productUpdate(product: { id, handle, redirectNewHandle: true, metafields: bok.isbn })` |
| `GET /handles/verify?jobId=` | Sjekker `urlRedirects` for endringene som fortsatt gjelder (+ HTTP-svar for 5) |
| `POST /handles/rollback` | `{ jobId? }` Sletter videresendingen fra gammel sti, setter handle tilbake. Pulser på 40 s — kall igjen så lenge `timedOut` er true |

- **Sperre:** `migrate` og `rollback` svarer 403 med mindre `SHOPIFY_SHOP_DOMAIN` er `testbutikk-9434.myshopify.com` eller hemmeligheten `ALLOW_HANDLE_MIGRATION=true` er satt.
- Jobbtype `handle_migration` i `jobs` (status `running` → `finalizing` → `completed`/`failed`). Radene ligger i `config.rows`, bulk-ID i `config.bulkOperationId`. Ingen pg_cron: resultatet hentes når siden (eller `/handles/status`) spør. Angret kjøring får `result.rolledBackAt`.
- `sync_log`: `action = handle_migrate` / `handle_rollback`, `message = "<gammel> -> <ny>"`, `shopify_id` = produkt-GID. Angre leser herfra — ikke endre formatet.
- Storefront-sjekk fra Supabase gir ofte 429, og Testbutikk er passordbeskyttet (302 → /password). Videresendingene kontrolleres derfor i Admin API (`urlRedirects`).

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

**Aktiv branch (Bokadmin 2.0):** `main` i Raspaball/bokadmin2. (Live Bokadmin bruker `utvikling` / `master` i et eget repo.)

### Credential-flyt

```
Shopify:  Edge Function → _shared/shopify.ts → env SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET
          (samme butikk for alle brukere; user_settings brukes ikke for Shopify)

Bokbasen: Frontend (user JWT) → Edge Function → getUserIdFromJWT() → user_settings.bokbasen_*
                                                   ↓ ikke satt?
                                             env BOKBASEN_CLIENT_ID / BOKBASEN_CLIENT_SECRET
```

### Nødprosedyre — fullstendig tilbakestilling til single-tenant

```bash
# 1. Deploy gammel Edge Function fra master (eller checkout av gammel commit)
supabase functions deploy shopify --no-verify-jwt

# 2. Gjenopprett RLS i Supabase SQL Editor
#    Lim inn og kjør: supabase/migrations/ROLLBACK_multi_tenant.sql
```

DB-kolonnene (`user_id`) og `user_settings`-tabellen forblir, men er ufarlige for single-tenant kode.

## Shopify-tilgang — Dev Dashboard-app og client credentials

Bokadmin 2.0 bruker en app laget i **Shopify Dev Dashboard** (admin-opprettede custom apps med fast `shpat_`-token kan ikke lenger opprettes). Det finnes ingen fast token:

- `_shared/shopify.ts` henter tilgangsnøkkelen med **client credentials grant**:
  `POST https://{SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token` med `client_id`, `client_secret`, `grant_type=client_credentials`.
- Svaret har `access_token` og `expires_in` (86399 s ≈ 24 t). Nøkkelen caches i minnet og fornyes 5 min før utløp. Parallelle kall ved kald start deler én forespørsel.
- Ved HTTP 401 fra GraphQL tømmes cachen og kallet prøves én gang til med ny nøkkel. Først hvis det også feiler, kastes `Shopify HTTP 401`, og jobbene settes til `failed`.
- Client credentials fungerer bare for butikker i **samme organisasjon** som appen, og appen må være **installert** i butikken. Typiske feil fra token-kallet: `application_cannot_be_found` (feil Client ID), `invalid_request: Missing or invalid client secret` (feil secret), `app_not_installed` (appen er ikke installert i butikken).
- Påkrevde tilganger: `read/write_products`, `read/write_inventory`, `read/write_publications`, `read/write_online_store_navigation`.
- `POST /shopify/test` tester serverens tilkobling og returnerer butikknavn, domene og produktantall.

## Skalerbarhet og veikart

### Kjente begrensninger ved store kataloger

- **Shopify filterbegrensning:** Collections med >5 000 produkter mister automatisk filtervisning i storefront (Dawn/OS 2.0). Planlegg informasjonsarkitektur slik at ingen bkg-collection overstiger denne grensen. Hierarkiet vi allerede har (bkg-N/bkg-NN/bkg-NNN) er designet riktig for dette.
- **Per-bok API-loop:** Nåværende `pushOneBook` i en loop skalerer ikke til 17 000+ bøker. Ved fullkatalogeksport vil dette ta mange timer og throttles. Riktig løsning er Shopify Bulk Operations (bulkOperationRunMutation + staged upload).
- **Supabase 1000-rad standardgrense:** Løst — `books.getStats()` bruker `count: exact, head: true` for ekte antall.

### Prioritert roadmap mot kommersiell drift

| Prioritet | Oppgave | Hvorfor |
|---|---|---|
| Høy | Shopify Bulk Operations for fullkatalog-push | Eneste som skalerer til 17k bøker |
| Høy | Graceful 401-håndtering (ugyldig token) | Delvis løst i 2.0: token fornyes automatisk og 401 prøves på nytt. Gjenstår: tydelig melding i UI når appen er avinstallert |
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

**The complete `COLLECTION_NAMES` map** in `supabase/functions/_shared/collection-names.ts` is the authoritative source for all bokgruppe codes and their Norwegian names. All 1-, 2- and 3-digit codes are defined there. Do NOT simplify or truncate this map.

**Sync workflow (2-fase):**
1. `POST /bokbasen/enrich-db` — fills in missing `bokgruppekode` on books in Supabase from Bokbasen ONIX
2. `GET /shopify/analyze-collections` — read-only pre-sync analysis (product count, bkg-tag coverage, collection status). Only counts collections derived from actual product koder — not all possible COLLECTION_NAMES entries.
3. `POST /shopify/sync-collections` — tags all Shopify products with `bkg-*` tags and creates Smart Collections. Only runs after user confirms the analysis.

**Other endpoints:**
- `GET /shopify/count` — single-query product count via `productsCount { count }` (avoids paginating all products just to count)

**Shopify constraints:**
- Menus support max 3 nesting levels total. `buildMenuStructure(maxDepth)` defaults to 2, so bokgruppe categories nest as: Nettbutikk (L1) → bkg-N (L2) → bkg-NN (L3).
- `pushOneBook` checks if the product already has media before adding an image via `productUpdate(media:)` — prevents duplicate images on re-export.
- `shopifyGraphQL` auto-retries on THROTTLED errors with exponential backoff (1s / 2s / 4s, max 3 retries).

**buildMegaMenu:**
Calls `getActiveBkgCodes()` to fetch only bkg-* collections that have ≥1 product, then builds the menu tree via `buildMenuStructureFromCodes()`. Falls back to the full static tree if no active codes are found. Merges bokgruppe structure under the existing "Nettbutikk" item — all other top-level menu items are preserved.
