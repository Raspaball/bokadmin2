# Live-sjekk 1: oppdraget fra Eirik (07.10.2026)

Original oppgavetekst. Punktnumrene (1–23) brukes i oppgaver/live-sjekk-1.md. Status står der, ikke her.

Mål: koble Bokadmin 2.0 til den nye appen i livebutikken og kjøre bare lesing og sjekkmodus. INGEN endringer i live i denne økten. Jeg skal også kunne legge inn butikkdomene, Client ID og Client secret for appen i Innstillinger. Jeg er ikke utvikler: svar kort på norsk bokmål, og still avgjørelser som en nummerert liste.

Modell: Opus 5.5. Verifiser alt mot data, ikke antagelser. Ta små steg.

LES FØRST
Prosjektdokumentet «claude/live-analyse-2026-10-07.md» (livebutikk-analysen), «claude/plan-veien-til-live.md» og oppgaver/pakke-i-del-b-live.md. Hvis du ikke har tilgang til prosjektdokumentene, si fra, så limer jeg dem inn.

HARDE REGLER
- Live skal bare leses. Ingen mutasjoner (productUpdate, metafieldsSet, urlRedirectCreate, publish, fileUpdate, bulkOperationRunMutation, metafieldDefinitionCreate osv.) mot live. Ingen oppdateringsmodus, push, bulk-oppdatering eller handle-migrering. Ikke lag metafelt-definisjoner nå.
- Det gamle systemet røres ikke: C:\Bokadmin, GitHub Raspaball/bokadmin, Supabase «Bokadmin» (cvrnkeboqvhvfoxcdbbz), Vercel «bokadmin». Bare lesing for sammenligning. Du kan ikke slå av gamle Bokadmin eller andre apper i live; det gjør jeg.
- Bare Supabase «Bokadmin 2.0» (chwpqwblqummlufqdefe) endres, og bare det jeg godkjenner. Si fra og vent på ja før hver deploy og migrasjon. Migrasjoner er additive, med rollback-seksjon. Rediger aldri en kjørt migrasjon.
- Hemmeligheter (Client secret) skal aldri stå i chat, git (repoet er offentlig), logger, rapporter, feilmeldinger eller nettleserkonsoll.
- Beskyttede produkter røres aldri (tagger gave, lokal, lokalhistorie, lokallitteratur, leverandør med «wrendale», samlingen wrendale). Mangler samlingen wrendale i live: STOPP.
- Er du i tvil om en handling treffer Testbutikk eller live: stopp og spør.
- Du skal IKKE avgjøre disse åpne spørsmålene selv, bare rapportere hva koden vil gjøre: (1) skjulte aktive bøker, (2) lesbare adresser, (3) duplikater, (4) emnetagger, (5) kanaler.

PLAN (ett steg om gangen, rapporter etter hvert, vent på ja før neste del)

Del 1: Før tilkobling
1. Sjekk at ingen jobber kjører eller er pauset (jobs), at ingen planlagte oppgaver er aktive (scheduled_tasks), og at pg_cron ikke kan starte noe mot en annen butikk.
2. Sjekk sperren mot live i _shared/shopify.ts: den skal kreve LIVE_SHOP_CONFIRMED og LIVE_SHOP_UNTIL (høyst 24 t). Legg til skrivesperre LIVE_READ_ONLY (påslått som standard for live): alle mutasjoner mot live avvises, også i oppdateringsmodus. Test: live avviser mutasjon, lesing virker, Testbutikk virker som før.
3. Domenestempel på jobbrader: en jobb stopper hvis butikkdomenet ikke stemmer ved fortsettelse. Additiv migrasjon. Vis SQL og vent på ja.

Del 2: Innstillinger for butikktilkobling
4. Vis forslag til lagring først og vent på ja: Client secret i Supabase Vault (eller tabell med RLS der secret aldri kan leses av frontend). Client ID og domene kan vises.
5. Skjerm «Butikker» i Innstillinger, med profilene Testbutikk og Live: domene, Client ID, Client secret. Secret er bare skrivbart; etter lagring vises «lagret». «Test tilkobling» (bare lesing). Tydelig hvilken butikk som er aktiv, med rød LIVE-stripe når live er aktiv.
6. Bytte butikk krever: ingen kjørende eller pauset jobb, at jeg skriver butikkens domene som bekreftelse, og for live «åpen til» (høyst 24 t) med skrivesperre på. Bytte nullstiller token-cachen. Logg hvem og når, uten hemmeligheter.
7. Bruk getCaller() (ikke les tokenet rett), og bare jeg kan endre. Secret logges aldri og sendes aldri tilbake til nettleseren. Behold env-variablene som reserve for Testbutikk.
8. Tester for: secret leses aldri tilbake, bytte avvist mens jobb kjører, live avviser mutasjoner, token-cache nullstilles, feil domene avvises. Si fra før deploy (--project-ref chwpqwblqummlufqdefe) og vent på ja.

Del 3: Koble til live
9. Jeg legger inn domene, Client ID og Client secret i Innstillinger og trykker «Test tilkobling». Du ser aldri secret.
10. Bekreft at butikken heter «Bø bok og papir» og at domenet er riktig.
11. Les appens faktiske tilganger (currentAppInstallation { accessScopes }) og sammenlign med listen i pakke-i-del-b-live.md.

Del 4: Bare lesing
12. Kjør live-eksport (scripts/live-eksport.mjs, bare lesing) til scripts/out/ (git-ignorert). Sjekk at antall produkter og samlinger stemmer med butikkens tellinger.
13. Sammenlign med kontrolltallene fra livebutikk-analysen (eksport 2. oktober). Rapporter hvert avvik over 3 %, og forklar mulig årsak:
 - 17 169 produkter: 14 693 aktive, 2 449 utkast, 27 arkiverte
 - 162 samlinger (bkg-1 til bkg-944, Lokalhistorie, Gaveartikler, Wrendale [57], Nyheter [6], Anbefalinger [5]), ingen over 5 000 (størst bkg-4 med 4 152)
 - 60 ISBN på 121 produkter (duplikater)
 - 422 bøker med lesbar adresse (ikke ISBN) og 16 580 med ISBN-adresse
 - 201 produkter uten ISBN (Wrendale, bokpakker, medlemskort, lokale)
 - 3 280 aktive produkter som ikke er publisert i nettbutikken (Online Store), hvorav 1 415 fra Gyldendal
 - 7 salgskanaler. Bare 2 videresendinger finnes fra før.
 - Ingen bok.*-definisjoner finnes, og ingen produkter har bok.*-felt.
 - Ca. 1 157 produkter uten bkg-tagger, og 1 173 med andre tagger enn bkg
14. Gi i tillegg tall for hvor mange av produktene som er bøker (har ISBN og er fysiske ifølge Bokbasen), og hvor mange som ikke finnes hos Bokbasen.

Del 5: Sjekkmodus (mode: analyze, ingenting annet)
15. Kjør i denne rekkefølgen og rapporter hver for seg: handles, bokgrupper og samlinger (sjangre-sync), bokdata (book-update bulk), tilgjengelighet (availability-check, statusrapport), pris (price-update). Stopper en jobb på regnetid (CPU): rapporter og ikke prøv uendelig.
16. Etter hver jobb: bekreft i logg og antall API-kall at ALLE kall var lesing (0 mutasjoner).
17. Rapporter spesielt, med antall og 5 eksempler hver:
 a) Handles: hvor mange av de 422 lesbare adressene som får ny adresse (og hvor mange som beholdes), duplikater som hoppes over, kollisjoner.
 b) Produkter uten ISBN (201): bekreft at ALLE jobber har 0 planlagte endringer på dem, og at medlemskort og bokpakker er uberørt.
 c) Forsiden: bekreft at bøkene i samlingene Nyheter og Anbefalinger ikke blir satt til utkast eller arkivert, ellers list dem.
 d) Status: hvor mange utkast som blir aktive, og hvor mange aktive som blir utkast eller arkivert. Statusrapporten skal ligge som CSV.
 e) Salgskanaler: hvor mange bøker som i dag mangler Online Store og dermed ville bli synlige i nettbutikken, hvor mange per kanal som ville bli publisert (inkl. Snapchat Ads, Inbox, App), og hvor mange av de 3 280 skjulte som er med. Se spørsmål 1 og 5 under.
 f) Produkttype: i dag står forfatteren i produkttypen. Hvor mange får «Bok». Hvor mange bøker hoppes over fordi de ikke finnes hos Bokbasen (da blir produkttypen og forfatteren stående som i dag)?
 g) Tagger: hva som skjer med emnetaggene (skjoenn-rom, Faglitteratur, 1850-1899 osv.) og med produkter uten bkg-tagger.
 h) SEO: hvor mange metabeskrivelser («Kjøp … hos», HTML, over 155 tegn) som gjenkjennes som gammel automatikk og overskrives, og hvor mange som regnes som manuelle og står.
 i) Institusjoner og flere forfattere: antall og 5 eksempler hver, med hva som blir forfatter, SEO-tittel og handle (f.eks. «NorgeTranøy, Knut Erik»).
 j) Kategori: hvor mange går fra «Media > Books» (12 656) og tom (762) til «Print Books».
18. Sammenlign 10 tilfeldige bøker fra sjekkresultatet med live-eksporten (handle, tittel, SEO, tagger, status).

Del 6: Stopp, og pilotplan
19. Skriv rapport i oppgaver/live-sjekk-1.md (uten hemmeligheter) og en kort oppsummering i BOKADMIN2_OPPSETT.md. Skriv at live nå er tillatt for lesing og sjekkmodus under sperrene, og at prosjektinstruksene må oppdateres av meg. Lag en liste over det du ikke fikk sjekket.
20. IKKE start pilot eller oppdateringsmodus.
21. Lag forslag til pilot på 50 bøker (en liste med ISBN fra live-eksporten, ikke en jobb). Lista skal ha minst én bok fra hver gruppe: norsk, utenlandsk, kommende, uten forlagstekst, flere forfattere, institusjon, lesbar adresse, utkast som blir aktiv, aktiv som blir utkast eller arkivert, aktiv men skjult i nettbutikken (merk den), og ikke i Bokbasen. Ingen beskyttede produkter, ingen duplikater og ingen uten ISBN.
22. Gi meg det som må være klart FØR piloten:
 - Temaet: produktsiden skriver «Forfatter: {{ product.type }}», og Bokadmin setter produkttypen til «Bok» (blir «Forfatter: Bok»). Foreslå en tekst (Liquid) som bruker bok.forfatter og, så lenge feltet er tomt, faller tilbake til produkttypen (ikke «Bok»). Lag den som forslag i en fil, ikke bruk den. Jeg endrer temaet i en kopi.
 - Filtrene «Forfatter» og «Utgivelsesår» i Search & Discovery (jeg sjekker hvilket felt de bruker).
 - Gamle Bokadmin, «Prisoppdatering BB», ONIXEDIT, Matrixify, Flow og de egne appene skal være stoppet eller kontrollert av meg (liste hva de kan skrive til).
 - Ny live-eksport rett før, tilbakerulling laget og testet (planen kan bygges fra to eksporter).
 - Metafelt-definisjonene (bok.isbn som id) laget etter ja fra meg.
23. Til slutt: (a) det som må avgjøres (nummerert), (b) forslag til rekkefølge og tidsbruk for piloten, (c) hva du anbefaler før jeg sier ja.

SPØRSMÅL SOM ER ÅPNE (rapporter hva koden gjør, ikke velg selv)
1. Skal de 3 280 aktive, men skjulte bøkene synliggjøres i nettbutikken eller holdes utenfor?
2. Skal de 422 lesbare adressene beholdes eller få ny standardadresse?
3. Hvilken av to duplikater skal stå for hver av de 60 ISBN-ene?
4. Skal emnetaggene fjernes som planlagt?
5. Skal alle 7 kanaler brukes, også Snapchat Ads, Inbox og «App»?

Går noe uventet (en mutasjon går gjennom, feil butikk, en hemmelighet i logg, en jobb som ikke stopper): STOPP med en gang, si hva som skjedde, og ikke prøv å rette det på egen hånd.