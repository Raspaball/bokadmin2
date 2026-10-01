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
- **Første forsøk hang:** verdiene ble satt mens Shopify fortsatt slettet de gamle i bakgrunnen. Definisjonen ble stående på `validationStatus: SOME_INVALID` (43 gyldige, 0 ugyldige), og customId-oppslag svarte «Metafields have not completed migrating to to be valid for unique capability» i over 30 minutter. Unik kan ikke slås av for typen `id`, og ny lagring av én verdi hjalp ikke.
- **Andre forsøk (samme dag, godkjent av Eirik):** `--recreate --redo` sletter, venter til alle gamle verdier er borte, lager definisjonen og venter til den er `ALL_VALID`. Deretter `--restore --execute`: 43 av 43 satt, `ALL_VALID`, og `--verify` fant 43 av 43 med customId. **Lærdom for livebutikken:** bruk denne rekkefølgen (skriptet håndhever den nå).
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

## Prisregler flyttet til _shared/price.ts (2026-10-01, del 6)

Begge reglene fra gamle Bokadmin er flyttet uendret til `_shared/price.ts`:

- `pickImportPrice(xml)` (import, `bokbasen`): første Price med PriceType 01 eller 02, ellers første beløp.
- `pickPriceUpdatePrice(xml)` (prisjobben): 04 > 03 > 02 > 01 > andre. Prisjobben avviser selv beløp på 0 eller lavere, og avvik under 0,01 kr regnes som ingen endring.

Tester: `scripts/price.test.mjs` (bare 01, 02 og 04 med ulike beløp, bare 03, ingen type, beløp 0, ingen pris).

Gammel kode (lest ordrett fra live-Bokadmin, `C:\Bokadmin`) mot ny, på de samme 10 ekte ISBN-ene: 10 av 10 like for både import og prisjobb. Nye bøker har én Price med type 04, eldre én med type 02. Ingen av 89 hentede poster har mer enn én prisblokk, så reglene gir i dag samme pris.

## Én prisregel: importen bruker fastprisregelen (2026-10-01, del 7)

**Bevisst avvik fra gamle Bokadmin.** Importen i 2.0 velger pris som prisjobben (04 > 03 > 02 > 01 > andre). Gamle Bokadmin tar veiledende pris (første 01/02) ved import. Livebutikken ender uansett på fastprisen når prisjobben har vært innom.

- `pickValidPrice(xml)` i `_shared/price.ts` = `pickPriceUpdatePrice`, men 0 eller lavere godtas ikke. Ingen godkjent pris gir `null`, som før (push setter da pris 0, uendret oppførsel). `pickImportPrice` er fjernet.
- Eneste sted som leser pris fra ONIX er `parseOnix` i `bokbasen`, og den brukes av ISBN-oppslag, søk og datointervall. Produktopprettelse, push og CSV-eksport bruker `book.price` fra den, og får derfor fastprisen.
- Tester: `scripts/price.test.mjs`, der import og prisjobb gir samme pris i alle tilfellene (også 02 og 04 med ulike beløp).
- Med dagens data blir det ingen synlig forskjell: alle 85 hentede poster med pris har én prisblokk (nye: 04, eldre: 02).

## Valuta og gyldighetsdato i prisvalget (2026-10-01, del 8)

### Rådata

Rå ONIX for 103 titler (bare lesing): 43 nye i Testbutikk (2025–26, flere forhåndsbestillinger med tilgjengelighet 10/11), 46 eldre (1990–2012) og 14 fra 2018–2025. Alle er ONIX **3.1**.

| Felt | Funn |
|---|---|
| `CurrencyCode` | Står i hver `Price` (99 av 99 priser). Alltid NOK |
| `DefaultCurrencyCode` i headeren | Finnes ikke (feltet finnes bare i ONIX 2.1) |
| `PriceEffectiveFrom` / `PriceEffectiveUntil` (ONIX 2.1) | Finnes ikke |
| `PriceDate` (ONIX 3) | Bare `PriceDateRole` 15 (til-dato), på 10 av 41 fastpriser (04), f.eks. Avkledd til 2027-02-25, Årstidskvartetten til 2026-10-05. Rolle 14 (fra) finnes ikke |
| `Territory` / `CountriesIncluded` i `Price` | Finnes ikke |
| `Market` → `Territory` | `CountriesIncluded` = NO på 7 av 14 titler fra 2018–2025, ellers ingen |
| Antall priser per bok | Høyst én. 4 bøker uten pris |
| Utløpt fastprisperiode | Bokbasen erstatter 04 med 02 (veiledende) uten datoer. Ingen utløpte 04 er funnet i dataene |

### Regel (`choosePrice` i `_shared/price.ts`, brukt av import og prisjobb)

1. **Valuta:** bare NOK. Mangler `CurrencyCode`, brukes `DefaultCurrencyCode`; mangler begge, regnes prisen som NOK. Aldri annen valuta som reserve.
2. **Territorium:** står det et territorium i `Price` (ellers i `Market` for samme `ProductSupply`), godtas prisen bare hvis NO er med (eller regionen er WORLD uten at NO er unntatt).
3. **Dato:** bare priser som gjelder i dag i Europe/Oslo (`PriceEffectiveFrom/Until` eller `PriceDate` 14/15, til og med sluttdatoen). Pris uten datoer gjelder alltid.
4. **Valg:** blant godkjente priser 04 > 02 > 03 > 01 > andre, altså priser med mva før priser uten (endret i pakke A2 del 5; før 04 > 03 > 02 > 01 som i gamle Bokadmin). For bøker (0 % mva) gir det samme beløp. Ved flere av samme type vinner nyest startdato.
5. **Ingen godkjent pris** gir `null`: prisen endres ikke, og prisjobben logger årsaken i `sync_log` («Ingen endring: ingen NOK-pris», «… ingen pris for Norge», «… ingen gyldig pris i dag», «… ingen pris»). Importen får `null` som før.

**Bevisst strengere enn gamle Bokadmin**, som tar første beløp uansett valuta, territorium og dato.

Tester: `scripts/price.test.mjs` (ONIX 3 og 2.1: NOK og EUR med samme type, bare EUR, `DefaultCurrencyCode`, 04 fra i morgen mot 02 nå, 04 utløpt i går mot 01 uten datoer, to 04 med ulike startdatoer, territorium uten NO, ingen godkjent pris, Oslo-tid).

Kontroll mot Testbutikk (lokalt, bare lesing, 2026-10-01): 65 produkter, 22 uten ISBN, 43 med samme pris som regelen gir, 0 med ny pris, 0 uten godkjent pris. Ingen priser er endret.

## Pakke A steg 3: deploy og røyktest (2026-10-01)

`bokbasen`, `shopify`, `price-update`, `availability-check` og `sjangre-sync` er deployet til 2.0 etter commit 00e920e. Testene er kjørt mot de samme endepunktene som bokadmin2.vercel.app bruker (anon-nøkkel), ikke i nettleseren.

| Test | Resultat |
|---|---|
| Import av én bok (`bokbasen/isbn`) | Avkledd: pris 449 (04), bkg 312. Min evige tysker (1990): pris 259 (02), bkg 411. Alt starter med en drøm: 349, bkg 334 |
| Push, bok med migrert handle (Avkledd) | Funnet, `created: false`, samme produkt, ingen advarsel. `books` er tom, så oppslaget gikk via ISBN (customId) og ikke `shopify_id` |
| Push, bok laget med ny handle (9788205621060) | Funnet, `created: false`, samme produkt |
| Sjangersynk på én bok | Cache-raden for 9788205621060 ble fjernet, og berikingsjobben hentet den fra Bokbasen igjen (334). 65 behandlet, 2 koder funnet (også 9788284680378, som manglet fra før), 41 i cache, 0 feil |
| Katalogliste og søk | 65 produkter (43 ACTIVE, 22 ARCHIVED), 43 med ISBN. Søk «avkledd» treffer, pris 449. `/count` 65 |
| Samlingsanalyse | 43 tagget, 0 trenger tagging, 22 uplasserbare, 25 samlinger |
| Prisjobb, sjekkmodus | 65 av 65 behandlet, 0 avvik, 0 feil, 65 hoppet over (22 uten ISBN, 43 med samme pris). Ingen priser endret |
| Antall produkter etter push | 65 (ingen duplikater) |

Funnet underveis, ikke rettet:
- `price-update/start` bruker `update` som standard når `mode` mangler. Et kall uten `mode` endrer altså priser.
- `collectionCreate(input:)`, `collectionUpdate(input:)` (shopify, sjangre-sync) og `productUpdate(input:)` (`scripts/clean-tags.mjs`) bruker utfasede argumenter. De virker i 2026-07, men bør over på `collection:`/`product:`.
- `sjangre-sync/analyze` leser `books` (tom i 2.0) og viser derfor 0 bøker. Samlingsanalysen i `shopify` gir riktige tall.
- `node --test scripts/` virker ikke på Node 22 (mappe som argument). Bruk `node --test scripts/*.test.mjs` (54 tester).

## Pakke A2 del 1: aldri pris 0 (2026-10-01)

Før satte push `price: book.price ? String(book.price) : "0"` og alltid `status: "ACTIVE"`. En bok uten pris ble lagt ut til 0 kr, og en bok som lå ute fikk prisen overskrevet til 0.

Nå (`_shared/push-price.ts`, brukt av `pushOneBook` og CSV-eksporten):

| Tilfelle | Push (enkelt, «Push alle», bulk) | CSV |
|---|---|---|
| Godkjent pris (> 0) | Som før: pris satt, ACTIVE | Pris, `active` |
| Ny bok uten godkjent pris | Opprettes som **DRAFT**, pris sendes ikke. «Opprettet som utkast: mangler pris (<årsak>)» | `draft`, tom pris |
| Eksisterende bok uten godkjent pris | Pris sendes ikke og blir stående. Status som før. «Pris ikke endret: <årsak>» | `draft`, tom pris |
| Pris 0 eller lavere | Som manglende pris | Som manglende pris |

- Årsaken kommer fra `choosePrice`: importen gir `priceReason` (via `chooseValidPrice`). Mangler den (f.eks. «Push alle» fra `books`), slår push opp boka i Bokbasen. Har Bokbasen fått pris siden importen, står det «Bokbasen har nå X kr, men boka i arbeidslista mangler pris – importer den på nytt».
- Manuell prisendring i katalogen (`/catalog/update`) avviser 0 eller lavere.
- `sync_log`: push med prisnotat logges med status `info` og meldingen «Pushet til Shopify som <handle>. <notat>».
- Import-siden: merket «Mangler pris: blir utkast i Shopify» på bøker i arbeidslisten, og kortet «Mangler pris» med bøkene i arbeidslisten og push-loggen.
- En ny variant uten pris får Shopifys standard 0,00, men produktet er et utkast og kan ikke kjøpes.
- Tester: `scripts/push-price.test.mjs`.

Testet i Testbutikk (shopify og bokbasen deployet):

| Test | Resultat |
|---|---|
| Ny bok uten pris: Katalog 2004 (9788202237868, ingen Price i ONIX) | Opprettet som DRAFT, «Opprettet som utkast: mangler pris (ingen pris)». Produktet er slettet etterpå |
| Eksisterende bok, pris satt manuelt til 111 kr (Avkledd), push uten pris | Pris fortsatt 111, ACTIVE, «Pris ikke endret: Bokbasen har nå 449 kr …». Satt tilbake til 449 |
| Avkledd med pris | Som før: 449, ACTIVE, ingen notat |
| Antall produkter etter testene | 65 |

## Pakke B: standarden i eksporten (SEO og bokfelt, 2026-10-02)

Oppgaven: `oppgaver/pakke-b-seo-eksport.md`. Reglene står samlet i `_shared/book-standard.ts` (én ren funksjon som regner ut ønsket tilstand fra ONIX), og lesingen av ONIX i `_shared/onix.js`.

### Del 1: forfatterne som liste

`extractContributors()` gir `authors: string[]` som «Fornavn Etternavn» i `SequenceNumber`-rekkefølge. Bare rolle A01; finnes ingen A01, brukes første bidragsyter (rollen i `authorRole`). Funn i 103 rå poster: navnene står nesten alltid som `PersonNameInverted` («Brochmann, Nina»: 140 av 144), `PersonName` 1 gang, `NamesBeforeKey`/`KeyNames` aldri, `CorporateName` 3. 10 bøker har flere A01, 19 har ingen A01 (redaktør B01, A09 kartverk/forlag, eller ingen bidragsytere). Listen lagres i `books.authors` (migrasjon `20261002120000_books_authors.sql`), og handle bygges fra den. `firstAuthor()` brukes bare for gamle rader uten liste. Visningsteksten `author` er nå «Fornavn Etternavn, Fornavn Etternavn».

### Del 2: bokfeltene og formatlisten

Alle definisjonene i `bok` fantes i Testbutikk (`forfatter` liste, `format`, `sider` heltall, `utgivelsesaar` heltall, `spraak`, `serie`, `alder`, `thema` liste). Ingen ble laget.

| Felt | Regel (`_shared/onix.js`) | Funn i 103 poster |
|---|---|---|
| `bok.forfatter` | listen fra del 1 | |
| `bok.format` | `bookFormat()` i `_shared/book-format.ts` (under) | |
| `bok.sider` | Extent 00, ellers 07, ellers 08, enhet 03 (sider) | 46 har sidetall (00: 42, 08: 4). Kommende bøker mangler ofte |
| `bok.utgivelsesaar` | PublishingDate 01 (bare årstall hos Bokbasen), ellers PublicationDate | 103 |
| `bok.spraak` | Language rolle 01 → norsk navn (nob Bokmål, nno Nynorsk, eng Engelsk …, mul Flere språk) | Bokmål 82, Engelsk 10, Nynorsk 8 |
| `bok.serie` | Collection type 10 (forlagets serie), ellers 20 (tilordnet av Bokbasen), med nummer: «Ingrid Winter (5)». Type 11 (forlagsrekker som «Cap-serien», «Pekebok», «Cesam pocket») brukes ikke | 23 |
| `bok.alder` | AudienceRange kvalifikator 17 (fra/til): «6–9 år», «fra 12 år». Flere områder slås sammen | 15. Alle med Thema-alder (5A…) hadde også AudienceRange, så Thema brukes ikke som reserve |
| `bok.thema` | Subject skjema 93–99, i rekkefølge | 103 |

Felt uten verdi i ONIX settes ikke, og Bokadmin tømmer dem aldri.

**Format.** `ProductForm`/`ProductFormDetail` i rådataene (koder slått opp i ONIX-liste 150/175):

| ProductForm (+ Detail) | Antall | `bok.format` | productType |
|---|---|---|---|
| BB (+ B502 med trykt omslag) | 61 | Innbundet | Bok |
| BC | 20 | Heftet | Bok |
| BC + B113 (Pocket, Sverige/Norge/Frankrike) | 6 | Pocket | Bok |
| BC + B611 (bare store bokstaver) | 1 | Heftet | Bok |
| ED + E101 (EPUB) | 4 | E-bok | E-bok |
| AJ + A103 (MP3) | 3 | Lydbok | Lydbok |
| CB (falset kart) | 3 | Kart | Bok |
| AB (lydkassett) | 2 | Lydbok | Lydbok |
| DB (CD-ROM) | 2 | Annet | Bok |
| EB (app-lisens, uten e-bokformat) | 1 | Annet | E-bok |

**Formatlisten (godkjent av Eirik 2026-10-02):** Innbundet, Heftet, Pocket, Kartonert, Spiral, Pappbok, Lydbok, E-bok, Kart, Annet. Oversettelse: BB/BG → Innbundet; BA/BC + B113, B114 (storpocket), B101/B104 (massemarked) → Pocket; BA/BC + B115 (kartonnasje), B116 (flexband) → Kartonert; BE eller B312–B314 → Spiral; BA/BC ellers → Heftet; BH → Pappbok; A* → Lydbok; E* med E101/E107/E116 → E-bok; C* → Kart; ellers Annet. Storpocket og Flexband er slått sammen med Pocket og Kartonert (Eiriks valg).

`productType` er nå «Bok», «Lydbok» eller «E-bok» (før: forfatteren). CSV-eksporten bruker `productType` fra importen.

NB: `FORMAT_OPTIONS` i Import.tsx (importfilteret) har feil koder (BD er løsblad, ikke spiral; AB er kassett, AI er DVD-lyd, DA er digitalt fysisk). Filteret matcher på etikett, ikke kode, så det virker, men kodene bør ryddes når filteret flyttes til `src/app/utils/formatCodes.ts`.

### Del 3: produktkategori

Push setter `category` ut fra formatet: Print Books `me-1-3`, Audiobooks `me-1-1`, E-Books `me-1-2` (`CATEGORY_IDS` i `_shared/book-format.ts`, kontrollert mot taksonomien i 2026-07: løvnoder, ikke arkivert). CSV-kolonnen «Product category» følger productType.

### Del 4: SEO-tittel og metabeskrivelse (`_shared/book-seo.ts`)

- **SEO-tittel** (`global.title_tag`): «{Hovedtittel} – {Forfatter} ({format})», maks 60 tegn. For lang: uten format; fortsatt for lang: hovedtittelen kuttes ved helt ord. Uten forfatter: «{Hovedtittel} ({format})».
- **Metabeskrivelse** (`global.description_tag`): høyst 155 tegn. «{Hovedtittel} av {Forfatter} ({format}, {år}).» + starten av forlagsteksten, kuttet ved setningsslutt (hvis etter halvparten), ellers ved helt ord med «…». Avsnitt og linjeskift blir mellomrom (ingen «søtsuget?Glukoserevolusjonens»).
- **Manuelle endringer:** det Bokadmin genererte lagres i `bokadmin.seo_auto` (JSON, skjult metafelt uten definisjon). Et felt skrives bare når det er tomt, lik forrige genererte verdi eller lik den gamle automatikken (tittelen / forlagsteksten kuttet på 320 tegn). Ellers: «SEO-tittel endret manuelt, ikke overskrevet» (push: `seoNote`).
- Tittel og forlagstekst fra ONIX er flyttet uendret fra importen til `_shared/onix.js` (`onixText`, `extractTitle`, `extractDescription`); 20 av 20 bøker ga samme resultat som den deployede importen.

### Del 5: omslag (`_shared/book-cover.ts`)

Alt-tekst «Omslag: {Hovedtittel} av {Forfatter}», filnavn «{handle}-omslag.jpg» (endelsen fra dagens fil). I 2026-07 kan `productUpdate(media:)` ikke sette filnavn, men `fileUpdate` endrer filnavn og alt-tekst på eksisterende bilder uten ny opplasting (testet: samme media-ID, fortsatt koblet til produktet, ny URL; like filnavn er tillatt). Push setter alt-tekst ved opplasting og filnavn med `fileUpdate` etterpå (prøver igjen mens filen behandles). `productUpdateMedia` er utfaset til fordel for `fileUpdate`. **NB før live:** validatoren nevner `write_files` som tilgang for `fileUpdate`; det virket med appens nøkkel i Testbutikk, men sjekk tilgangene i livebutikken.

### Del 6: forlagstekst og reservebeskrivelse

`descriptionHtml()`: ett `<p>` per avsnitt, `<br>` for linjeskift, HTML-koding. Uten forlagstekst: reservebeskrivelse «{Hovedtittel} av {Forfatter}. {Format}, {sider} sider, utgitt {år} på {forlag}.» (det som mangler utelates), og push-notatet «Mangler forlagstekst: reservebeskrivelse brukt». Import-siden har kortet «Mangler forlagstekst» (arbeidslisten og push-loggen). Jobben i del 8 erstatter bare en beskrivelse som er tom, samme tekst med annen formatering, eller Bokadmins egen reserve; en annen tekst får stå («Beskrivelsen er en annen tekst enn forlagsteksten, ikke overskrevet»).

### Del 7: tagger (`_shared/book-tags.ts`)

Push legger ikke lenger forfatter og tittel inn som tagger, og beholder alle andre tagger på eksisterende produkter (før erstattet push hele taggsettet, så f.eks. `folio-test` ville forsvunnet). Den gamle push sendte «Etternavn, Fornavn, Tittel» som én tekst, og Shopify delte den på komma (Avkledd: «Brochmann», «Nina», hele tittelen). Fjernes: tagger lik en forfatter (begge skrivemåter) eller tittelen/hovedtittelen, og delene av et navn/en tittel som ble delt på komma, men bare når alle delene finnes. `bkg-*` og andre tagger røres ikke. Push: `tagNote` «Fjernet tagger: …».

### Del 8: jobben «Oppdater eksisterende bøker»

- Edge Function `book-update` (fanen «Bokdata» på Oppdatering-siden). Samme rammeverk som prisjobben: pulser på 45 s, pause/gjenopptak (pg_cron `resume-paused-book-update-jobs` og siden), avbryt, sjekkmodus som standard. `POST /start { mode, isbns? }`.
- Én ren funksjon `planBookUpdate(produkt, onix)` i `_shared/book-update.ts` gir endringene felt for felt (productType, kategori, `bok.*`, SEO, omslag, beskrivelse, tagger). Endrer aldri pris, status, tilgjengelighet, handle eller tittel. Bulk-eksport i pakke D kan bruke samme funksjon.
- Sammendrag per felt med opptil tre eksempler, og endret / uendret / hoppet over (uten ISBN, uten ONIX) / feil.
- **ONIX-cache:** tabellen `onix_cache` (`isbn`, `xml`, `fetched_at`), cache yngre enn 7 dager brukes (`_shared/onix-cache.ts`). Push bruker også cachen. Migrasjon `20261002130000_onix_cache_book_update.sql` (tabell + pg_cron), kjørt i 2.0.
- Shopify-grenser: `waitForShopifyBudget()` i `_shared/shopify.ts` venter når `extensions.cost.throttleStatus` er lav; 50 produkter per side.

### Del 9: samlingsnavn

`sjangre-sync` og `shopify/sync-collections` retter tittelen på eksisterende bkg-samlinger etter `COLLECTION_NAMES` (`collectionTitleFix` i `_shared/collections.ts`). Handle endres ikke; koder uten navn i lista røres ikke.

**Kjørt i Testbutikk 2026-10-02: 21 samlinger fikk nytt navn**, ikke bare de med «Bokgruppe NNN». Samlingene var laget av sjangre-sync med dens egen, avkortede navneliste, som hadde andre navn enn den felles lista. Noen er bare ny ordlyd (bkg-4 «Norsk skjønnlitteratur» → «Skjønnlitteratur», bkg-31 «Sakprosa» → «Sakprosa norsk, voksne»), andre endrer betydning (bkg-314 «Barn og oppdragelse» → «Natur, friluftsliv, sport», bkg-316 «Friluftsliv og hobby» → «Mat og drikke», bkg-318 «Teknikk og vitenskap» → «Teknikk og populærvitenskap»). Den felles lista (kilde: forleggerforeningen.no) er den autoritative. **Eirik bør se over** at den stemmer med Forleggerforeningens bokgrupper. De gamle titlene står i `scripts/out/a2/samlinger-gamle-titler-2026-10-02.json` (git-ignorert) og kan settes tilbake.

### Test i Testbutikk (2026-10-02)

Deployet: `shopify`, `bokbasen`, `sjangre-sync`, `book-update` (ny). Migrasjoner kjørt: `20261002120000_books_authors.sql`, `20261002130000_onix_cache_book_update.sql`.

| Test | Resultat |
|---|---|
| Sjekkmodus, hele katalogen | 43 ville blitt endret, 0 uendret, hoppet over 22 (22 uten ISBN, 0 uten ONIX), 0 feil. Felt: productType, kategori, format, år, språk, thema, SEO-tittel, metabeskrivelse 43 hver; filnavn på omslag 42; forfatter 36; tagger 36; alt-tekst 35; sider 16; serie 8; alder 4; beskrivelse 1. 7 beskrivelser er en annen tekst enn forlagsteksten og ble ikke overskrevet |
| Oppdateringsmodus på 10 bøker (to/tre forfattere, redaktør, lang tittel, serie, barnebøker, kommende, midlertidig utsolgt) | 10 endret, 0 feil. Kontrollert i Shopify: `bok.*`, kategori Print Books, productType Bok, SEO-tittel (36–58 tegn) og metabeskrivelse (136–155), alt-tekst og filnavn på omslaget, beskrivelse med `<p>`, tagger bare `bkg-*` + `folio-test` |
| Pris, status og handle | 65 av 65 uendret |
| Manuell SEO-tittel på Avkledd, jobben kjørt på nytt | Stod urørt; «SEO-tittel endret manuelt, ikke overskrevet». Satt tilbake etterpå |
| Push av ny bok med to forfattere (9788273842510) | Handle `ta-meg-pa-alt-bare-ikke-pa-ordet-bertil-hokby-9788273842510`, `bok.forfatter` med begge, alle feltene satt, utkast (kode 40). Slettet etterpå |
| Push av ny bok uten forlagstekst og uten bidragsytere (Katalog 2004) | Reservebeskrivelse «Katalog 2004. Heftet, 119 sider, utgitt 2004 på Cappelen Damm AS.», nytt omslag med alt-tekst og filnavn `katalog-2004-9788202237868-omslag.jpg`. Slettet etterpå |
| Samlingssynk | 21 samlinger fikk nytt navn (se del 9), 0 feil |

Gjenstår etter pakke B:
- Se over navnelisten for bokgruppene (del 9).
- Sjekk `write_files` for appen i livebutikken (del 5).
- Bulk-operasjoner for hele katalogen (pakke D) med `planBookUpdate`.
- `FORMAT_OPTIONS` i Import.tsx har feil koder (se del 2) og bør flyttes til `src/app/utils/formatCodes.ts`.
- Strømmer bruker fortsatt utfasede `collectionAddProducts`/`collectionRemoveProducts`.

## Pakke C: kommende og midlertidig utsolgte bøker (2026-10-02)

Oppgaven: `oppgaver/pakke-c-tilgjengelighet.md`. Beslutning (Eirik): kommende og midlertidig utsolgte bøker skal være synlige og kunne kjøpes, ikke utkast (utkast gir 404, og Google mister siden akkurat når kommende bøker gir søketrafikk). Prisregelen (List 58) er ikke endret.

### Regel (`availabilityRule` i `_shared/availability.ts`)

| ONIX List 65 | Status | Kan kjøpes | `bok.tilgjengelighet` |
|---|---|---|---|
| 20–23 | ACTIVE | Ja | `tilgjengelig` |
| 10, 11, 12 | ACTIVE | Ja (forhåndsbestilling) | `kommer` |
| 30–34 | ACTIVE | Ja (vi bestiller) | `midlertidig_utsolgt` |
| 43, 46, 49 | ARCHIVED | Nei | `utgatt` |
| Alt annet, også tom/ukjent kode | DRAFT | Nei | `ikke_tilgjengelig` |

Brukt av tilgjengelighetssjekken, push og CSV-eksporten. Frontend-kopi i `src/app/utils/availabilityCodes.ts`. Importfilteret har nå gruppene Tilgjengelig, Kommer og Midlertidig utsolgt på som standard, og Ikke tilgjengelig, Utgått og Ukjent av.

**Kjøpbarhet.** Funnet i Testbutikk: bøker Bokadmin har laget, har lager som ikke spores (alltid kjøpbare). De migrerte har sporet lager, `inventoryPolicy: DENY` og ulik beholdning, og kan ikke kjøpes når beholdningen er 0. Valgt: den minste endringen er `inventoryPolicy: CONTINUE` på varianten, bare når lageret spores, policyen er DENY og boka skal kunne kjøpes. Beholdning, sporing og lokasjoner røres ikke. CSV-eksporten hadde allerede «continue».

**Utgivelsesdato** (`bok.utgivelsesdato`, `extractPublishingDate` i `_shared/onix.js`). Oppgaven sa PublishingDate rolle 01, ellers PublicationDate. Kontroll mot 103 rå ONIX 3.1-poster: rolle 01 er **alltid bare årstall** (dateformat 05), og PublicationDate finnes ikke i ONIX 3. Hele datoen står i MarketDate rolle 01 for kommende bøker (33 av 33 med kode 10/11) og i PublishingDate rolle 11 for utgitte. Rekkefølgen er derfor: rolle 01 hvis hel dato → MarketDate 01 → PublishingDate 11 → PublicationDate (2.1). Bare årstall gir ingen dato. Importen ga før ingen dato for kommende bøker (den forkastet årstall fram i tid). `publishingDate` (YYYY-MM-DD) er nytt i importsvaret.

### Del for del

| Del | Commit | Innhold |
|---|---|---|
| 1. Metafelt | 8dc3412 | `bok.tilgjengelighet` (single_line_text_field, choices-validering) og `bok.utgivelsesdato` (date), festet, Storefront PUBLIC_READ. Laget i Testbutikk med `node scripts/tilgjengelighet-definisjoner.mjs --create` |
| 2. Tilgjengelighetssjekken | d93a024 | Setter status, metafeltene og `CONTINUE`. Logg: «Ville endret/Endret: Kommer 15.10.2026: ACTIVE, kan forhåndsbestilles (status … → …, tilgjengelighet … → kommer, utgivelsesdato … → 2026-10-15, salg uten lager)». Bokbasen-feil: ingen endring |
| 3. Push og CSV | a9527e8 | Push: status og metafelt etter regelen (ikke lenger alltid ACTIVE), `CONTINUE` ved sporet lager. Ny bok uten pris er fortsatt alltid utkast. Mangler kode eller dato, hentes ONIX én gang (felles med prisårsaken). Bokbasen nede: eksisterende bok beholder status, ny blir utkast. Svaret har `availabilityNote` og `status`, og Import-siden logger notatet. CSV: uten pris `draft`, ellers etter regelen |

### Test i Testbutikk (del 4)

Deployet: `availability-check`, `shopify`, `bokbasen`. Ingen migrasjoner.

| Test | Resultat |
|---|---|
| Sjekkmodus | 43 ville endres, 22 uten ISBN hoppet over, 0 feil. Kommer 33, midlertidig utsolgt 1, tilgjengelig 9. **0 statusendringer**: alle forblir ACTIVE (med den gamle regelen ville 35 blitt utkast). 7 migrerte bøker (4 kommer, 3 tilgjengelig) ville fått `CONTINUE`. Alle 43 får dato |
| Oppdateringsmodus | 43 endret, 0 feil. Ny sjekk etterpå: 0 avvik |
| Tre bøker kontrollert | H (Minier, kode 10, sporet lager, beholdning 5): ACTIVE, `kommer`, 2026-10-02, `CONTINUE`, kan kjøpes. Jeg kommer hjem (kode 31): ACTIVE, `midlertidig_utsolgt`, 2026-09-30, kan kjøpes. Avkledd (21): ACTIVE, `tilgjengelig`, 2026-02-26, kan kjøpes. Naturen er kuren (10): `kommer`, 2026-08-21 |
| Handlekurv på nettsiden | H (Minier) lagt i handlekurven (Eirik, i nettleseren) |
| Push av Naturen er kuren | Importen gir `availability` 10 og `publishingDate` 2026-08-21. Push: «Kommer 21.08.2026: ACTIVE, kan forhåndsbestilles» |
| CSV | Kode 10 og 31 → `active`, 43 → `archived`, uten pris → `draft` og tom pris |
| Priser og status | 65 av 65 produkter med samme pris og status som før testene |

Gjenstår:
- Lage metafeltdefinisjonene i livebutikken før 2.0 går live.
- Visningen i temaet («Kommer 15. november», «Forhåndsbestill», «Midlertidig utsolgt – vi bestiller den til deg»): Folio.
- 301-videresending for utgåtte bøker (43, 46, 49) og kode 41: senere.
- Noen kommende bøker har en utgivelsesdato som er passert (f.eks. 21.08.2026), men har fortsatt kode 10 i Bokbasen. De vises som «kommer» til Bokbasen oppdaterer koden.
- CSV-eksporten leser koden fra boka og henter ikke ONIX. Bøker i arbeidslista uten `availability_code` blir `draft` i CSV.

## Status pakke A2, prissikring

Oppgaven: `oppgaver/pakke-a2-prissikring.md`.

| Del | Status |
|---|---|
| 0. Rydding i git | **Ferdig** (c83acaa, pushet). Live-prosjektets ref i oppgavefilene er byttet med en henvisning til `C:\Bokadmin\.env` |
| 1. Aldri pris 0 | **Ferdig** (1ff7479). `shopify` og `bokbasen` er deployet og testet i Testbutikk (se over). Frontend (Import-siden) er ikke ute ennå: krever push til GitHub |
| 2. Sperre mot store prishopp | **Ferdig** (3468aea, pushet). `price-update` og `shopify` er deployet, og nettsiden er ute. Migrasjonen `20261001120000_price_guard.sql` er kjørt i 2.0. Testet i Testbutikk (se under) |
| 3. Egen pris og tilbud | **Ferdig**, deployet og testet (se under) |
| 4. Tryggere standard og planlegging | **Ferdig**, deployet og testet (se under). Etter eiers valg er **ingen planlagte oppgaver lagt inn** |
| 5. Rekkefølgen på pristypene | **Ferdig**: 04 > 02 > 03 > 01 > andre. Deployet (price-update, bokbasen, shopify). Sjekk i Testbutikk: 0 ville fått ny pris |
| 6. Utfasede `input:`-argumenter | **Ferdig**, deployet (shopify, sjangre-sync) og testet på én kode (bkg-334) |
| «Til slutt» | **Ferdig**: alt deployet, røyktest OK, dokumentasjon oppdatert (se under) |

Del 2, det som er laget:
- `_shared/price-guard.ts`: `checkPriceChange(gammel, ny, grense)` gir `same` (avvik under 0,01 kr), `set` (innenfor grensen), `fix` (gammel pris mangler eller er 0: settes) eller `approval` (over grensen: settes ikke). Akkurat på grensen settes. Tester: `scripts/price-guard.test.mjs`.
- `_shared/price-approvals.ts`: leser grensen fra `user_settings` (standard 30), og skriver én ventende rad per variant i `price_approvals`.
- Prisjobben: i oppdateringsmodus legges endringer over grensen i `price_approvals` og logges «Krever godkjenning: <gammel> → <ny> kr (<x> %)»; `fix` logges «Pris satt: …». I sjekkmodus står det i avviksmeldingen at endringen ville krevd godkjenning.
- Push av eksisterende bok: samme sperre. Prisen sendes ikke, og svaret har `approvalRequired: true` og meldingen i `priceNote`.
- `POST /price-update/approvals/decide { ids, decision: approve|reject }`: krever innlogget bruker. Godkjenning setter prisen bare hvis Shopify-prisen fortsatt er den gamle, og logger «Godkjent av <e-post>: …» i `sync_log` og i raden (`decided_by`, `decision_note`).
- Nettsiden: kortet «Priser som krever godkjenning» på Oppdatering-siden (`PrisGodkjenning.tsx`) med grenseinnstillingen, «Godkjenn»/«Avvis» per rad og for valgte.

Testet i Testbutikk 2026-10-01 (sikkerhetskopi av alle priser før testene, sammenlignet etterpå: 65 av 65 like):

| Test | Resultat |
|---|---|
| Prisjobb, oppdatering. Avkledd satt til 111 (Bokbasen 449) | Ikke endret. «Krever godkjenning: 111 → 449 kr (304,5 %)», ventende rad i `price_approvals` |
| Samme jobb. Utyske satt til 400 (449) | Satt: «Pris endret: 400 → 449 kr» (12,3 %, under grensen) |
| Samme jobb. Borgen satt til 0 (Bokbasen 429) | Satt: «Pris satt: 0 → 429 kr (gammel pris manglet eller var 0)» |
| Push av Ingrid Winter (Winterkalypse nå!) etter manuell pris 200 | Prisen sendes ikke. `approvalRequired: true`, «Krever godkjenning: 200 → 449 kr (124,5 %)» |
| Godkjenn på Oppdatering-siden (Eirik, innlogget) | Avkledd og Ingrid Winter satt til 449. `decided_by` og «Godkjent av eirikvr@gmail.com: …» i raden og `sync_log` |
| Avvis (nytt tilfelle: Ingrid Winter 200, push) | Raden `rejected`, «Avvist av …: 200 → 449 kr (prisen er ikke endret)». Prisen stod på 200, satt tilbake til 449 for hånd |

### Del 3: egen pris og tilbud

`_shared/price-lock.ts` (`priceLock`, `EGEN_PRIS_FIELD`): prisen endres ikke når metafeltet `bok.egen_pris` er true, eller når varianten har `compareAtPrice` (tilbud). Egen pris går foran tilbud.

- Prisjobben: hopper over produktet før Bokbasen-oppslaget og logger «Hoppet over: egen pris» / «Hoppet over: tilbud» (status `info`).
- Push av eksisterende bok: prisen sendes ikke, alt annet oppdateres. `priceNote` = «Hoppet over: …». Ingen godkjenningsrad.
- Godkjenning: avvises med melding hvis produktet har fått egen pris eller tilbud etter at raden ble laget.
- Definisjonen `bok.egen_pris` (boolean, «Egen pris (Bokadmin endrer ikke prisen)», festet) er laget i Testbutikk med `node scripts/egen-pris-definition.mjs --create`. Må kjøres i livebutikken før 2.0 går live.
- Tester: `scripts/price-lock.test.mjs`.

Testet i Testbutikk: Avkledd med `egen_pris` = true og pris 111, Utyske med `compareAtPrice` 499 og pris 400. Prisjobb (oppdatering): begge hoppet over med riktig melding, 0 endret. Push med Bokbasen-pris 449: prisene stod, `priceNote` som over. Satt tilbake (metafeltet slettet, `compareAtPrice` fjernet, 449), og alle 65 produkter er like utgangspunktet.

### Del 4: tryggere standard, sammendrag og planlegging

- `price-update/start` uten `mode` (eller med ukjent verdi) gir `analyze`. Bare `mode: "update"` endrer priser. Det samme gjelder en jobb uten `config.mode`. Nettsiden sender alltid `mode` (`priceJobs.start(mode)` har ikke lenger standardverdi).
- **Sammendrag** (`_shared/price-summary.ts`): prisjobben teller endret / samme pris / krever godkjenning / hoppet over (egen pris, tilbud, uten ISBN) / manglet godkjent pris (per årsak) / feil. Tallene ligger i `config.counts` mellom pulsene og i `result.counts` + `result.summary` når jobben er ferdig. Oppdatering-siden viser `result.summary` i «Siste oppdateringer» og i meldingen når jobben er ferdig.
- Rettet: ved feil midt i en puls rulles markøren tilbake til pulsstart, men tallene ble lagret med økningene, så produktene ble telt to ganger. Nå lagres tallene fra pulsstart.
- **Planlegging** (migrasjon `20261001130000_scheduled_tasks_mode_oslo.sql`, kjørt i 2.0): `run-scheduled-tasks` henter fortsatt URL og nøkkel fra Vault (`project_url`, `anon_key`), og
  - sender `mode` fra `scheduled_tasks.config.mode` for prisjobber (uten mode: `analyze`). Før ble ingen mode sendt, og alle planlagte prisjobber ble oppdateringer.
  - regner `next_run_at` i Europe/Oslo (før: UTC, altså 05:00 norsk sommertid).
  - venter (flytter ikke `next_run_at`) mens en prisjobb for samme bruker er `running`/`paused`/`pending`, og starter høyst én prisjobb per minutt, med oppdatering foran sjekk. Før fikk den andre 409 og forsvant stille.
- Oppdatering-siden: nye planlagte oppgaver får valget «Sjekk (endrer ingen priser)» / «Oppdater priser i Shopify» (`config.mode`), og lista viser modus og om oppgaven er av. Lista viser bare prisoppgaver.
- **Ingen planlagte oppgaver er lagt inn** (eiers valg 2026-10-01). Forslaget var «Nattlig prissjekk» `0 3 * * *` `{"mode":"analyze"}` (på) og «Ukentlig prisoppdatering» `0 3 * * 1` `{"mode":"update"}` (av, slås på ved live). Kan legges inn fra Oppdatering-siden. NB: en ny oppgave med `next_run_at = NULL` kjører innen ett minutt.

Testet: cron-løkka kjørt i en transaksjon som ble rullet tilbake, med to midlertidige oppgaver (oppdatering og sjekk, begge forfalt). Bare oppdateringen ble sendt (`{"mode":"update","user_id":…}`), med neste kjøring 2026-10-05 01:00 UTC (mandag 03:00 Oslo). Sjekken ventet. Ingen oppgaver eller HTTP-kall ble igjen. `price-update/start` med `{}`: `mode` = `analyze`, sammendrag «0 ville fått ny pris, 43 samme pris, 0 ville krevd godkjenning, hoppet over 22 (0 egen pris, 0 tilbud, 22 uten ISBN), 0 manglet godkjent pris, 0 feil».

### Del 5: rekkefølgen på pristypene

`choosePrice` i `_shared/price.ts` velger nå 04 > 02 > 03 > 01 > andre (priser med mva før priser uten). Kommentaren øverst i fila, testene (nye tilfeller: 03 mot 02, 03 mot 04, 01 mot 03, alle fire, 01 mot annen type), regelen over og CLAUDE.md er oppdatert. Prisjobb i sjekkmodus i Testbutikk etter deploy: «0 ville fått ny pris, 43 samme pris, …, 0 feil».

### Del 6: utfasede `input:`-argumenter

Sjekket mot Testbutikk med 2026-07 (introspeksjon; Shopify-validatoren i MCP bruker et eldre skjema der `collection:` ikke finnes):
- `collectionCreate(input:)` og `collectionUpdate(input:)` er utfaset → `collection: CollectionCreateInput` / `CollectionUpdateInput`. Den nye modellen har ikke `ruleSet`; regler heter `sources` (`source.inclusion.conditions[].productTag` med `TAGGED_WITH`). Samlingen blir likevel smart, med samme `ruleSet` (TAG EQUALS bkg-N) og samme produkter. Uten `sources` blir samlingen manuell (strømmer).
- `productUpdate(input:)` → `product: ProductUpdateInput` (`scripts/clean-tags.mjs`).
- `_shared/collections.ts`: `COLLECTION_CREATE_MUTATION`, `COLLECTION_UPDATE_MUTATION`, `tagSources(tag)`, brukt av shopify (bkg-samlinger, strømmer) og sjangre-sync.
- `feedCreate` sendte `collectionType: "MANUAL"`, som ikke finnes i `CollectionInput`, og har trolig aldri virket. Nå `collection: { title }`. Strømmer er fortsatt ikke testet i 2.0.
- `COLLECTION_NAMES` er flyttet til `_shared/collection-names.ts`. sjangre-sync hadde en avkortet kopi, så samlinger fra Sjangre-siden fikk «Bokgruppe NNN» for koder som manglet der (f.eks. 334, 33, 328, 432 i Testbutikk). Eksisterende samlinger har fortsatt det gamle navnet; bare `bkg-334` er laget på nytt («Ungdom»).
- Skanning av alle mutasjoner i koden mot 2026-07: ingen utfasede argumenter igjen. **Gjenstår:** `collectionAddProducts` og `collectionRemoveProducts` (strømmer) er utfaset som hele mutasjoner («Use `collectionUpdate` with inclusion.selectionsToAdd / selectionsToRemove»).

Testet i Testbutikk: midlertidige samlinger (smart og manuell) laget, kontrollert og slettet. `bkg-334` (1 produkt, ikke i meny) slettet og laget på nytt, først av `shopify/sync-collections` (1 opprettet, 24 fantes, 0 feil), så slettet igjen og laget av `sjangre-sync` (hele jobben: 43 tagget fra før, 1 opprettet, 24 fantes, 0 feil). Begge ga smart samling, TAG EQUALS bkg-334, 1 produkt. Ny ID, samme handle; tittelen er nå «Ungdom» (før «Bokgruppe 334»). Priser og status: 65 av 65 som før.

### Til slutt: røyktest og status (2026-10-01)

Deployet til 2.0: `price-update`, `shopify`, `bokbasen`, `sjangre-sync` (`availability-check` er ikke endret i A2). Migrasjoner kjørt: `20261001120000_price_guard.sql`, `20261001130000_scheduled_tasks_mode_oslo.sql`.

| Røyktest (anon-nøkkel, samme endepunkter som nettsiden) | Resultat |
|---|---|
| Push av Avkledd (pris 449) | `created: false`, ingen notat, ingen godkjenning |
| Push av Katalog 2004 (ingen pris i ONIX) | Opprettet som DRAFT, «Opprettet som utkast: mangler pris (ingen pris)». Slettet etterpå |
| Prisjobb, sjekkmodus | «0 ville fått ny pris, 43 samme pris, 0 ville krevd godkjenning, hoppet over 22 (0 egen pris, 0 tilbud, 22 uten ISBN), 0 manglet godkjent pris, 0 feil» |
| Godkjenningslista | 0 ventende (2 godkjent og 1 avvist fra testene i del 2) |
| Priser og status i Testbutikk | 65 av 65 like sikkerhetskopien tatt før testene |

Endret i Testbutikk og ikke satt tilbake (bevisst): metafeltdefinisjonen `bok.egen_pris` (del 3), og samlingen `bkg-334` (ny ID, tittel «Ungdom» i stedet for «Bokgruppe 334»; del 6).

Gjenstår etter pakke A2:
- Lage `bok.egen_pris` i livebutikken (`node scripts/egen-pris-definition.mjs --create`) før 2.0 går live.
- Planlagte prisoppgaver (ingen lagt inn ennå): forslag nattlig sjekk 03:00 og ukentlig oppdatering (av til live).
- Strømmer: `collectionAddProducts`/`collectionRemoveProducts` er utfaset (bruk `collectionUpdate` med `selectionsToAdd`/`selectionsToRemove`), og strømmer er ikke testet i 2.0.
- Samlinger laget av sjangre-sync før del 6 kan ha navnet «Bokgruppe NNN» (f.eks. bkg-33, bkg-328, bkg-432). En synk endrer ikke titler på eksisterende samlinger.
- `sjangre-sync` har ingen pg_cron-gjenopptaking; jobben går bare videre når nettsiden (eller et kall til `/resume`) driver den.

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
