# Oppgave til Claude Code: pakke E, etter generalprøve runde 1

Skrevet i Cowork 02.10.2026. Ny økt: les denne fila, `BOKADMIN2_OPPSETT.md` (særlig «Generalprøve runde 1»), `oppgaver/regel-beskyttede-samlinger.md` og `oppgaver/pakke-d-generalprove.md` før du starter.

Miljø: C:\Bokadmin 2.0, repo Raspaball/bokadmin2, Supabase «Bokadmin 2.0» (ref chwpqwblqummlufqdefe), Shopify bare testbutikk-9434.myshopify.com.

## Hvor vi er
- Pakke A, A2, B, C og D (del 0–4) er ferdige. Generalprøve runde 1 (442 produkter) kjørte alle seks stegene uten feil. Resultatene står i BOKADMIN2_OPPSETT.md.
- Beskyttelsen (taggene `gave`, `lokal`, `lokalhistorie`, `lokallitteratur`) virker og gjelder alt.
- De 10 duplikatene er ryddet i Testbutikk med videresending. Duplikatregelen bruker ordrer i live når appen har `read_orders` og `read_all_orders` (ikke lagt til ennå).
- Testproduktene T1–T6 ligger i Testbutikk. T6 («Ester Nilsson», ubeskyttet, tagg «oppgaver») har pris 123 kr med vilje.
- Commit ad935fc (rettet taggregel for sammensatte etternavn og aksenter + rapport) ligger lokalt og er ikke pushet.

## Sikkerhet
- Ikke rør live-systemet: mappa C:\Bokadmin (kan leses), repoet Raspaball/bokadmin, Supabase-prosjektet «Bokadmin» (live), Vercel «bokadmin» og livebutikken.
- Si fra før migrasjoner, deploy og **hver** push. Migrasjoner skal bare legge til. Ingen hemmeligheter eller live-ref i git.
- Beskyttede produkter røres aldri. Valider nye GraphQL-operasjoner mot Testbutikk (2026-07).
- Én commit per del, `node --test scripts/*.test.mjs` før hver commit.

## Del 1: push og prisoppdatering
1. Push ad935fc (si fra først).
2. Kjør prisjobben i **oppdateringsmodus** i Testbutikk. Forventet: bare Prizon UZ 399 → 299 kr endres, og T6 (123 → 429) legges til godkjenning. Eirik avviser T6 på Prisgodkjenning-siden. Rapporter resultatet.

## Del 2: «Egen tilgjengelighet»
1. Lag metafelt-definisjonen `bok.egen_tilgjengelighet` (boolean, festet, navn «Egen tilgjengelighet (Bokadmin endrer ikke status)»).
2. Når den er krysset av, skal tilgjengelighetsjobben og push ikke endre status, lager-innstilling (`inventoryPolicy`) eller `bok.tilgjengelighet`. Logg «Hoppet over: egen tilgjengelighet». Alt annet oppdateres som før.
3. Bakgrunn: 7 engelske bøker med ONIX-kode 40 (blant annet Steve Jobs, Freakonomics, Mindset) ble utkast i generalprøven, men butikken kjøper dem trolig fra andre leverandører.
4. Tester, og test i Testbutikk på én av de 7.

## Del 3: arkiverte produkter
Tilgjengelighetsjobben skal aldri endre arkiverte produkter (ARCHIVED). Logg «Hoppet over: arkivert». Tester.

## Del 4: rapport over statusendringer før live
En sjekk (uten endringer) som lister alle produkter som ville fått ny status, med tittel, ISBN, ONIX-kode, gammel og ny status. Lagres som CSV i `scripts/out/` og vises på Oppdatering-siden, så Eirik kan gå gjennom den og krysse av «Egen tilgjengelighet» der det trengs før overgangen.

## Del 5: raskere bokgrupper og tilgjengelighet
I runde 1 tok bokgrupper 176 + 341 s og tilgjengelighet 194 + 336 s for 442 produkter. For ~11 000 blir det flere timer hver.
1. La sjangersynken (bokgrupper) og tilgjengelighetsjobben bruke `onix_cache` (samme som bokdata) og bulk-operasjoner for skriving, med `bulkOperationRunQuery` for lesing.
2. Samme regler som før, og sjekkmodus som standard. Beskyttede, duplikater, «Egen tilgjengelighet» og arkiverte hoppes over.
3. Mål på nytt i Testbutikk (sjekk og oppdatering), og gi et samlet tidsanslag for hele overgangen med ~11 000 bøker (ONIX-henting, bokgrupper, handles, bokdata, tilgjengelighet, prissjekk).

## Avklart, ingen endring
- De 68 produktene med egendefinert (lesbar) handle beholder handlen.
- «Sūnzi»-taggen i Testbutikk ryddes ved overgangen.

## Til slutt
Oppdater BOKADMIN2_OPPSETT.md og CLAUDE.md. Deploy og push (si fra først). Rapporter kort per del med commit-hash, og bekreft at beskyttede produkter er uendret og live ikke er rørt.
