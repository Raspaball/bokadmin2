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
| 4 Bare lesing | 12–14 | **Ferdig 08.10 kl. 18.13.** Live-eksport tatt (bare lesing), tellingene stemmer, ingen avvik over 3 %. Se «Del 4: resultat» under. Punkt 14 delvis (Bokbasen ikke sjekket) |
| 5 Sjekkmodus | 15–18 | **Fire av fem ferdige 08.10, pris 85 % (full kjøring pågår).** 0 skrivinger i alle. Se «Del 5: resultat» |
| 6 Rapport og pilotplan | 19–23 | **Foreløpig rapport skrevet 09.10 (pris basert på 85 %).** Pilotliste, Liquid-forslag og punkt 22–23 gjenstår |

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

## Del 4: resultat (08.10.2026 kl. 18.13, bare lesing)

Eksport `live-sjekk-1` ligger bare lokalt i `scripts/data/` (git-ignorert). Kjørt med `--live`, som bare tillater lesing (utskriften: «mutasjoner tillatt: ingen»). Tellingen bruker nå `limit: null`; commit 9b3c8f1 og Edge Functions deployet 08.10.

**Kontroll mot butikkens egne tall:** 17 169 av 17 169 produkter og 162 av 162 samlinger → OK. Filene: 17 169 produkter og varianter, 77 101 metafelt, 17 121 bilder, 162 samlinger (48 245 medlemskap), 2 videresendinger, 7 salgskanaler, 83 metafeltdefinisjoner.

### Sammenligning med kontrolltallene fra 2. oktober (punkt 13)

| Kontrolltall (02.10) | Nå (08.10) | Avvik |
|---|---|---|
| 17 169 produkter: 14 693 aktive, 2 449 utkast, 27 arkiverte | Samme | 0 % |
| 162 samlinger, ingen over 5 000, størst bkg-4 med 4 152 | 162, ingen over 5 000, bkg-4 4 152 (så bkg-2 3 653 og bkg-21 2 617) | 0 % |
| Wrendale 57, Nyheter 6, Anbefalinger 5 | Samme. Samlingen wrendale finnes (kravet om å stoppe gjelder ikke). Lokalhistorie 63, Gaveartikler 83 | 0 % |
| 60 ISBN på 121 produkter (duplikater) | 60 ISBN på 121 produkter | 0 % |
| 422 lesbare adresser, 16 580 ISBN-adresser | 422 og 16 546 | 0 % / 0,2 % (34 færre; mitt telleskript leser ISBN fra strekkode, SKU eller adresse, og den gamle tellingen kan ha brukt en annen definisjon) |
| 201 produkter uten ISBN | 201 | 0 % |
| 3 280 aktive ikke publisert i Online Store, hvorav 1 415 Gyldendal | 3 280, hvorav 1 415 Gyldendal (3 278 har ISBN) | 0 % |
| 7 salgskanaler, 2 videresendinger | 7 (Online Store, Point of Sale, Google & YouTube, Facebook & Instagram, Snapchat Ads, Inbox, App) og 2 | 0 % |
| Ingen bok.*-definisjoner og ingen bok.*-felt | 0 definisjoner, 0 produkter med bok.*-felt | 0 % |
| Ca. 1 157 uten bkg-tagger, 1 173 med andre tagger enn bkg | 1 157 og 1 173 | 0 % |
| Kategori: «Media > Books» 12 656, tom 762 | 12 656 og 762 (Print Books 3 559) | 0 % |

**Ingen avvik over 3 %.** Katalogen er med andre ord uendret siden 2. oktober.

### Tall til punkt 14
- **Med ISBN:** 16 968 produkter (16 952 med 978, 16 med 979). **Uten ISBN:** 201.
- **Uten ISBN:** 143 av de 201 er beskyttede (lokal, gave, Wrendale). De 58 øvrige er blant annet 47 uten produkttype og noen med forfatternavn som produkttype.
- **Beskyttede totalt:** 197 produkter (tagg, leverandør eller samlingen wrendale). 54 av dem har ISBN.
- **Bøker som ikke er beskyttet og har ISBN:** 16 914.
- **Kanaler:** 3 280 aktive er i 6 kanaler (mangler Online Store), 11 413 i alle 7, og 2 476 i ingen (det er de 2 449 utkastene og 27 arkiverte).
- Bare 1 produkt har produkttypen «Bok» i dag.
- **Ikke sjekket:** hvor mange av de 16 914 som er fysiske bøker og hvor mange som ikke finnes hos Bokbasen. Det krever ONIX-oppslag og kommer fram i sjekkmodus (Del 5), ikke i eksporten.

## Del 5: resultat (sjekkmodus mot live, 08.10.2026)

Alle jobbene er kjørt med `mode: analyze` mens live var aktiv med skrivesperre på (`read_only`) og «åpen til» innenfor 24 timer. Alle jobbradene har butikkstempel som stemmer med live. **Ingen jobb sendte noen skriving**: «Bulk: 0 operasjoner» i alle fire ferdige jobber, og skrivesperren avviser alt annet. Handles-analysen lager ingen jobbrad (se under).

| Jobb | Tid | Resultat |
|---|---|---|
| Handles (analyse) | ca. 40 s | Plan for 17 169 produkter |
| Sjangre (bokgrupper og samlinger) | 1 t 31 min | Ferdig, 0 feil |
| Bokdata (book-update, bulk) | 1 t 03 min | Ferdig, 0 feil |
| Tilgjengelighet (bulk) | 1 t 47 min | Ferdig, 0 feil |
| Pris | 1 t 35 min til 85 %, stoppet av utløpt «åpen til» | **Ikke ferdig.** 14 664 av 17 169. Ny full kjøring pågår |

### 17a Handles
- 16 546 ISBN-adresser får ny adresse (tittel-forfatter-ISBN); 14 525 uten merknad og 1 973 «mangler forfatter» (da blir adressen tittel-ISBN).
- Hoppet over: 58 duplikater (flagget), 58 uten ISBN, 197 beskyttede, 368 lesbare adresser som beholdes (de 422 lesbare = 368 + 54 beskyttede). Kollisjoner: 0.
- Migrering er ikke tillatt i live (`allowed: false`).

### 17b Produkter uten ISBN (201)
58 uten ISBN og ikke beskyttet, 143 beskyttede. I alle jobbene er de hoppet over (58 «ingen_isbn» i sjangre, bokdata og tilgjengelighet, 197 beskyttede i hver); 0 planlagte endringer. Medlemskort og bokpakker er blant dem uten ISBN og er dermed uberørt. Ikke kontrollert enkeltvis på tittel.

### 17c Forsiden
Samlingene Nyheter (6 produkter) og Anbefalinger (5): **ingen** har statusendring. Ingen settes til utkast eller arkivert.

### 17d Status (tilgjengelighet)
1 042 produkter får ny status; CSV ligger lokalt (`scripts/out/statusendringer-2026-10-08.csv`, ikke i git).
- Aktiv → utkast: **564**. 549 av dem har ONIX-kode 40, resten 42 (2), 51 (4) og 97 (9).
- Utkast → aktiv: **174** (mest 21: 92, 31: 51, 33: 23).
- Utkast → arkivert: 224. Aktiv → arkivert: 80 (kode 41: 75, 43: 3, 46: 1, 47: 1).
- 129 av dem som er skjult i dag (aktive, ikke publisert i nettbutikken) får ny status: 106 til utkast og 23 til arkivert.
- Videresending: 303 til samling, 0 til ny utgave, 1 uten mål.
- 46 produkter får sporing av beholdning slått av.
- Hoppet over: 197 beskyttede, 25 arkiverte, 118 duplikater, 58 uten ISBN, 348 ikke bok.

### 17e Salgskanaler
Bokdata: 306 aktive bøker ville blitt publisert på 306 kanaler de mangler. Tilgjengelighet: 16 bøker (112 kanaler). Dette er langt under de 3 280 skjulte. Årsaken er funnet: se «De 3 280 skjulte bøkene». Alle 3 280 er på de samme 6 kanalene og mangler bare Online Store. Åpne spørsmål 1 og 5 er ikke avgjort.

### 17f Produkttype og forfatter
16 446 får produkttypen «Bok». 0 bøker hoppes over fordi de mangler hos Bokbasen (0 «uten ONIX»). Dagens forfatter i produkttypen byttes dermed for nesten alle.

### 17g Tagger
Sjangre: 856 produkter får bkg-tagger, 15 591 har dem, 0 uten bokgruppekode. Bokdata: tagger endres på 766. 16 447 får `bok.bokgruppe`. Hva som skjer med hver enkelt emnetagg (skjoenn-rom, Faglitteratur osv.) er ikke telt opp.

### 17h SEO
SEO-tittel settes på 16 441, metabeskrivelse på 16 435. Står som manuelle: 5 titler og 12 beskrivelser. Beskrivelsen er en annen tekst enn forlagsteksten og overskrives ikke: 1 763.

### 17i Institusjoner og forfattere
124 institusjonsnavn på 485 bøker (ikke forfatter). `bok.forfatter` settes på 16 131. Bøker med flere forfattere er ikke telt, og 5 eksempler er ikke hentet.

### 17j Kategori
13 031 får kategori (fra «Media > Books» og tom til «Print Books»).

### Bokgrupper og samlinger
2 samlinger ville blitt laget (82 og 824), 68 ville fått nytt navn (for eksempel «Lærebøker og fagbøker» til «Skolebøker»), 85 finnes.

### Pris (foreløpig, basert på 85 %: 14 664 av 17 169)
- Uendret: 13 275. Ville fått ny pris: **749** (5,1 % av dem som er sjekket).
- Hoppet over: 348 ikke bok, 139 beskyttede, 78 duplikater, 51 uten ISBN, 1 egen pris.
- **23 «feil»** er ikke tekniske: alle har meldingen «Ingen endring: ingen gyldig pris i dag» (ingen godkjent pris fra Bokbasen). Hvilke bøker det gjelder (ONIX-kode) er ikke undersøkt.
- Rader til prisgodkjenning (over 30 % endring): ikke undersøkt for denne kjøringen; 0 nye rader i `price_approvals`.
- Tallene lagret lokalt i `scripts/out/live-pris-85prosent.json`. Den nye fulle kjøringen avløser dem.

### Hendelser under kjøringen
1. En testjobb som skulle gå mot Testbutikk gikk mot live, fordi live allerede var aktiv. Den var bare sjekk, 0 loggrader, og stoppet av seg selv da live ble lukket.
2. Prisjobben stoppet (`failed`, ikke pause) da «åpen til» gikk ut. En `failed`-jobb kan ikke gjenopptas; en ny jobb må startes.

## De 3 280 skjulte bøkene: kartlegging (09.10.2026, bare lesing)

Kjørt mot live i sjekkmodus: én lesespørring for kanalene, ONIX fra Bokbasen og de samme reglene som jobbene bruker. Ingenting er publisert eller endret. Detaljer per bok ligger i en Excel-fil lokalt (`scripts/out/skjulte-boker-3280-detaljert.xlsx`, ikke i git). Skriptene er `scripts/skjulte-boker.mjs` og `scripts/skjulte-boker-xlsx.py`.

### Hvorfor bare 306 av 3 280? (det enkle svaret)
Regelen som publiserer bøker, rører ikke en bok der **produkttypen allerede er noe annet enn «Bok»**. I live står forfatteren i produkttypen (for eksempel «Herresthal, Harald»), og det gjelder **2 956 av de 3 280**. De hoppes over, og bare de **324 som har tom produkttype**, kan publiseres. Jobben endrer produkttypen til «Bok» først i samme kjøring, men sjekker kanalene med den gamle verdien. Tilgjengelighetsjobben publiserer dessuten bare når en bok *blir* aktiv, og disse er allerede aktive; derfor ble det bare 16 der.

### Trinn for trinn (antall igjen etter hvert trinn)
| Trinn | Igjen |
|---|---|
| Aktive, ikke publisert i Online Store | 3 280 |
| har ISBN | 3 278 |
| ikke beskyttet | 3 278 |
| ikke duplikat-ISBN | 3 275 |
| finnes hos Bokbasen | 3 275 |
| er fysisk bok (ProductForm B, A, E og boktype «Bok») | 3 224 |
| blir eller forblir aktiv etter ONIX-regelen | 3 095 |
| **produkttype er tom eller «Bok» i dag** | **284** |
| mangler kanaler, altså publiseres | 284 |

**306 i bokdata-sjekken = 284 + 22.** Bokdata-jobben ser på statusen i dag (aktiv), ikke på statusen ONIX-regelen gir. De 22 er bøker som tilgjengelighetsjobben ville gjort til utkast (11) eller arkivert (11), men som bokdata-jobben likevel ville publisert. Det er verdt å vite: rekkefølgen mellom jobbene betyr noe.

Kanalregelen ser på alle kanaler en bok mangler, ikke bare Online Store. Alle 3 280 mangler nøyaktig Online Store (de er på de 6 andre kanalene: Facebook & Instagram, Google & YouTube, Point of Sale, Snapchat Ads, Inbox og App). Ingen andre aktive produkter mangler noen kanal.

### Fakta om de 3 280
- **Opprettet:** alle i februar 2025. Største forlag: Gyldendal 1 415, Cappelen Damm 434, Vigmostad & Bjørke 317 (+68 under annet navn), Fagbokforlaget 248.
- **ONIX-kode i dag:** 21 «tilgjengelig» 2 969, 20: 69, 23: 59, 22: 1, 31–34: 43, 40: 109 (ikke tilgjengelig), 41: 22 (utgått), 42: 1, 46: 1, 51: 3, 97: 1, tom: 2.
- **Ny status etter regelen:** 3 141 forblir aktive, 114 blir utkast, 23 blir arkivert, 2 uten ONIX.
- **Fysisk bok:** 3 227 ja, 51 nei (blant annet ProductForm PF, SA, ZZ, PR, XM), 2 uten ISBN. Alle 3 278 med ISBN finnes hos Bokbasen.
- **Pris:** ingen har pris 0 i dag. 2 mangler gyldig pris hos Bokbasen (de uten ISBN). 243 har en dagens pris som avviker mer enn 0,50 kr fra Bokbasen (prisjobben tar seg av dem). **Kommende bøker (kode 10–12): 0.** Ingen har utgivelsesdato i 2026 eller senere.
- **Duplikat-ISBN:** 3. **Beskyttede:** 0. **Uten ISBN:** 2.

### Anbefaling (bare sjekkmodus-regelen)
| Anbefaling | Antall | Hva det betyr |
|---|---|---|
| Publiser | 284 | Regelen publiserer dem allerede i dag |
| Sjekk manuelt | 2 811 | Ville blitt publisert så snart produkttypen er «Bok» (**antakelse**: at bokdata-oppdateringen er gjort først) |
| Hold utenfor | 185 | 102 + 3 + 1 blir utkast (ONIX 40, 51, 42), 22 + 1 blir arkivert (41, 46), 51 er ikke fysiske bøker, 3 duplikater, 2 uten ISBN |

Sammen er det **3 095 bøker som kan bli synlige** i nettbutikken hvis produkttypen settes til «Bok» først, og **185 som bør holdes utenfor**. Dette er ikke et vedtak; det er regelens svar.

### Det Eirik må avgjøre
1. Skal de ca. 3 095 bøkene synliggjøres i nettbutikken (åpen avgjørelse 1 og 5), og i så fall skal det gjøres i to omganger (først produkttype «Bok», så kanaler), eller skal vi endre regelen slik at kanaler sjekkes etter at produkttypen er satt? Å endre regelen er ikke gjort.
2. De 129 som blir utkast eller arkivert (ONIX 40 m.fl.): skal de heller forbli aktive, men skjulte, eller følge ONIX-regelen?
3. Skal de 51 som ikke er fysiske bøker (lydbøker, e-bøker, annet) få en egen vurdering?
4. Rekkefølgen mellom bokdata og tilgjengelighet: bokdata ser på dagens status, og kan publisere bøker som tilgjengelighetsjobben siden gjør til utkast.

### Det som er antakelse eller ikke sjekket
- «Sjekk manuelt» bygger på antakelsen over (produkttype «Bok» satt først). Det er ikke gjort i live.
- ONIX er hentet i dag (09.10), så koder og priser er som Bokbasen sier nå.
- Hvorfor Gyldendal-bøkene (1 415) ble skjult i februar 2025 er ikke undersøkt.

## Del 6: foreløpig rapport (09.10.2026)

**Live er nå tillatt for lesing og sjekkmodus** under sperrene (bekreftet domene, «åpen til» høyst 24 t, skrivesperre, butikkstempel på jobber). Prosjektinstruksene må oppdateres av Eirik.

### Ikke sjekket ennå
- Pris: full kjøring pågår (85 % er foreløpig). De 23 uten gyldig pris, godkjenningsrader.
- Punkt 14: hvor mange av 16 914 bøker som er fysiske ifølge Bokbasen (bare «ikke bok»: 348–349 hoppet over av format).
- 17e: fordeling per kanal, og hvorfor bare 306 av 3 280 skjulte ville bli publisert.
- 17g: tellinger per emnetagg. 17i: bøker med flere forfattere og 5 eksempler hver.
- Punkt 18: sammenligning av 10 tilfeldige bøker med eksporten.
- Punkt 21–23: pilotliste (50 ISBN, kun lokalt, ikke i git), Liquid-forslag for «Forfatter» og listen over det som må være klart før piloten.
- Ingen pilot og ingen oppdateringsmodus er startet.

## Del 3–6: oppskrift for neste økt
- **Del 3:** Profilen er lagt inn (08.10). Gjenstår: ny «Test tilkobling» etter rettingen av tellingen, og kontroll av tilgangene mot `pakke-i-del-b-live.md` punkt 1. Ikke «Gjør aktiv» før Del 5 (live-eksporten i Del 4 går med lokale skript og `LIVE_SHOPIFY_*` i `scripts/.env.local`).
- **Del 4:** Live-eksport med `scripts/live-eksport.mjs --live --bekreft-butikk <domene> --name sjekk-1` (bare lesing, lokale variabler `LIVE_SHOPIFY_*` i `scripts/.env.local`). Sammenlign med kontrolltallene (punkt 13) og rapporter avvik over 3 %. Gi tall for bøker, ikke-bøker og bøker som mangler i Bokbasen (punkt 14).
- **Del 5:** Eirik gjør live aktiv i Innstillinger («åpen til» noen timer, skrivesperren er på). Sjekkmodus i denne rekkefølgen: handles, sjangre, bokdata (bulk), tilgjengelighet, pris. Etter hver jobb: 0 skrivinger (loggen og `sync_log`), og rapport etter punkt 17 a–j. Stopper en jobb på CPU, rapporteres det, uten nye forsøk i det uendelige. Etterpå «Lukk live».
- **Del 6:** Rapport i denne fila og en kort oppsummering i `BOKADMIN2_OPPSETT.md`, pilotliste (50 ISBN, punkt 21), forslag til Liquid for «Forfatter» (punkt 22) og listen i punkt 23. Ingen pilot og ingen oppdateringsmodus.
