# Live-sjekk 1: koble 2.0 til livebutikken, bare lesing og sjekkmodus

Startet 07.10.2026. Oppdrag fra Eirik (Opus 5.5). Live skal bare leses. Ingen mutasjoner, ingen oppdateringsmodus, ingen push, ingen metafelt-definisjoner.
Denne fila er både framdriftslogg og (til slutt) rapporten i punkt 19. Ingen hemmeligheter, live-domener eller ISBN-lister fra live her (repoet er offentlig).

## Status per 07.10.2026 kl. 05.45

| Del | Punkt | Status |
|---|---|---|
| 1 Før tilkobling | 1. Ingen jobber/planlagte oppgaver | **Ferdig.** 0 jobber running/paused, 0 planlagte oppgaver. 5 pg_cron-jobber aktive, men de bare gjenopptar pausede jobber og starter planlagte oppgaver (det finnes ingen) |
| | 2. Skrivesperre LIVE_READ_ONLY | **Ferdig i kode, ikke deployet.** Commit c3b324c |
| | 3. Butikkstempel på jobber | **Ferdig.** Migrasjon 20261007033904 kjørt (ja fra Eirik). Kode i c3b324c, ikke deployet |
| 2 Innstillinger | 4. Forslag til lagring | **Forslag gitt, venter på svar** (se under) |
| | 5–8. Skjerm «Butikker», bytte, tester, deploy | Ikke startet |
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

## Del 2, forslag (venter på svar fra Eirik)
1. Tabell med butikkprofiler (navn, domene, Client ID, om den er live). **Client secret i Supabase Vault**, aldri i tabellen, aldri tilbake til nettleseren. Siden viser bare «lagret».
2. Én rad med aktiv butikk, «åpen til» (høyst 24 t) og skrivesperre (alltid på).
3. Logg over bytter (hvem, når, fra, til, åpen til), uten hemmeligheter.
4. Tabellene har RLS uten lesetilgang for nettleseren; alt går via Edge Function med `getCaller()`. Bare Eiriks bruker (eneste bruker i 2.0) kan endre.
5. Dobbel lås for skriving i live: skrivesperren må være av både i Innstillinger og i hemmeligheten `LIVE_READ_ONLY=false`. Ingen bryter for å slå den av lages nå.
6. Testbutikk-hemmelighetene (`SHOPIFY_*`) blir reserve når ingen profil er valgt.
7. Token-cachen nøkles på domene + Client ID og nullstilles ved bytte.
8. Bekreftelsen ved bytte (skriv domenet + «åpen til») erstatter `LIVE_SHOP_CONFIRMED`/`LIVE_SHOP_UNTIL` som hemmeligheter. Samme regel (`checkShopAllowed`). Bytte avvises mens en jobb kjører eller står på pause.

Neste steg når Eirik har svart: vis SQL for tabellene og Vault-funksjonene (vent på ja) → kode + skjerm → tester → si fra før deploy → deploy alle seks funksjoner → test mot Testbutikk (lesing, mutasjon, bytte avvist mens jobb kjører) → Del 3.
