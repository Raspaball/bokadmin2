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
- ~~**Avvik fra planen:** `bok.isbn` hadde ikke typen `id`, så customId-oppslag ble avvist.~~ Definisjonen er laget på nytt med typen `id` 2026-10-01, se «bok.isbn som typen id» under.
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
- ~~ShopifyKatalog bruker handle som ISBN~~ — rettet 2026-09-30, se under.
- ~~`analyzeCollections`, `fullSyncCollections` og sjangre-sync henter produkter uten statusfilter~~ (rettet 2026-10-01, se «Statusfilter» under).
- ~~`bok.isbn` som typen `id`~~ (gjort 2026-10-01). Om `bok.forfatter` skal settes ved push.
- Livebutikken: migreringen er klar, men krever `ALLOW_HANDLE_MIGRATION=true` og at 2.0 har erstattet dagens Bokadmin (live tåler ikke nye handles).

## bok.isbn som typen id (2026-10-01)

Definisjonen `bok.isbn` i Testbutikk er slettet og laget på nytt med typen `id`, slik at `productByIdentifier(identifier: { customId: { namespace: "bok", key: "isbn", value } })` kan brukes. Livebutikken er ikke rørt.

- Verktøy: `scripts/isbn-definition.mjs` (`--status`, `--recreate`, `--restore [--execute]`, `--verify`). Nøkler i `scripts/.env.local`. Kjører bare mot Testbutikk.
- Før: 65 produkter, 43 med `bok.isbn` (type `single_line_text_field`). Alle 43 verdiene var lik strekkoden. Sikkerhetskopi: `scripts/out/bok-isbn-backup-testbutikk-9434-for-sletting.json` (git-ignorert).
- Ny definisjon: samme navn («ISBN»), nøkkel, beskrivelse, storefront `PUBLIC_READ`, festet, admin-filtrerbar, unik (typen `id` krever unik). 43 verdier satt inn igjen fra strekkoden (eksakt ISBN-13), alle av typen `id`.
- **Avvik:** Shopify står med `validationStatus: SOME_INVALID` (43 gyldige, 0 ugyldige), og customId-oppslag svarer «Metafields have not completed migrating to to be valid for unique capability». Trolig fordi verdiene ble satt mens Shopify fortsatt slettet de gamle verdiene og bygde unik-indeksen. Unik kan ikke slås av for typen `id`, og ny lagring av én verdi hjalp ikke. Lærdom for livebutikken: vent til definisjonen er `ALL_VALID` og `metafieldsCount` er 0 før verdiene settes inn igjen.
- **Eksport (pushOneBook):** oppslaget er nå `books.shopify_id` → customId `bok.isbn` → strekkode/SKU → handle = ISBN → ny handle. Feiler customId-oppslaget med en GraphQL-feil (feil type, eller migreringen over), brukes strekkode/SKU for det kallet. Før stoppet en slik feil hele push. Bare «type 'id' is required» huskes for resten av instansen.
- **Handle-migreringen** slår ikke opp enkeltbøker. Den henter hele katalogen og bruker `extractIsbn` (bok.isbn → strekkode → SKU → ISBN-handle), som allerede har riktig rekkefølge. Ingen endring.

## Statusfilter på produktspørringer (2026-10-01)

Filteret står ett sted: `ALL_PRODUCT_STATUSES` i `_shared/shopify.ts` (`status:active OR status:draft OR status:archived`). `_shared/handle-migration.js` og skriptene har teksten selv (ren JS).

Målt i Testbutikk: `products` uten filter ga 65 av 65 (43 ACTIVE, 22 ARCHIVED). Arkiverte kommer altså med også uten filter. Butikken har ingen utkast, så det er ikke kontrollert for DRAFT. Filteret er lagt inn uansett, så spørringene ikke avhenger av Shopifys standard.

Endret (skal treffe hele katalogen):

| Hvor | Spørring |
|---|---|
| sjangre-sync | taggefasen, berikingsfasen, `catalog-bkg-stats`, og `productsCount` i tagge- og berikingsfasen, `analyze` og `start` |
| shopify | `analyzeCollections`, `fullSyncCollections` (`ALL_PRODUCTS_QUERY`), katalogen (`CATALOG_PRODUCTS_QUERY`), katalogsøket (`(søk) AND (statusfilter)`), `/count` og `/test` (`productsCount`) |
| price-update, availability-check | Hadde filteret. Bruker nå konstanten |
| scripts/clean-tags.mjs | produktløkka |

Med vilje ikke endret:

| Hvor | Hvorfor |
|---|---|
| shopify: oppslag på strekkode/SKU ved push | Hadde filteret fra før |
| shopify: `collection.products` (feeds, `getActiveBkgCodes`) | Produkter i en samling, ikke et katalogsøk. Feltet tar ikke `query` |
| sjangre-sync: `collections(…)` ved sletting av tomme samlinger | Samlinger, ikke produkter |
| `_shared/handle-migration.js`, `scripts/migrate-handles.mjs`, `scripts/isbn-definition.mjs` | Hadde filteret fra før |

## Én Bokbasen-innlogging (2026-10-01)

`_shared/bokbasen-auth.ts` erstatter de fem kopiene i `bokbasen`, `shopify`, `price-update`, `availability-check` og `sjangre-sync`.

- `getBokbasenCredentials(userId)`: `user_settings.bokbasen_client_id` + `bokbasen_client_secret` (begge må være satt), ellers `BOKBASEN_CLIENT_ID` / `BOKBASEN_CLIENT_SECRET`. Abonnement fra `user_settings.bokbasen_subscription` / `BOKBASEN_SUBSCRIPTION`, ellers `extended`. `null` hvis ingenting er satt.
- `getBokbasenToken(legitimasjon eller userId)`: henter token fra `auth.bokbasen.io`, caches per klient-ID til 60 s før utløp. Feil: `Bokbasen auth failed: <status> …`.
- `clearBokbasenToken()`: sjangre-sync tømmer cachen ved 401 eller feil, slik den før hentet nytt token.
- Små forskjeller fra før: `shopify` godtok ett felt fra `user_settings` og resten fra hemmelighetene. Nå gjelder samme regel som i de andre (begge eller ingen). Sjangre-sync hadde ikke cache; nå deler den cachen.
- Testet: `deno check` på alle fem, og enhetstest av modulen med falsk `fetch` (5 av 5). Testes mot Bokbasen ved deploy.

## Bokgruppekode: skjema 37 (2026-10-01)

Rå ONIX hentet fra Bokbasen (bare lesing, via `bokbasen/isbn/<isbn>?raw=true`) for 89 titler: de 43 bøkene i Testbutikk (nye, 2025–26) og 46 eldre titler (1990–2012) fra alle bokgrupper. Lagret i `scripts/out/onix*/` (git-ignorert). Bokbasen leverer ONIX **3.1** med lange tagger.

ONIX-kodeliste 27: **37 = «Bokgrupper»** (Forleggerforeningen), **38 = «Varegrupper»** (Bokhandlerforeningen, 5 sifre), **23 = «Publisher's own category code»**.

| Type | Eksempel | År | Skjema 37 | Skjema 38 | Skjema 23 |
|---|---|---|---|---|---|
| Skjønnlitteratur, norsk | Utyske (9788203462566) | 2026 | 411 | 41010 | – |
| Krim, oversatt | Joona Linna (9788234713958) | 2026 | 427 | 43010 | – |
| Sakprosa | Avkledd (9788203461392) | 2026 | 312 | 39020 | – |
| Barn | Årstidskvartetten (9788248940470) | 2025 | 432 | 46040 | – |
| Ungdom | Vardari (9788234729836) | 2026 | 434 | 47010 | – |
| Tegneserie (Thema X, Dewey 741.59) | Espens hemmelige dagbok (9788205379800) | 2008 | 430 | 45020 | – |
| Tegneserie, engelsk | Garfield at 25 (9780345455307) | 2002 | 703 | 45020 | – |
| Eldre roman | Min evige tysker (9788202125387) | 1990 | 411 | 41010 | – |
| Eldre barnebok | Redd Lerpolds! (9788210035739) | 1992 | 433 | 46060 | – |
| Billigbok/pocket | Døde menns klubb (9788202160203) | 1997 | 504 | 43030 | – |
| Skolebok | Kunststücke 2 (9788205189065) | 1990 | 120 | 12010 | – |
| Kart | Finland (9788202086367) | 1992 | 810 | 71500 | – |

Alle 89: skjema 37 finnes i alle, alltid 3 sifre. Skjema 23 finnes i ingen. (Andre skjemaer: 38, 93 Thema, 24 «Bokbasen_LitteraryType», D3/C8 Nasjonalbibliotekets emneord, 01 Dewey med `SubjectSchemeVersion` 23/nor — det er Dewey-utgave 23, ikke skjema 23.)

- Det er skjema 37 som gir de tre sifrene bkg-taggene og de smarte samlingene bruker. Ingen reserve til 23 er lagt inn.
- Lesingen ligger nå i `extractBokgruppekode()` i `_shared/onix.js` (ren JS + `.d.ts`), brukt av `bokbasen`, `shopify` og `sjangre-sync`. Første kode med 1–3 sifre vinner. Før tok `bokbasen` den siste og godtok hva som helst; for dataene over gir det samme resultat. Tester: `scripts/onix.test.mjs`.
- Ingen bkg-tagger i Testbutikk er endret.

## Prisregler flyttet til _shared/price.ts (2026-10-01)

Begge reglene fra gamle Bokadmin er flyttet uendret til `_shared/price.ts`:

- `pickImportPrice(xml)` (import, `bokbasen`): første Price med PriceType 01 eller 02, ellers første beløp.
- `pickPriceUpdatePrice(xml)` (prisjobben): 04 > 03 > 02 > 01 > andre. Prisjobben avviser selv beløp på 0 eller lavere, og avvik under 0,01 kr regnes som ingen endring.

Tester: `scripts/price.test.mjs` (bare 01, 02 og 04 med ulike beløp, bare 03, ingen type, beløp 0, ingen pris).

Gammel kode (lest ordrett fra live-Bokadmin, `C:\Bokadmin`) mot ny, på de samme 10 ekte ISBN-ene: 10 av 10 like for både import og prisjobb. Nye bøker har én Price med type 04, eldre én med type 02. Ingen av 89 hentede poster har mer enn én prisblokk, så reglene gir i dag samme pris.

## Funksjoner testet i 2.0 for første gang (2026-09-30)

Mot Testbutikk, via de samme endepunktene som sidene bruker. Livebutikken er ikke rørt, og 2.0 skal ikke prøves mot den ennå.

| Funksjon | Resultat |
|---|---|
| Shopifykatalog: ISBN | **Rettet.** Katalog og søk returnerer `isbn` fra `extractIsbn`. 43 av 43 bøker har ISBN, format funnet for 43 av 43 (før: ingen av de migrerte). Søk på ISBN treffer også strekkode/SKU |
| Katalog: redigering | Tittel og pris endret og satt tilbake på Avkledd. Handle uendret |
| Prisjobb, analyse | Fant nøyaktig det ene avviket vi la inn (111 → 449 kr) på en migrert bok |
| Prisjobb, oppdatering | Satte prisen tilbake til 449 kr i Shopify. 64 andre uendret, 0 feil |
| Tilgjengelighetssjekk, analyse | 65 behandlet, 0 feil. 35 avvik: bøker som ikke er utkommet (ONIX 10: 27, 11: 8) er ACTIVE men skal være DRAFT |
| Tilgjengelighetssjekk, oppdatering | **Ikke kjørt** (eiers valg): den ville satt 35 av 43 bøker i Testbutikk til utkast |
| Sjangersynk (hele løpet på Sjangre-siden) | **Feilet først, rettet.** Se under. Etter rettelsen: 43 koder, 7 tagget, 36 tagget fra før, 22 samlinger opprettet + 3 fantes, 0 tomme slettet. `analyze-collections`: 43 tagget, 0 gjenstår |

Feil funnet i sjangersynken (arvet fra live, finnes trolig der også):
1. Bokbasen-oppslaget brukte `login.bokbasen.io`, `api.bokbasen.io/onix/v2/` og skjema 23. Alle oppslag feilet. Nå likt `bokbasen/` og `shopify/`.
2. Koder for ISBN uten rad i `books` ble aldri lagret (sjekken på `content-range: */0` slår aldri til), så tagge-fasen fant ingenting. Å rette sjekken ville lagt rader med tittel = ISBN og uten pris i `books`, som er arbeidslista på Import-siden: «Push alle» ville da overskrevet tittel og satt pris 0 i Shopify. Kodene lagres nå i den nye tabellen `bokgruppe_cache` (migrasjon `20260930120000_bokgruppe_cache.sql`, kjørt i 2.0-prosjektet).
3. «Tøm liste» på Import-siden sletter hele `books`, også bokgruppekodene. Med `bokgruppe_cache` mister sjangersynken ikke lenger kodene sine.

Fortsatt ikke testet i 2.0: tilgjengelighetssjekk i oppdateringsmodus, megamenyen (`build-menu`), strømmer (opprette, legge til, fjerne, sortere, slette), planlagte oppgaver via pg_cron, CSV-eksport og øyeblikksbilder av katalogen.
