# Bokadmin

Norsk bokhandel-adminverktøy: henter metadata fra Bokbasen, lagrer i Supabase og pusher produkter til Shopify.

## Kom i gang

```bash
npm install
npm run dev        # http://localhost:5173
```

Logg inn med Supabase Auth.

## Teknologistack

| Lag | Teknologi |
|-----|-----------|
| Frontend | React + TypeScript + Tailwind + shadcn/ui (Vite) |
| Database + Auth | Supabase (PostgreSQL + Auth) |
| Backend | Supabase Edge Functions (Deno) |
| Bokmetadata | Bokbasen ONIX v2 API |
| Nettbutikk | Shopify Admin GraphQL API 2026-07 (Dev Dashboard-app) |

## Dataflyten

```
Bokbasen (ISBN-oppslag via ONIX v2)
    ↓  import til arbeidsliste
Supabase – books-tabell  ←── enrich-db fyller inn bokgruppekode
    ↓  push til Shopify
Shopify – produkter med tags + Smart Collections
```

## Nøkkelfunksjoner

### Import (arbeidsliste)
- ISBN-oppslag enkeltvis eller i batch (komma-/linjeskilt)
- Datobasert massehenting fra Bokbasen
- Format- og tilgjengelighetsfiltre
- Push til Shopify (enkeltvis eller bulk)

### Sjangre / Smart Collections

Hvert produkt i Shopify tagges med bokgruppehierarkiet fra Forleggerforeningen:

```
Bokgruppekode 417  →  tags: bkg-4, bkg-41, bkg-417
```

Shopify Smart Collections opprettes automatisk med regel `TAG = bkg-{kode}`, slik at bøker havner i riktig samling på alle tre nivåer (hovednivå, undernivå, spesifikt nivå).

Den fullstendige kodetabellen med alle offisielle navn ligger i [`supabase/functions/shopify/index.ts`](supabase/functions/shopify/index.ts) — konstanten `COLLECTION_NAMES` (linje 83–315). Dette er den autoritative kilden for alle bokgruppekoder og kolleksjonsnavn.

**To operasjoner på Sjangre-siden:**
1. **Hent bokgruppekoder fra Bokbasen** — slår opp og fyller inn manglende `bokgruppekode` på bøker i arbeidslisten (Supabase)
2. **Synk til Shopify** — tagger alle Shopify-produkter med `bkg-*` og oppretter Smart Collections

### Shopify-katalog
Bla gjennom eksisterende Shopify-produkter direkte:
- **Katalog-fanen** — sorterbar tabell med format, kolleksjon, pris, status
- **Klikk en rad** — popup med bilde, full beskrivelse og metadata
- **Arkiv-fanen** — ta øyeblikksbilde av hele Shopify-katalogen som JSON-backup (inkl. SEO, beskrivelse, tags, collections). Nyttig som gjenopprettingspunkt før store endringer.

### Feeder (manuelle samlinger)

Administrer manuelle Shopify-samlinger med drag-and-drop produktsortering. Hvert samlingskort viser en mosaikk med opptil 4 bokomslag. Kun manuelle samlinger vises — bkg-* Smart Collections er filtrert bort.

Inne i en samling: bla gjennom hele Shopify-katalogen for å legge til bøker. Katalogen lastes automatisk og kan sorteres på nyeste/eldste importert, tittel eller forlag.

### Oppdatering
Manuell og automatisk pris- og tilgjengelighetsjobber mot Bokbasen.

**Planlagte jobber (pg_cron):**
- `resume-paused-jobs` / `resume-paused-availability-jobs` — gjenopptar pausede jobber hvert minutt
- `run-scheduled-tasks` — trigger planlagte oppgaver basert på `scheduled_tasks`-tabellen (sender `user_id` i POST-body for per-bruker credentials)

**Jobb-robusthet:** PAGE_SIZE=250, Shopify throttle-retry (exp. backoff), avbryt-knapp i UI, annullering via `/cancel/:jobId`.

**Logging:** Alle endringer loggføres i `sync_log` med ISBN, jobb-ID og tidspunkt. Enkeltoppføringer kan slettes fra UI. Synlig under "Siste oppdateringer" → "Vis logg". Kjøringer fra planlagte oppgaver vises i samme liste som manuelle kjøringer — ingen distinksjon i UI.

**Tilgjengelighetsstatuser (ONIX List 65):**
- ACTIVE: kode 20–23 (tilgjengelig)
- DRAFT: kode 30–34 (midlertidig utilgjengelig), 40–42, 47, 51–52, 1, 9–12
- ARCHIVED: kode 43, 44, 45, 46 (permanent utilgjengelig — bekreftet utsolgt, rettighetstap, trukket)

**Nullpris-guard:** Prisoppdatering avviser automatisk priser ≤ 0 fra Bokbasen.

**Scheduled tasks-atferd:** Ny oppgave triggres UMIDDELBART når den opprettes (fordi `next_run_at IS NULL` → pg_cron plukker den opp innen ~1 minutt). Etter første kjøring settes `next_run_at = IMORGEN kl HH:00`. Toggle-knappen (▷/⏸) aktiverer/deaktiverer oppgaven — avbryter ikke en jobb som allerede kjører.

**Kjente bugs fikset (2026-02-28):**
- `resume-paused` filterte på `user_id IS NULL` → brukerens jobber ble aldri gjenopptatt av pg_cron (jobber fullførte bare mens nettleserfanen var åpen)
- Timeout lagret start-cursor istedenfor endCursor → de samme 250 produktene ble prosessert om igjen og om igjen, aldri fremgang
- Ytre catch satte alltid `"paused"` på feil → 401-feil (ugyldig token) ga uendelig retry-loop

## Edge Functions

| Funksjon | Endepunkter |
|----------|-------------|
| `bokbasen` | `GET /isbn/:isbn`, `GET /date-range`, `GET /search`, `POST /enrich-db` |
| `shopify` | `POST /push`, `POST /push-bulk`, `POST /sync-collections`, `GET /analyze-collections`, `POST /catalog`, `POST /catalog/update`, `POST /export-csv`, `GET /feeds/list`, `POST /feeds/get`, `POST /feeds/create`, `POST /feeds/delete`, `POST /feeds/add-products`, `POST /feeds/remove-products`, `POST /feeds/update`, `POST /feeds/reorder` |
| `price-update` | `/start`, `/resume/:id`, `/resume-paused`, `/status/:id`, `/cancel/:id`, `/active`, `/recent` |
| `availability-check` | `/start` (mode: analyze\|update), `/resume/:id`, `/resume-paused`, `/status/:id`, `/cancel/:id`, `/active`, `/recent` |
| `sjangre-sync` | `/start`, `/resume/:id`, `/resume-paused`, `/status/:id`, `/analyze`, `/recent` |

## Deploy

```bash
# Edge Function (Bokadmin 2.0 — alltid med 2.0-prosjektets ref)
supabase functions deploy <navn> --no-verify-jwt --use-api --project-ref <2.0-project-ref>

# Secrets
supabase secrets set BOKBASEN_CLIENT_ID=... --project-ref <2.0-project-ref>
supabase secrets set BOKBASEN_CLIENT_SECRET=... --project-ref <2.0-project-ref>
supabase secrets set SHOPIFY_SHOP_DOMAIN=butikk.myshopify.com --project-ref <2.0-project-ref>
supabase secrets set SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=shpss_... --project-ref <2.0-project-ref>
```

## Multi-tenant arkitektur

Multi-tenant er fullt implementert og merget inn i `master` (2026-02-21).

- **`user_settings`-tabell** — lagrer Shopify- og Bokbasen-credentials per bruker
- **`user_id`-kolonne** på alle tabeller — dataisolasjon mellom brukere via RLS
- **Trigger `set_user_id_on_insert`** — setter `user_id` automatisk ved insert fra frontend
- **Innstillinger-side** — Bokbasen-credentials per bruker, test av Shopify-tilkoblingen, koble eksisterende data (Shopify settes på serveren i 2.0; onboarding-veiviseren er fjernet)

### Shopify-tilkoblingsmodell

Bokadmin 2.0 bruker en app laget i **Shopify Dev Dashboard** og installert i butikken. Det finnes ingen fast `shpat_`-token: Edge Functions henter en tilgangsnøkkel med client credentials grant (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`), som gjelder i 24 timer og fornyes automatisk i `supabase/functions/_shared/shopify.ts`. Shopify settes opp på serveren, ikke per bruker i `user_settings`. Se `CLAUDE.md` og `BOKADMIN2_OPPSETT.md`.

### Nødprosedyre

```bash
supabase functions deploy shopify --no-verify-jwt
# Kjør supabase/migrations/ROLLBACK_multi_tenant.sql i Supabase SQL Editor
# for å gjenopprette originale RLS-policyer. Ingen data slettes.
```

## Viktige API-begrensninger

- **Bokbasen:** Støtter kun ISBN-oppslag — ingen fritekstsøk på tittel/forfatter
- **Shopify 2026-07:** Bruk `productVariantsBulkUpdate` (ikke fjernede `productVariantUpdate`)
- **Shopify 2026-07:** SKU og vekt ligger på `InventoryItem`, ikke `ProductVariant`
- **Shopify 2026-07:** SEO settes med `metafieldsSet` (`namespace: "global"`, nøkler `title_tag` / `description_tag`). Utfasede kall er byttet ut; se `CLAUDE.md`
- **Shopify filtergrense:** Collections med >5 000 produkter mister automatisk filtervisning i storefront. Bokgruppe-hierarkiet (bkg-N/bkg-NN/bkg-NNN) er designet for å holde collections under denne grensen.
- **Fullkatalog-skalering:** Nåværende per-bok API-loop er ikke egnet for >5 000 bøker. Shopify Bulk Operations (bulkOperationRunMutation) er ikke implementert ennå.

## Trygg videreutvikling

Supabase har daglige snapshots tilgjengelig 7 dager bakover (Dashboard → Settings → Backups). I tillegg følger prosjektet disse prinsippene:

- **Migrasjoner er alltid additive** — aldri editer eksisterende migrasjonsfiler, alltid opprett ny fil. Historikken er alltid rekonstruerbar.
- **Rollback-filer** — skriv en rollback-seksjon eller egen rollback-fil ved større skjemaendringer (`ROLLBACK_multi_tenant.sql` er malen).
- **Dump før store endringer** — eksporter `books`-tabellen som CSV fra Supabase Table Editor, eller via `supabase db dump --data-only -t books`, før migrasjoner som berører eksisterende data.
- **Edge Functions er reverserbare** — revert til gammel git-commit og redeploye ved behov.
- **Kode utvikles på `utvikling`-branchen** og merges til `master` etter testing.

## Roadmap

| Prioritet | Oppgave | Merknad |
|---|---|---|
| Høy | Shopify Bulk Operations for fullkatalog-push | Nødvendig for 17k+ bøker |
| Høy | Graceful håndtering av ugyldig/revokert access token (401) | Stille feil i dag |
| Middels | Webhook for `app/uninstalled` | Rydd opp credentials automatisk |
| Lav | Standard Shopify metafields (`facts.isbn`, `descriptors.subtitle`) | Dawn-interoperabilitet |
| Lav | Theme App Extension + app blocks | Rik produktvisning uten manuell temaredigering |
| Lav | CSV-opplasting av tilgjengelighetskoder | Placeholder i UI, ikke implementert |
