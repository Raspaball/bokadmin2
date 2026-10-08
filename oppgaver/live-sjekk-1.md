# Live-sjekk 1: koble 2.0 til livebutikken, bare lesing og sjekkmodus

Startet 07.10.2026. Oppdrag fra Eirik (Opus 5.5). Live skal bare leses. Ingen mutasjoner, ingen oppdateringsmodus, ingen push, ingen metafelt-definisjoner.
Denne fila er både framdriftslogg og (til slutt) rapporten i punkt 19. Ingen hemmeligheter, live-domener eller ISBN-lister fra live her (repoet er offentlig).

## Status per 07.10.2026 kl. 05.45

| Del | Punkt | Status |
|---|---|---|
| 1 Før tilkobling | 1. Ingen jobber/planlagte oppgaver | **Ferdig.** 0 jobber running/paused, 0 planlagte oppgaver. 5 pg_cron-jobber aktive, men de bare gjenopptar pausede jobber og starter planlagte oppgaver (det finnes ingen) |
| | 2. Skrivesperre LIVE_READ_ONLY | **Ferdig i kode, ikke deployet.** Commit c3b324c |
| | 3. Butikkstempel på jobber | **Ferdig.** Migrasjon 20261007033904 kjørt (ja fra Eirik). Kode i c3b324c, ikke deployet |
| 2 Innstillinger | 4. Lagring | **Ferdig 08.10.** Eirik sa ja til Vault, bare administrator og dobbel lås. Migrasjon 20261008151207 kjørt (først prøvekjørt i en transaksjon som ble angret). Eirik er satt som administrator |
| | 5–7. Skjerm «Butikker», bytte, logg | **Ferdig i kode** (commit 4ad7c6a), ikke deployet |
| | 8. Tester og deploy | 352/352 tester. SQL-test av byttereglene venter på godkjenning. Deploy venter på ja |
| 3 Koble til live | 9–11 | Ikke startet |
| 4 Bare lesing | 12–14 | Ikke startet |
| 5 Sjekkmodus | 15–18 | Ikke startet |
| 6 Rapport og pilotplan | 19–23 | Ikke startet |

**Viktig:** Sperren mot live (pakke I del B, commit 6b69f7a) og skrivesperren er IKKE deployet. Funksjonene i Supabase er fra 06.10. Ingen må sette `SHOPIFY_SHOP_DOMAIN` til live før deploy. Deploy gjøres samlet etter Del 2 (Eirik sa ja 07.10).

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

### Gjenstår før Del 3
1. SQL-test av byttereglene i en transaksjon som angres: avvist uten secret, annen bruker, feil bekreftelse, over 24 t, uten «åpen til», pauset jobb; gyldig bytte; «Lukk live» med jobb; ingen secret i loggen. Første forsøk ble stoppet ved godkjenningen. Ingenting ble endret.
2. Deploy av seks funksjoner (`shopify`, `price-update`, `availability-check`, `book-update`, `sjangre-sync`, `bokbasen`) og frontend (Vercel bygger fra `main` på GitHub).
3. Test mot Testbutikk etter deploy: «Test tilkobling», en jobb i sjekkmodus, bytte avvist mens jobben kjører, «Lukk live».
