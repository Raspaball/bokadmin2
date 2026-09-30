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
| Vercel | prosjekt `bokadmin` | prosjekt `bokadmin2` → https://bokadmin2.vercel.app (deployer `main`; `VITE_SUPABASE_*` peker på 2.0-prosjektet) |
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
- **Rettet i 2.0 2026-09-30 (feilen finnes fortsatt i live):** SEO-tittel og -beskrivelse ble ikke satt når de første 320 tegnene av beskrivelsen hadde linjeskift. Push skriver dem som `single_line_text_field`-metafelt; Shopify avviser linjeskift, hele `metafieldsSet`-kallet feilet, og feilen ble svelget. `pushOneBook` slår nå sammen mellomrom før `.slice(0, 320)`. Verifisert med ny push av 9788203461392.
- ~~Viktig før flere bøker pushes: `pushOneBook` slår opp på handle = ISBN og lager duplikat av bøker med ny handle.~~ **Løst 2026-09-30**, se «Handles i drift» under.
- Andre forhold fra push-testen (finnes også i live): forfatteren «Brochmann, Nina» blir to tagger («Brochmann», «Nina») fordi taggene settes sammen med komma, og tittelen blir en egen tagg.
- **Rettet 2026-09-30:** `sync_log` manglet `job_id`-kolonnen som koden skriver og filtrerer på, så jobbloggen var tom. Migrasjonen `20260929231224_add_sync_log_job_id.sql` legger den til (uten fremmednøkkel, fordi Import bruker egne UUID-er). Kjørt i 2.0-prosjektet og verifisert. Live-databasen har kolonnen fra før, trolig fra en manuell endring.
- Migrasjonen `20260929193439_bokadmin2_extensions_and_vault` er kjørt i 2.0-prosjektet, men finnes ikke som fil i `supabase/migrations/`. Bør legges inn (uten hemmeligheter) slik at repoet kan gjenskape databasen.

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

## Handles i drift (2026-09-30)

Beslutningen over er innført i 2.0 og testet mot Testbutikk.

- **Eksport:** nye produkter får handle fra `buildBookHandle()` i `_shared/handle.js`. Oppslag før opprettelse: `books.shopify_id` → ISBN → handle = ISBN (eldre produkter) → ny handle (migrerte produkter). Eksisterende produkter beholder sin handle. `bok.isbn` settes og `shopify_id` lagres i `books` ved hver push.
- **Avvik fra planen:** `productByIdentifier(customId: bok.isbn)` avvises i Testbutikk med «Metafield definition of type 'id' is required when using custom ids». Definisjonen `bok.isbn` har altså ikke typen `id`. Koden faller tilbake til søk på strekkode/SKU med eksakt ISBN-kontroll. Skal customId brukes, må definisjonen lages på nytt med typen `id` (egen beslutning, rører data i butikken).
- **ISBN leses aldri fra handle** lenger (unntatt eldre produkter der handle er et rent ISBN): `extractIsbn()` i `_shared/isbn.js` brukes av pris-, tilgjengelighets- og sjangerjobbene og samlingsanalysen.
- **Migrering fra nettsiden:** siden «Handles» (analyse, endre, kontroller, angre). `migrate`/`rollback` svarer 403 mot andre butikker enn Testbutikk med mindre `ALLOW_HANDLE_MIGRATION=true` er satt i 2.0-prosjektet. Hemmeligheten er **ikke** satt.

Testet 2026-09-30 mot Testbutikk (via de samme endepunktene som siden bruker):

| Test | Resultat |
|---|---|
| `node --test scripts/handle.test.mjs` | 15 av 15 bestått |
| a. Push ny bok (9788205621060) | Opprettet som `alt-starter-med-en-drom-antonio-nusa-9788205621060`, `bok.isbn` satt uten feil, `shopify_id` lagret i `books` |
| b. Push samme bok igjen | Samme produkt (`created: false`), både via `shopify_id` og, med `shopify_id` tømt, via ISBN. Ett treff i katalogen |
| c. Analyser | 65 produkter: 35 får ny handle, 8 allerede riktige (7 + boka fra test a), 22 uten ISBN hoppes over, 1 mangler forfatter («Atlas for nysgjerrige sjeler 2»), 0 duplikat/kollisjon. Forventet var ca. 36 — tallet var 35 også før test a |
| d. Endre handles | 35 endret i én bulk-operasjon, 0 feil, ingen fikk suffiks. 35 av 35 `urlRedirects` peker til ny handle. **301 på selve nettsiden kunne ikke sjekkes:** butikken er passordbeskyttet (302 → /password), og kall fra Supabase får 429 |
| e. Sjangersynk (samlingsanalysen) | 43 bøker funnet (36 tagget + 7 med ISBN uten tagg), 22 uplasserbare = demoproduktene |
| e. Prisjobb, analysemodus | 65 av 65 behandlet, 0 feil. Jobben logger ikke hoppede produkter, så «ISBN funnet» og «samme pris» kan ikke skilles i tellingen |
| f. Angre, så migrer på nytt | 35 satt tilbake (videresending slettet først), plan igjen 35. Ny kjøring: 35 endret, 35 av 35 videresendinger riktige |
| Ekstra: push av migrert bok (Avkledd) | Funnet via ISBN og oppdatert, ingen duplikat |

Testbutikk står nå med nye handles (andre kjøring). Testboka 9788205621060 ligger i Testbutikk og `books`.

Gjenstår:
- Sjekke 301 i nettleseren med storefront-passordet (f.eks. `/products/9788203461392`).
- ShopifyKatalog bruker fortsatt `handle` som ISBN til formatoppslag og ISBN-visning. Bør bruke strekkode/`bok.isbn`.
- `analyzeCollections`, `fullSyncCollections` og sjangre-sync henter produkter uten statusfilter (se CLAUDE.md om `status:active OR …`). Uendret her.
- `bok.isbn` som typen `id` (se avvik over), og om `bok.forfatter` skal settes ved push.
- Livebutikken: migreringen er klar, men krever `ALLOW_HANDLE_MIGRATION=true` og at 2.0 har erstattet dagens Bokadmin (live tåler ikke nye handles).
