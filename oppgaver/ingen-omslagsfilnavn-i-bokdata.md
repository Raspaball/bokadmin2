# Liten kodeoppgave: bokdata-oppdateringen skal ikke endre filnavn på omslag

Fra Eirik 11.10.2026, etter testen på 5 live-bøker: nytt filnavn gir ny bilde-URL, og den gamle gir 404 uten videresending. Det kan gi brutte bilder i Google Shopping og Facebook/Instagram til kanalene har hentet på nytt. Derfor: **alt-tekst på omslag beholdes, filnavn endres aldri på eksisterende bøker.** Les `oppgaver/test-omslagsfilnavn-5.md` først.

## Endring
1. `supabase/functions/_shared/book-cover.ts`: ny konstant `COVER_RENAME = false` (med kommentar om testen 11.10.2026). `coverChanges()` tar bare med `filename` når `COVER_RENAME` er true. `coverFilename()` og `fileNameFromUrl()` beholdes.
2. `supabase/functions/_shared/book-update.ts` (rundt `// Omslag (del 5)`): ingen `coverFilename`-endring (`changes.push({ field: "coverFilename", … })` kommer da aldri). `cover.change` har bare `alt`. Kontroller at `bulkCoverLine()` i `_shared/book-bulk.ts` og `fileUpdate`-kallet i `book-update/index.ts` ikke sender `filename` når det ikke er satt.
3. Sjekk `pushOneBook` (`shopify/index.ts`): nye bøker kan fortsatt få `{handle}-omslag.jpg` ved opplasting (ingen gammel adresse finnes), men en re-push av en eksisterende bok skal ikke endre filnavnet. Rapporter hva koden gjør i dag; endre bare hvis den omdøper eksisterende bilder.
4. UI (`src/app/components/BokOppdatering.tsx`) og sammendrag: `coverFilename` skal ikke vises som felt med antall. Ta det bort eller skjul det.
5. Tester: oppdater `scripts/book-cover.test.mjs` og `scripts/book-update.test.mjs` (filnavn gir ingen endring; alt-tekst gir endring; med `COVER_RENAME = true` virker den gamle oppførselen). Kjør hele suiten.
6. Dokumenter i CLAUDE.md (tabellraden «Omslag (alt-tekst, filnavn)») og `oppgaver/pilot-1000-bokdata.md`: filnavn utgår fra pilot og hovedkjøring. Fjern filnavn fra trinn 3 og 6 der det gjelder (kravet om filnavn i tilbakerulling kan strykes, alt-tekst står).

## Etter koden
- Kjør `book-update` i sjekkmodus mot live (bare lesing): `coverFilename` skal være 0, `coverAlt` uendret (ca. 16 395 med alt-tekst fra før).
- Deploy `book-update` (og `shopify` hvis den ble endret) først etter ja fra Eirik. Si fra før deploy.
- De 5 testbøkene: filnavnene tilbakeføres i testen (se `test-omslagsfilnavn-5.md`). Ikke berør dem her.

## Ikke gjør
- Ikke endre noe i live i denne oppgaven. Ingen jobber i oppdateringsmodus.
- Ikke slett koden for filnavn; den kan trenges senere hvis filnavn blir en egen jobb.
