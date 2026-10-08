# Live-sjekk 1: koble 2.0 til livebutikken, bare lesing og sjekkmodus

Startet 07.10.2026. Oppdrag fra Eirik (Opus 5.5). Live skal bare leses. Ingen mutasjoner, ingen oppdateringsmodus, ingen push, ingen metafelt-definisjoner.
Denne fila er både framdriftslogg og (til slutt) rapporten i punkt 19. Ingen hemmeligheter, live-domener eller ISBN-lister fra live her (repoet er offentlig).

## Status per 08.10.2026 kl. 18.00 (tabellen er oppdatert; detaljene under er historikk)

| Del | Punkt | Status |
|---|---|---|
| 1 Før tilkobling | 1. Ingen jobber/planlagte oppgaver | **Ferdig.** 0 jobber running/paused, 0 planlagte oppgaver. 5 pg_cron-jobber aktive, men de bare gjenopptar pausede jobber og starter planlagte oppgaver (det finnes ingen) |
| | 2. Skrivesperre LIVE_READ_ONLY | **Ferdig og deployet 08.10.** Commit c3b324c |
| | 3. Butikkstempel på jobber | **Ferdig og deployet 08.10.** Migrasjon 20261007033904 |
| 2 Innstillinger | 4. Lagring | **Ferdig 08.10.** Eirik sa ja til Vault, bare administrator og dobbel lås. Migrasjon 20261008151207 kjørt (først prøvekjørt i en transaksjon som ble angret). Eirik er satt som administrator |
| | 5–7. Skjerm «Butikker», bytte, logg | **Ferdig og deployet 08.10 kl. 17.41** (commit 4ad7c6a). Pushet til GitHub (8abb2ee); Vercel-bygget er klart (READY) |
| | 8. Tester og deploy | 352/352 tester. SQL-test av byttereglene 11/11 (transaksjon angret). Etter deploy: anon får 403 på /shops og /shops/switch; /test svarer Testbutikk, 9 059 produkter, live av |
| 3 Koble til live | 9–11 | **Delvis ferdig 08.10 kl. 17.49.** Profilen «Bø bok og papir» er lagret med secret. Første test: `app_not_installed`. Andre test: ok, «Bø bok og papir», 162 samlinger. **Tellingen viste 10000 produkter: det er Shopifys standardtak (`productsCount` uten `limit: null`), ikke riktig antall (ca. 17 169).** Tilgangene er ikke kontrollert ennå. Live er ikke gjort aktiv |
| 4 Bare lesing | 12–14 | Ikke startet |
| 5 Sjekkmodus | 15–18 | Ikke startet |
| 6 Rapport og pilotplan | 19–23 | Ikke startet |

**Deployet 08.10 kl. 17.41:** shopify, price-update, availability-check, book-update, sjangre-sync, bokbasen (alle med sperrene). Live kobles til via Innstillinger → Butikker, ikke ved å endre `SHOPIFY_*`-hemmelighetene.

## Del 1, detaljer

### Skrivesperre (LIVE_READ_ONLY)
- `_shared/shop-guard.js`: `checkWriteAllowed({ live, readOnly, query })` leser GraphQL-dokumentet: rotfeltene i hver mutasjon, alias, fragmenter på roten, flere operasjoner i ett dokument, strenger og kommentarer. Kan teksten ikke leses sikkert, avvises den.
- `liveReadOnly(value)`: på for alt annet enn nøyaktig `"false"` (standard: på).
- I live slipper bare `bulkOperationRunQuery` gjennom (starter en lesing). Alle andre mutasjoner avvises med «Shopify-sperre: Skrivesperre (LIVE_READ_ONLY) …», også i oppdateringsmodus.
- `_shared/shopify.ts`: `assertWriteAllowed(query)` før hvert GraphQL-kall (i tillegg til den eksisterende live-sperren). `isLiveReadOnly()` eksportert for visning.
- `scripts/lib/clients.mjs` bruker samme sjekk. Det gamle navnemønsteret slapp gjennom bl.a. `collectionAddProductsV2`.
- Tester (`scripts/shop-guard.test.mjs`): alle 85 GraphQL-strengene i Edge Functions: 42 lesinger tillatt, 43 mutasjoner avvist i live. Testbutikk uendret. Hele suiten: 343/343.

### Butikkstempel (jobs.shop_domain)
- Kolonnen `jobs.shop_domain` (migrasjon 20261007033904, bare tillegg, rollback i fila).
- `_shared/job-shop.ts`: `currentShopDomain()` stemples ved oppretting; `stopIfShopChanged(supabase, job)` setter jobben til `failed` ved neste puls hvis butikken er byttet eller stempelet mangler (regel: `jobShopMismatch()` i shop-guard.js).
- Gjelder tilgjengelighet, pris, bokdata (side og bulk), sjangre-sync (bulk og side) og enrich. Handle-migrering: status-polling, verify og rollback avvises (409) hvis butikken ikke stemmer (bruker også `config.shop` fra eldre kjøringer, så en Testbutikk-kjøring kan aldri angres mot live).

### Ikke verifisert ennå
- Full typesjekk av de fem funksjonene (maskinen når ikke deno.land). De delte filene er typesjekket uten feil. Første deploy + test mot Testbutikk avslører resten.
- Sperren er bare testet med enhetstester, ikke i en deployet funksjon.

## Del 2 (ferdig i kode 08.10.2026)

Godkjent av Eirik 08.10. Opprinnelig forslag:
1. Tabell med butikkprofiler (navn, domene, Client ID, om den er live). **Client secret i Supabase Vault**, aldri i tabellen, aldri tilbake til nettleseren. Siden viser bare «lagret».
2. Én rad med aktiv butikk, «åpen til» (høyst 24 t) og skrivesperre (alltid på).
3. Logg over bytter (hvem, når, fra, til, åpen til), uten hemmeligheter.
4. Tabellene har RLS uten lesetilgang for nettleseren; alt går via Edge Function med `getCaller()`. Bare Eiriks bruker (eneste bruker i 2.0) kan endre.
5. Dobbel lås for skriving i live: skrivesperren må være av både i Innstillinger og i hemmeligheten `LIVE_READ_ONLY=false`. Ingen bryter for å slå den av lages nå.
6. Testbutikk-hemmelighetene (`SHOPIFY_*`) blir reserve når ingen profil er valgt.
7. Token-cachen nøkles på domene + Client ID og nullstilles ved bytte.
8. Bekreftelsen ved bytte (skriv domenet + «åpen til») erstatter `LIVE_SHOP_CONFIRMED`/`LIVE_SHOP_UNTIL` som hemmeligheter. Samme regel (`checkShopAllowed`). Bytte avvises mens en jobb kjører eller står på pause.

Neste steg når Eirik har svart: vis SQL for tabellene og Vault-funksjonene (vent på ja) → kode + skjerm → tester → si fra før deploy → deploy alle seks funksjoner → test mot Testbutikk (lesing, mutasjon, bytte avvist mens jobb kjører) → Del 3.

### Slik ble Del 2 laget
- **Database** (migrasjon 20261008151207): `shop_profiles` (navn, domene, Client ID, `secret_id`), `shop_settings` (én rad: aktiv profil, bekreftet domene, `live_until`, `read_only`, `admin_user_id`), `shop_switch_log`. RLS uten policyer, ingen rettigheter for anon/authenticated. Funksjoner (bare service_role): `shop_secret_set/get` (Vault), `shop_switch` (alle regler for bytte), `shop_close` («Lukk live», alltid tillatt).
- **Administrator** er satt med en egen SQL-linje (ikke i git).
- **Server** (`_shared/shopify.ts`): aktiv butikk leses fra databasen (buffer 15 s), ellers `SHOPIFY_*`. Sperren mot live bruker bekreftet domene og `live_until` fra Innstillinger (eller `LIVE_SHOP_*` når butikken kommer fra hemmelighetene). Skrivesperre: på hvis `read_only` i databasen ELLER `LIVE_READ_ONLY` ikke er `false`. Nøkkelbuffer per domene + Client ID.
- **Endepunkter** i `shopify`: `GET /shops`, `POST /shops/save | secret | test | switch | close`. Bare administrator. Secret går bare inn, aldri ut (heller ikke i feilmeldinger eller logg).
- **Skjerm**: «Butikker» øverst i Innstillinger, rød LIVE-stripe øverst på alle sider når live er aktiv. «Test tilkobling» viser butikknavn, domener, antall produkter og samlinger, og appens tilganger. Bare lesing, og den virker uten at butikken er aktiv.
- **Domenet** må være myshopify.com-adressen. Live-domenet står bare i databasen, ikke i git.
- `getShopDomain()` er nå asynkron. Kanalbufferen (`publish.ts`) og de beskyttede produktene (`protected-load.ts`) bufres per butikk, så ingenting fra Testbutikk gjenbrukes etter bytte.

### Typesjekk
- Frontend: `tsc` uten nye feil (2 gamle i Import.tsx og main.tsx).
- Edge Functions: `deno check` med kart for nettadressene som ikke nås fra maskinen. Ingen nye feil. De som gjenstår, fantes før: availability-check 4, shopify 4, price-update 1.
- `SHOP_TEST_QUERY` er validert mot Shopifys skjema.

### Testet 08.10
- SQL-test av byttereglene (transaksjon som ble angret), 11/11: ugyldig domene, uten secret, annen bruker, feil bekreftelse, over 24 t, uten «åpen til», pauset jobb avvist; gyldig bytte med skrivesperre; aktiv profil kan ikke slettes; «Lukk live» med jobb; ingen secret i loggen.
- Etter deploy (kalt fra databasen med pg_net, fordi Cowork ikke når Supabase direkte): anon → 403 på `/shops` og `/shops/switch`; `/test` → Testbutikk, 9 059 produkter, `live: false`, `source: env`.

### Funnet 08.10: produkttellingen stopper på 10 000
`productsCount` har et standardtak på 10 000. Live har ca. 17 169 produkter. Rettingen er `productsCount(query: …, limit: null) { count precision }` (validert mot Shopifys skjema). Steder:
- `_shared/shopify.ts` (`SHOP_TEST_QUERY`)
- `shopify/index.ts` (`/test` og `/count`)
- `availability-check`, `book-update`, `price-update` (`getShopifyProductCount` / `getProductCount`)
- `sjangre-sync` (4 steder)
- `scripts/live-eksport.mjs` linje 98: kontrollen av antall i manifestet ville ellers sagt at 17 169 ≠ 10 000
- `scripts/clean-tags.mjs`

Samlingenes `productsCount` (bkg, under 5 000) trenger ikke endres. Dette må rettes, testes og deployes (etter ja) før Del 4.

### Gjenstår før Del 4
1. Rett tellingen (over), kjør testene, si fra før deploy, og deploy `shopify`, `availability-check`, `book-update`, `price-update` og `sjangre-sync`.
2. Slett hjelpefila `scripts/out/live-sjekk.bundle` (git-ignorert).
3. Kjør én jobb i sjekkmodus mot Testbutikk (for eksempel bokdata med ett ISBN) og se at den får `shop_domain`.
4. Eirik kjører «Test tilkobling» for live på nytt (skal vise ca. 17 169 produkter) og sender lista over tilganger. Kontroller den mot `pakke-i-del-b-live.md` punkt 1.

## Del 3–6: oppskrift for neste økt
- **Del 3:** Profilen er lagt inn (08.10). Gjenstår: ny «Test tilkobling» etter rettingen av tellingen, og kontroll av tilgangene mot `pakke-i-del-b-live.md` punkt 1. Ikke «Gjør aktiv» før Del 5 (live-eksporten i Del 4 går med lokale skript og `LIVE_SHOPIFY_*` i `scripts/.env.local`).
- **Del 4:** Live-eksport med `scripts/live-eksport.mjs --live --bekreft-butikk <domene> --name sjekk-1` (bare lesing, lokale variabler `LIVE_SHOPIFY_*` i `scripts/.env.local`). Sammenlign med kontrolltallene (punkt 13) og rapporter avvik over 3 %. Gi tall for bøker, ikke-bøker og bøker som mangler i Bokbasen (punkt 14).
- **Del 5:** Eirik gjør live aktiv i Innstillinger («åpen til» noen timer, skrivesperren er på). Sjekkmodus i denne rekkefølgen: handles, sjangre, bokdata (bulk), tilgjengelighet, pris. Etter hver jobb: 0 skrivinger (loggen og `sync_log`), og rapport etter punkt 17 a–j. Stopper en jobb på CPU, rapporteres det, uten nye forsøk i det uendelige. Etterpå «Lukk live».
- **Del 6:** Rapport i denne fila og en kort oppsummering i `BOKADMIN2_OPPSETT.md`, pilotliste (50 ISBN, punkt 21), forslag til Liquid for «Forfatter» (punkt 22) og listen i punkt 23. Ingen pilot og ingen oppdateringsmodus.
