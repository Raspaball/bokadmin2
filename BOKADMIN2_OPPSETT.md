# Bokadmin 2.0 — oppsett og sikkerhetsregler

Opprettet 2026-09-29 som kopi av Bokadmin slik den kjørte i drift (branch `utvikling`, commit 4a8aa33, pluss ukommitterte endringer i `supabase/functions/shopify/index.ts` og migrasjonen `20260922000000_revert_to_single_tenant_rls.sql`).

**Dagens Bokadmin (C:\Bokadmin, bokadmin.vercel.app, live-prosjektet i Supabase, livebutikken) skal ikke røres fra dette prosjektet.** Live-prosjektets ID står i `C:\Bokadmin\.env`, ikke i dette repoet.

## Hva som er separert

| Del | Bokadmin (live) | Bokadmin 2.0 |
|---|---|---|
| Mappe | C:\Bokadmin | C:\Bokadmin 2.0 |
| Git-branch | `utvikling` / `master` | `main` (i Raspaball/bokadmin2) |
| GitHub | Raspaball/bokadmin, privat | Raspaball/bokadmin2, **offentlig** (remote `origin`) |
| Git-historikk | Full historikk | Starter på nytt fra én commit. Full historikk ligger i live-repoet |
| Supabase | Live-prosjektet | «Bokadmin 2.0», ref `chwpqwblqummlufqdefe` (eu-west-1) |
| Vercel | prosjekt `bokadmin` | Nytt prosjekt — ikke opprettet ennå |
| Shopify | Livebutikken | Kun Test-butikken |
| `.env` / hemmeligheter | Egen | Ikke kopiert. Lag ny fra `.env.example` med 2.0-verdier |

## Opprydding som er gjort

1. pg_cron-migrasjonene (`20260213000001_pgcron.sql`, `20260221000000_pgcron_availability.sql`, `20260226000002_pgcron_scheduled_tasks_with_userid.sql`) inneholdt live-prosjektets URL og anon-nøkkel. De leser nå begge fra Supabase Vault. Opprett hemmelighetene i 2.0-prosjektet **før** migrasjonene kjøres:
   ```sql
   SELECT vault.create_secret('https://<2.0-project-ref>.supabase.co', 'project_url');
   SELECT vault.create_secret('<2.0 anon key>', 'anon_key');
   ```
2. `utils/supabase/info.tsx` og `supabase/functions/server/` (gammel `make-server`) pekte på live-prosjektet og ble ikke brukt. Begge er slettet.

## Regler

1. Repoet er offentlig: commit aldri `.env`, tokens, nøkler eller live-prosjektets ID/URL.
2. Kjør aldri `supabase link` mot live-prosjektet fra denne mappa. `supabase/.temp/` er git-ignorert.
3. Edge Function-hemmeligheter (`SHOPIFY_*`, `BOKBASEN_*`) settes kun i 2.0-prosjektet, med Test-butikkens nøkler.

## Status Supabase 2.0 (oppdatert 2026-09-30)

- Alle 14 migrasjoner er kjørt. `pg_cron` og `pg_net` er på, og `project_url` og `anon_key` ligger i Vault (`project_url` er kontrollert: peker på 2.0-prosjektet).
- De fem Edge Functions (`shopify`, `price-update`, `availability-check`, `sjangre-sync`, `bokbasen`) er deployet til 2.0-prosjektet.
- De tre pg_cron-jobbene (`resume-paused-jobs`, `resume-paused-availability-jobs`, `run-scheduled-tasks`) er **på** igjen fra 2026-09-30. Skru av midlertidig med:
  ```sql
  select cron.alter_job(jobid, active := false) from cron.job;
  ```
- Hemmeligheter satt: `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `BOKBASEN_CLIENT_ID`, `BOKBASEN_CLIENT_SECRET`, `BOKBASEN_SUBSCRIPTION` (`extended`).
- Testet 2026-09-30: ISBN 9788203461392 slått opp i Bokbasen og pushet til Testbutikk. Tittel, forfatter, forlag, pris (449), status ACTIVE, strekkode/SKU, vekt (500 g), mva av, bilde, bkg-tagger (`bkg-3`, `bkg-31`, `bkg-312`) og publisering i 3 salgskanaler er riktige.
- **Kjent avvik (finnes også i live):** SEO-tittel og -beskrivelse blir ikke satt når de første 320 tegnene av beskrivelsen har linjeskift. Push skriver dem som `single_line_text_field`-metafelt; Shopify avviser linjeskift, hele `metafieldsSet`-kallet feiler, og feilen svelges. Løsning: slå sammen mellomrom (`.replace(/\s+/g, " ")`) før `.slice(0, 320)` i `pushOneBook`.
- Andre forhold fra push-testen (finnes også i live): forfatteren «Brochmann, Nina» blir to tagger («Brochmann», «Nina») fordi taggene settes sammen med komma, og tittelen blir en egen tagg.
- **Kjent avvik:** `sync_log` i 2.0-databasen har ingen `job_id`-kolonne, men koden skriver `job_id` (price-update, availability-check, Import, Sjangre, api.ts). Innslagene feiler stille, så jobbloggen er tom. Ingen migrasjon oppretter kolonnen; live-databasen har den trolig fra en manuell endring. Må rettes med en ny migrasjon.

## Shopify-app og API (2026-09-30)

- Appen «Bokadmin 2.0» er laget i Shopify Dev Dashboard og installert i Testbutikk (`testbutikk-9434.myshopify.com`). Kun Testbutikk.
- **Ingen fast `shpat_`-nøkkel.** Edge Functions henter en tilgangsnøkkel med client credentials grant (`POST https://{butikk}/admin/oauth/access_token`, `grant_type=client_credentials`). Nøkkelen gjelder i 24 timer og fornyes automatisk 5 minutter før utløp.
- Alt Shopify-oppsett ligger i `supabase/functions/_shared/shopify.ts`: `SHOPIFY_API_VERSION = "2026-07"`, `getShopifyAccessToken()` og `shopifyGraphQL()`.
- Butikk og nøkler kommer **kun** fra Supabase-hemmelighetene. Shopify-kolonnene i `user_settings` brukes ikke lenger av Edge Functions. Innstillinger-siden viser at Shopify styres av serveren og har bare en «Test tilkobling»-knapp.
- Appen trenger disse tilgangene: `read/write_products`, `read/write_inventory`, `read/write_publications`, `read/write_online_store_navigation`.
- Bytte av app-nøkler: `supabase secrets set SHOPIFY_CLIENT_ID=… SHOPIFY_CLIENT_SECRET=… --project-ref chwpqwblqummlufqdefe` (ingen ny deploy nødvendig). Client ID og secret må høre til samme app, og appen må være installert i butikken i `SHOPIFY_SHOP_DOMAIN`.

## Beslutning: product handles (2026-09-29)

Handle bygges av **tittel + forfatter + ISBN-13**, og bøker slås opp på ISBN i stedet for på handle. Hele begrunnelsen står i prosjektnotatet `claude/beslutning-product-handles.md`.

- Format: `/products/avkledd-nina-brochmann-9788203461392`. Hovedtittelen uten undertittel (det etter kolon), deretter forfatter og ISBN. æ blir ae, ø blir o og å blir a, alt med små bokstaver og bindestrek.
- Handle lages én gang når produktet opprettes, og endres ikke selv om Bokbasen retter tittelen senere.
- ISBN lagres i metafeltet `bok.isbn` (definisjonen skal kreve unike verdier) og som strekkode på varianten.
- Oppslag: `productByIdentifier(identifier: { customId: { namespace: "bok", key: "isbn", value: $isbn } })` erstatter `productByHandle` i `supabase/functions/shopify/index.ts`. Enda bedre er å lagre produkt-GID i Supabase når produktet opprettes.
- Videresending ved bytte av handle: `productUpdate(product: { id, handle, redirectNewHandle: true })`, eller `urlRedirectCreate` (krever `write_online_store_navigation`).
- Spørringene over er validert mot Admin API-skjemaet 29.09.
- Gjelder bare Test-butikken nå. Å migrere livebutikken (ca. 11 000 bøker, med videresending fra `/products/<ISBN>`) er en egen, planlagt jobb.
