# Pilot: bokdata på 1000 live-bøker, med sikkerhetskopi og testet tilbakerulling

Oppdrag fra Eirik 11.10.2026. Skrevet i Cowork for Claude Code (Opus 5.5). Les først: CLAUDE.md, `oppgaver/live-sjekk-1.md`, `oppgaver/pakke-i-del-b-live.md` (punkt «Plan for tilbakerulling»), denne fila.

## Mål
Kjør «Oppdater eksisterende bøker» (book-update, oppdateringsmodus) på 1000 håndplukkede, representative live-bøker. Før det: sikkerhetskopi av akkurat disse, og et **utførelsestrinn for tilbakerulling som er testet i Testbutikk**. Piloten er godkjent bare hvis alt kan rulles tilbake feilfritt.

## Hva piloten gjør og ikke gjør
- Gjør: bokdata (productType «Bok», kategori, SEO-tittel og -beskrivelse, beskrivelse, `bok.*`-metafelt, `bokadmin.seo_auto`, alt-tekst på omslag). **Filnavn på omslag utgår** (test 11.10.2026: gammel bilde-adresse gir 404, `COVER_RENAME = false`).
- Gjør IKKE: status, pris, tilgjengelighet, handles, tagger, samlinger, publisering. Ikke kjør sjangre-sync, availability-check, price-update eller handle-migrering i piloten.
- Beskyttede, duplikater, uten ISBN og ikke-bøker skal ha 0 endringer og ligger ikke i utvalget.

## Faste regler (ikke bryt)
- Skrivesperren (`shop_settings.read_only`, `LIVE_READ_ONLY`) åpnes av Eirik, aldri av Claude Code. «Åpen til» kort (2–3 timer). Sett den på og bruk «Lukk live» rett etter.
- Ingen deploy eller migrasjon uten ja fra Eirik. Si fra først.
- Live-domene, nøkler og ISBN-lister fra live skal aldri i git (repoet er offentlig). Alt av live-data ligger i `scripts/out/` eller `scripts/data/`; kontroller at de er git-ignorert (`git check-ignore`).
- Gamle Bokadmin (`C:\Bokadmin`, Supabase `cvrnkeboqvhvfoxcdbbz`) røres aldri.
- Stopp ved første uforklarte feil. Ikke prøv å rette på egen hånd.
- Merk: sandkassen i Cowork når ikke myshopify.com. Alle skript som snakker med live kjøres fra VS Code på PC-en.

## Trinn 1: Avklaringer (Eirik, før Claude Code starter live-delen)
0. Appen «Bokadmin 2» har tilgangen `write_files` (kreves av `fileUpdate`, brukt til alt-tekst på omslag), godkjent i både live og Testbutikk. Se `test-omslagsfilnavn-5.md`.
1. Temaet er rettet («Forfatter:» bruker `bok.forfatter` med fallback, aldri «Bok»). Forslag: `oppgaver/forslag-forfatter-liquid.liquid`. Eirik bekrefter.
2. Gamle Bokadmin, «Prisoppdatering BB», ONIXEDIT, Matrixify og Flow er stoppet.
3. Institusjonsbøker (ca. 315 uten `bok.forfatter`, 124 navn på 485 bøker): OK at de står uten forfatterlinje, eller ønsker Eirik at institusjonen vises? Avgjør før koden endres. Standard i piloten: som koden gjør nå.
4. Kategori `me-1-3`: bekreft i Shopify at den heter «Print Books» (Claude Code leser taksonomien og rapporterer navnet).
5. Omslagsfilnavn: **avgjort 11.10.2026, utgår** fra pilot og hovedkjøring (testen på 5 live-bøker: gammel adresse gir 404). Resten av punkter om filnavn under er historiske.

## Trinn 2: Pilotutvalg (lokalt, bare lesing)
- Utvid `scripts/pilot-og-stikkprove.mjs` med `--antall 1000` (og fast frø). Bygg på live-eksporten `scripts/data/live-eksport-<butikk>-live-sjekk-1` eller en fersk.
- Stratifisert utvalg, minst disse gruppene (antall per gruppe oppgis i rapporten): norsk, utenlandsk, kommende, uten forlagstekst, flere forfattere, institusjon, uten forfatter, lesbar adresse, manuell SEO-tittel eller -beskrivelse (de 17), beskrivelse som avviker fra forlagsteksten, serie, barn/ungdom (`bok.alder`), bøker som i dag er skjulte, bøker som blir utkast eller arkivert (bokdata endrer ikke status, men de skal være med), bøker med tilfeldig bilde mangler, Gyldendal og andre store forlag. Resten fylles tilfeldig.
- De 50 fra `pilot-forslag-50.csv` skal være med.
- Ut: `scripts/out/pilot-1000.csv` (ISBN, gruppe, produkt-ID). Eirik går gjennom antall per gruppe og sier ja. Lista limes ikke i chat eller git.
- Kontroller mot Shopify (bare lesing) at alle 1000 fortsatt finnes, ikke er beskyttet, ikke er duplikat.

## Trinn 3: Utførelsestrinn for tilbakerulling (må være ferdig og testet FØR live)
`scripts/live-tilbakerull.mjs` lager i dag bare en plan. Lag `scripts/live-tilbakerull-utfor.mjs`:
- Leser mappen fra planleggeren (`gjenopprett-produkter.jsonl`, `gjenopprett-metafelt-slett.jsonl`, `gjenopprett-bilder-alt.jsonl` osv.).
- Standard er tørrkjøring (teller og viser, sender ingenting). `--utfor` krever `--bekreft-butikk <hele domenet>`, åpen live-sperre, og bruker smal mutasjonsliste (bare `productUpdate`, `metafieldsSet`, `metafieldsDelete`, `fileUpdate`, via `checkMutationAllowlist`).
- Bulk der det går (`startBulkMutation`), med resultat per rad til en loggfil. Idempotent: kjøres den to ganger, blir sluttilstanden lik.
- Dekk alt piloten endrer: productType, kategori, `descriptionHtml`, SEO (`global.title_tag/description_tag`), `bok.*` og `bokadmin.seo_auto` (satt eller slettet), alt-tekst på omslag (filnavn utgår, se trinn 1 punkt 5).
- ~~**Kjent hull:** planleggeren gjenoppretter i dag bare alt-tekst, ikke filnavn. Utvid eksporten (`live-eksport.mjs`) til å ta med medie-ID, filnavn og bilde-URL før/etter, og planleggeren til å gi `fileUpdate` med gammelt filnavn.~~ Utgår: filnavn endres ikke i piloten. Testbøkene tilbakeføres med `scripts/test-omslagsfilnavn.mjs --tilbake`.
- ~~Undersøk i Testbutikk: endrer omdøping av filnavn bilde-URL-en på cdn.shopify.com, og virker den gamle adressen fortsatt? Rapporter funnet. Er den gamle adressen borte, må Eirik avgjøre om filnavn tas ut av pilot og hovedkjøring (da: legg til et valg som hopper over `fileUpdate` for filnavn, og behold alt-tekst).~~ Besvart i live: ja, adressen endres og den gamle gir 404.
- Enhetstester for planlegger og utførelse (mock).

**Godkjenningstest i Testbutikk (må bestå):**
1. `snapshot.mjs --name foer-test` (eller `live-eksport` mot Testbutikk) av tilstanden.
2. Kjør book-update i oppdateringsmodus på ca. 1000 Testbutikk-bøker (samme gruppesammensetning, bruk `isbns`).
3. Ny eksport `etter-test`. Lag plan, kjør utførelsestrinnet i tørrkjøring og så ekte.
4. Ny eksport `tilbake-test`. `snapshot-diff.mjs foer-test tilbake-test` skal gi **0 forskjeller** på de feltene piloten rører (unntatt Shopifys egen `updatedAt`). Alt annet som avviker rapporteres med forklaring.
5. Rapporter tall og tid. Eirik og Cowork leser rapporten og sier ja før trinn 5.

## Trinn 4: Sikkerhetskopi av de 1000 (rett før kjøring, bare lesing)
Tre lag, alle før noe skrives:
1. **Full live-eksport** `node scripts/live-eksport.mjs --live --bekreft-butikk <domene> --name foer-pilot-1000`. Kontroller i `products.jsonl` at alle felt piloten endrer er med (se trinn 3). Mangler noe: utvid eksporten og ta den på nytt.
2. **Smal før-fil for de 1000**: egen spørring (bare lesing) som henter nøyaktig feltene piloten rører, per produkt, til `scripts/out/pilot-1000-foer.jsonl`. Lagre sha256 av fila i en egen fil og i rapporten.
3. **Shopify CSV-eksport** av de 1000 gjøres av Eirik i Shopify admin (Products → Export, valgt utvalg). Siste utvei, uavhengig av Bokadmin. Lagres lokalt.
Eksporten må ikke være eldre enn 1 time ved start. Er den eldre, ta den på nytt.

## Trinn 5: Kjøring (Eirik åpner live)
1. Eirik: Innstillinger → Butikker → «Gjør aktiv» for live med «åpen til» høyst 3 timer fram, og slår av skrivesperren i de to låsene Claude Code ber om. Ingen andre jobber skal kjøre (sjekk `jobs` og `scheduled_tasks`).
2. Claude Code: kjør `POST /book-update/start { mode: "analyze", isbns: <de 1000>, bulk: true }` og kontroller at antall endringer og feltfordeling stemmer med forventet (sammenlign med sjekken fra 11.10: ingen nye avvik, 0 på beskyttede, ingen duplikater).
3. **Mikrotrinn 1: 10 bøker** (`mode: "update"`, `isbns` = 10 av de 1000, helst ulike grupper). Ny smal eksport av de 10. Kontroll sammen med Eirik i Shopify og på nettsiden: forfatterlinje, bilder (vises de, gamle bilde-URL-er), SEO i kildekoden, beskrivelse, filtre. Ingen feil → neste.
4. **Mikrotrinn 2: 100 bøker.** Samme kontroll, i tillegg stikkprøve av 10 mot sjekkresultatet.
5. **Resten (890)** i én kjøring. Stopp-regler: ved første uforklarte feil eller feilrate over 1 % kjøres `/cancel`, sperren settes på igjen, «Lukk live», og Claude Code lager tilbakerullingsplan mot `foer-pilot-1000`. Ikke noe annet gjøres før Eirik har sett den.
6. «Lukk live» og skrivesperren på rett etter siste kjøring.

## Trinn 6: Kontroll etter (bare lesing)
- Ny eksport `etter-pilot-1000`. `snapshot-diff.mjs` mot `foer-pilot-1000`: bare de 1000 har endringer, og bare i forventede felt. 0 endringer på beskyttede og på alle andre produkter.
- `sync_log`: antall endret/uendret/feil per bok, 0 feil.
- Stikkprøve 20 bøker på nettsiden, på telefon og PC. Eirik sjekker: Google Merchant Center og Facebook/Instagram-katalogen (bilder og SEO), Search & Discovery-filtre («Forfatter», «Utgivelsesår»), og at søk på forfatter virker.
- Lag tilbakerullingsplanen mot `foer-pilot-1000` uansett, og kjør utførelsestrinnet i **tørrkjøring**. Antall rader skal stemme med antall endringer. Ikke utfør.

## Trinn 7: Beslutning
- **Godkjent:** Eirik sier ja, og neste fase planlegges (resten av katalogen i omganger, deretter handles). Behold `foer-pilot-1000` til hele overgangen er ferdig.
- **Ikke godkjent / feil:** åpne live på nytt med kort vindu, kjør tilbakerullingen for de 1000 (`--utfor`), ny eksport, `snapshot-diff` mot `foer-pilot-1000` skal gi 0 forskjeller på pilotfeltene. Rapporter.

## Rapport (Claude Code skriver i `oppgaver/pilot-1000-bokdata-rapport.md`, uten hemmeligheter, live-domene og ISBN-lister)
Tall per trinn, antall per gruppe, antall endret/hoppet over/feil, funn om bilde-URL, resultat av tilbakerulling-testen i Testbutikk (ja/nei, diff), tid brukt, og hva som ikke ble sjekket. Oppdater også `BOKADMIN2_OPPSETT.md` med to linjer.

## Merknader
- Metafeltdefinisjonene `bok.*` og `bokadmin.seo_auto` ble laget i live 10.10.2026 via Shopify-tilkoblingen i Cowork (ikke via skriptet), med samme innstillinger som `scripts/lag-metafelt-definisjoner.mjs`. Ikke lag dem på nytt.
- Anslått tid: Trinn 3 en kveld, trinn 2 og 4 ca. 1 time, trinn 5 ca. 30–60 min (bulk av 16 000 tok ca. 55 min, 1000 tar få minutter), trinn 6 ca. 1 time.
