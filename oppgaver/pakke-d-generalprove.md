# Oppgave til Claude Code: pakke D, generalprøve med bøker fra livebutikken

Skrevet i Cowork 02.10.2026. Følg delene i rekkefølge. Spør Eirik før alt som sletter, deployer, pusher eller kjører migrasjoner.

Miljø: C:\Bokadmin 2.0, repo Raspaball/bokadmin2, Supabase «Bokadmin 2.0» (ref chwpqwblqummlufqdefe), Shopify bare testbutikk-9434.myshopify.com.

## Mål
En generalprøve på overgangen til live. Testbutikk fylles med bøker **slik de ser ut i livebutikken i dag** (handle = ISBN, forfatter i productType, tittel- og forfattertagger, gammel SEO). Så kjører Bokadmin 2.0 alt som skal kjøres ved overgangen, og vi måler om resultatet blir riktig, hvor lang tid det tar, og hva som feiler. Første runde er cirka 500 bøker; neste runde så mange som Testbutikk tåler, gjerne hele katalogen.

## Sikkerhet
- Ikke rør live-systemet: mappa C:\Bokadmin (kan leses), repoet Raspaball/bokadmin, Supabase-prosjektet «Bokadmin» (live), Vercel «bokadmin» og livebutikken. CSV-fila fra live er bare data. Ingenting skal skrives tilbake til live.
- CSV-fila og alt som er hentet ut av den skal ligge i `scripts/data/` (legg mappa i `.gitignore` **før** fila legges der) eller `scripts/out/`. Ingenting av dette i git.
- Du er den eneste som gjør Supabase-endringer. Si fra før migrasjoner, deploy og push.
- Valider nye GraphQL-operasjoner direkte mot Testbutikk med 2026-07.

## Del 0: forberedelse
1. Legg `scripts/data/` i `.gitignore` og commit det.
2. Eirik eksporterer alle produkter fra livebutikken som CSV (Shopify admin → Produkter → Eksporter → Alle produkter → CSV for Excel, Numbers eller andre regneark) og legger fila i `C:\Bokadmin 2.0\scripts\data\live-produkter.csv`. Vent på ham.
3. Les fila (bare lesing). Rapporter: antall produkter, antall med gyldig ISBN-13 (strekkode, SKU eller handle), antall uten ISBN (papir, gaver o.l.), antall per status, og om bildene peker til cdn.shopify.com.
4. Lag en delmengde på cirka 500 bøker med gyldig ISBN, valgt slik at den dekker variasjonen: ulike bokgrupper, kommende og utsolgte bøker, bøker med to forfattere, uten forlagstekst, lydbøker og e-bøker hvis de finnes. Skriv den som en Shopify-importfil i `scripts/data/runde1.csv` (alle kolonner som i eksporten). Vis Eirik oppsummeringen.

## Del 1: tøm Testbutikk (krever ja fra Eirik)

Eirik kan ha slettet produktene og produktvideresendingene selv i Shopify admin (med en CSV-eksport av Testbutikk som sikkerhetskopi). Kontroller i så fall bare at butikken har 0 produkter og 0 produktvideresendinger, og tøm `books` og `price_approvals` i Supabase 2.0 etter ja fra ham.

1. Ta sikkerhetskopi i `scripts/out/` av dagens produkter (id, handle, tittel, pris, status, metafelt) og videresendinger.
2. Vis Eirik hva som skal slettes: alle produkter (også de arkiverte demoproduktene), alle produktvideresendinger (`/products/...`), arbeidslista `books` og `price_approvals` i Supabase 2.0. **Behold** samlingene, metafelt-definisjonene, `bokgruppe_cache` og `onix_cache`.
3. Slett først når Eirik har sagt ja. Kontroller at butikken har 0 produkter etterpå.

## Del 2: fyll Testbutikk slik live ser ut
1. Eirik importerer `scripts/data/runde1.csv` i Testbutikk via Shopify admin (Produkter → Importer). Det gir en tro kopi av live-dataene, med bilder. Vent på ham. (Alternativ hvis importen feiler: et skript med `productSet` i bulk, som bevarer handle, tagger, productType og SEO nøyaktig som i fila. Spør før du velger det.)
2. Kontroller etterpå: antall produkter, at handles er ISBN, at tagger og productType er som i live, og at bildene er der.
3. Publiser til de samme salgskanalene som i dag hvis importen ikke gjorde det.

## Del 3: bulk der det trengs (veikartets steg 5)
1. Oppdateringsjobben fra pakke B skal kunne kjøre i **bulk-modus**: regn ut ønsket tilstand for alle bøker (samme rene funksjon), skriv en JSONL-fil, last den opp med `stagedUploadsCreate` og kjør `bulkOperationRunMutation` (`productSet` eller `productUpdate` + `metafieldsSet`, det som er riktig i 2026-07). Hent resultatfila og logg feil per bok.
2. Bilder: alt-tekst og filnavn i egen bulk-operasjon hvis det ikke kan gjøres i samme.
3. Lesing av hele katalogen skal bruke `bulkOperationRunQuery`.
4. ONIX hentes til `onix_cache` i forkant, med en rate som Bokbasen tåler. Logg hvor mange kall og hvor lang tid.
5. Tester for JSONL-byggingen. Sjekk-modus skal fortsatt være standard.

## Del 3b: duplikater (samme ISBN på to produkter) — gjelder også live
Live-eksporten har 10 ISBN-er som ligger som to aktive produkter (begge er importert i Testbutikk). Mønsteret: ett eldre produkt med tittel-handle og tema-tagger, og ett fra gamle Bokadmin med ISBN-handle og bkg-/tittel-/forfattertagger. Live har flere bøker enn eksporten, så det kan finnes flere.
1. **Rapport:** en jobb/skript som finner alle ISBN med mer enn ett produkt (alle statuser) og lister dem med handle, opprettet-dato, status, tagger, og om de har ordrer (hvis appen har tilgang til ordrer; ellers marker «ukjent»). Rapporten lagres i `scripts/out/` og vises for Eirik.
2. **Regel (foreslått, Eirik bekrefter):** behold produktet med ordrer; har ingen ordrer, behold det eldste (normalt tittel-handle). Det som skal bort, merkes i rapporten.
3. **Sammenslåing på produktet som beholdes:** legg til `bkg-*` og eventuelle tagger det andre har som ikke er tittel/forfatter-biter. Ingenting annet slettes eller overskrives.
4. **Sletting gjør Eirik selv** (i Shopify admin) etter å ha sett rapporten. Bokadmin sletter aldri produkter.
5. **Videresending:** når duplikatet er slettet, lag `urlRedirect` fra duplikatets gamle adresse til produktet som beholdes (dets nye handle etter migreringen).
6. **Handle-migreringen og alle jobber** skal fortsette å hoppe over ISBN med flere produkter (merket «DUPLIKAT») til de er ryddet, og si tydelig fra i sammendraget.
7. Test hele løpet på de 10 i Testbutikk. Beskyttede produkter (se `regel-beskyttede-samlinger.md`) røres ikke.

## Del 4: generalprøven (samme rekkefølge som ved overgangen til live)
Mål tid og feil for hvert steg, og ta sikkerhetskopi før hvert steg som endrer noe.
1. **Bokgrupper:** sjangersynk på hele utvalget (koder fra Bokbasen, bkg-tagger, samlinger).
2. **Handles:** analyse og migrering (`ISBN` → `tittel-forfatter-ISBN`, med 301). Kontroller antall videresendinger og stikkprøver.
3. **Bokdata:** oppdateringsjobben i sjekkmodus (sammendrag per felt), så i oppdateringsmodus (bulk). Kontroller 20 tilfeldige bøker felt for felt.
4. **Tilgjengelighet:** sjekk, så oppdatering etter regelen fra pakke C.
5. **Pris:** prisjobben i sjekkmodus. Rapporter hvor mange som ville fått ny pris, hvor mange som krever godkjenning (> 30 %), og eksempler. **Ikke** kjør oppdatering av priser uten at Eirik har sett tallene.
6. **Tagger:** kontroller at tittel- og forfattertagger er borte og at bare `bkg-*` og egne merker står igjen.

## Del 5: rapport
Skriv en kort rapport i BOKADMIN2_OPPSETT.md («Generalprøve runde 1»):
- tid per steg, antall endret, uendret, hoppet over og feil, med de vanligste feilene
- Bokbasen-kall og Shopify-kostnad
- hva som må rettes før neste runde og før live
- et anslag for hvor lang tid hele katalogen (cirka 11 000) vil ta ved overgangen

Spør Eirik før runde 2 (resten av katalogen eller så mye som Testbutikk tåler).

## Til slutt
Deploy og push (si fra først). Bekreft at live ikke er rørt og at ingen live-data ligger i git.
