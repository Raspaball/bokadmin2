# Oppgave til Claude Code: pakke A2, prissikring (Bokadmin 2.0)

Skrevet i Cowork 01.10.2026. Følg delene i rekkefølge. Spør Eirik hvis noe er uklart eller ser ut til å treffe live-systemet.

Miljø: C:\Bokadmin 2.0, repo Raspaball/bokadmin2, Supabase «Bokadmin 2.0» (ref chwpqwblqummlufqdefe), Shopify bare testbutikk-9434.myshopify.com.

## Sikkerhet
- Ikke rør live-systemet: C:\Bokadmin, repoet Raspaball/bokadmin, Supabase-live-prosjektet (ref i C:\Bokadmin\.env), Vercel «bokadmin» og livebutikken. C:\Bokadmin kan leses for å sammenligne.
- Du er den eneste som gjør Supabase-endringer mens dette pågår. Si fra før du kjører migrasjoner eller deployer.
- Migrasjoner skal bare legge til. Legg aldri hemmeligheter i git.
- Valider nye eller endrede GraphQL-operasjoner mot Admin API 2026-07.
- Én commit per del. Kjør `node --test scripts/*.test.mjs` før hver commit.
- Ikke endre priser i Testbutikk utenom testene som er beskrevet her. Sett tilbake det du endrer.

## Del 0: rydding i git
1. Legg `oppgaver/` inn i git (filene inneholder ingen hemmeligheter).
2. Før du pusher: kontroller at `origin` er Raspaball/bokadmin2. Søk gjennom alt som skal pushes etter hemmeligheter (`git grep` på `secret`, `shpat_`, `client_secret`, `token`, og nøkkelverdiene i `scripts/.env.local`). Bekreft at `.env.local` og `scripts/out/` er ignorert.
3. Push `main` til origin. Si fra før du pusher.

## Del 1: aldri pris 0 (haster, må være på plass før den store testimporten)
I dag setter push `price: book.price ? String(book.price) : "0"` og alltid `status: "ACTIVE"` (`shopify/index.ts`, ca. linje 647 og 682). En bok uten godkjent pris blir dermed lagt ut til 0 kr, og en bok som allerede ligger ute får prisen overskrevet til 0.

Ny oppførsel:
1. **Ny bok uten godkjent pris:** opprettes som `DRAFT`, uten å sette pris. Den skal ikke kunne kjøpes. Push-resultatet og `sync_log` sier «Opprettet som utkast: mangler pris (<årsak>)», og årsaken hentes fra `choosePrice`.
2. **Eksisterende bok uten godkjent pris:** prisen sendes ikke med i variantoppdateringen, så den blir stående som den er. Statusen endres ikke av denne grunnen. Logg «Pris ikke endret: <årsak>».
3. **Pris 0 eller lavere** behandles som manglende pris, og settes aldri.
4. **Samme regel i alle veier ut til Shopify:** enkeltpush, «Push alle», bulk og CSV-eksport. I CSV skal en rad uten pris få `Status = draft` og tom pris, ikke 0. Finn alle steder som setter pris eller status.
5. **Liste i Bokadmin:** vis bøker som mangler pris (i `books` og/eller i loggen) på Import-siden, så Eirik ser hva som må følges opp.
6. **Tester:** ny bok uten pris blir utkast uten pris. Eksisterende bok uten pris beholder prisen. Bok med pris oppfører seg som før.
7. **Test i Testbutikk:** én bok uten pris (finn en blant de 4 uten pris i rådataene fra del 8, eller lag et testtilfelle), og én eksisterende bok der prisen er satt manuelt. Sett tilbake etterpå.

Ikke endre tilgjengelighetslogikken (ONIX List 65) eller annen statuslogikk i denne pakka. Det kommer i pakke C.

## Del 2: sperre mot store prishopp
1. Ny innstilling `max_price_change_pct` i `user_settings`, standard 30. Migrasjonen skal bare legge til.
2. **Prisjobben i oppdateringsmodus:** er endringen større enn grensen (|ny − gammel| / gammel), endres ikke prisen. Logg «Krever godkjenning: <gammel> → <ny> kr (<x> %)». Er den gamle prisen 0 eller mangler, skal den nye settes (det retter en feil), og det logges.
3. **Push av eksisterende bok:** samme sperre. Prisen beholdes, og push-resultatet viser at den krever godkjenning.
4. **Godkjenning:** en liste i Bokadmin over priser som krever godkjenning, med knapper for «Godkjenn» (én eller valgte) og «Avvis». Godkjenning setter den nye prisen i Shopify og logger hvem som godkjente.
5. **Tester** for: under grensen, over grensen, gammel pris 0, grensen satt til en annen verdi.

## Del 3: egen pris og tilbud
1. Opprett metafelt-definisjonen `bok.egen_pris` (boolean, navn «Egen pris (Bokadmin endrer ikke prisen)»), festet slik at den vises på produktsiden i Shopify admin.
2. Prisjobben og push hopper over prisen når `bok.egen_pris` = true, eller når varianten har `compareAtPrice` (tilbud). Logg «Hoppet over: egen pris» eller «Hoppet over: tilbud».
3. Alt annet ved push oppdateres som før. Det er bare prisen som står urørt.
4. Test i Testbutikk med én bok med `egen_pris` og én med `compareAtPrice`. Sett tilbake etterpå.

## Del 4: tryggere standard og planlegging
1. `price-update/start` uten `mode` skal gi `analyze`, ikke `update`. Sjekk at nettsiden alltid sender `mode` eksplisitt.
2. **Oppsummering:** prisjobben skal telle og vise i jobbsammendraget hvor mange som ble endret, hadde samme pris, ble hoppet over (egen pris, tilbud, ingen ISBN), manglet godkjent pris (med årsak) og krever godkjenning.
3. **Planlegging i 2.0:** sett opp en nattlig prisjobb i sjekkmodus (cirka 03:00 Oslo-tid) med samme mekanisme som gamle Bokadmin (`scheduled_tasks` og `run-scheduled-tasks`). Legg også inn en ukentlig oppdatering, men med `enabled = false`. Den slås på når vi går live. pg_cron skal hente URL og nøkkel fra Vault.

## Del 5: rekkefølgen på pristypene
1. Endre prioriteten i `_shared/price.ts` til 04 > 02 > 03 > 01 > andre, altså priser med mva før priser uten. For bøker (0 % mva) gir det samme resultat.
2. Oppdater kommentaren øverst i fila, testene og regelen i BOKADMIN2_OPPSETT.md.
3. Kjør prisjobben i sjekkmodus i Testbutikk og bekreft at 0 bøker ville fått ny pris.

## Del 6: utfasede `input:`-argumenter
Bytt `input:` til de gjeldende argumentene i 2026-07 for samlingskallene og `scripts/clean-tags.mjs`. Valider og test samlingssynken på én kode.

## Til slutt
- Deploy de endrede funksjonene til 2.0 (si fra først).
- Røyktest fra de samme endepunktene som bokadmin2.vercel.app bruker: push av én bok med pris, én uten pris, prisjobb i sjekkmodus, og godkjenningslista.
- Oppdater BOKADMIN2_OPPSETT.md (prisregel, sperre, egen pris, planlegging) og CLAUDE.md.
- Rapporter kort per del: hva som ble gjort, testet og gjenstår, med commit-hash. Bekreft at ingen priser i Testbutikk står endret etter testene, og at live ikke er rørt.
