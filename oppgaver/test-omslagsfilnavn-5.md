# Test: nytt filnavn på omslagsbilder, 5 bøker i live

Oppdrag fra Eirik 11.10.2026. Skrevet i Cowork for Claude Code (Opus 5.5). Les først: CLAUDE.md, `oppgaver/pilot-1000-bokdata.md`, `supabase/functions/_shared/book-cover.ts`.

## Spørsmålet som skal besvares
Når en bok får nytt filnavn på omslaget (`{handle}-omslag.jpg` i stedet for `jpg_<uuid>.jpg`) via `fileUpdate`:
1. Endres bilde-adressen på cdn.shopify.com?
2. Virker den gamle adressen fortsatt (HTTP 200 eller videresending), og hvor lenge?
3. Vises bildet riktig på nettsiden, i Google Merchant Center og i Facebook/Instagram-katalogen etter at de har hentet på nytt?
4. Kan filnavnet settes tilbake, og får bildet da tilbake den gamle adressen?
Svaret avgjør om filnavn tas med i hovedkjøringen (se `pilot-1000-bokdata.md`) eller utgår. Alt-tekst er uavhengig av dette og blir med uansett.

## Forutsetning: appen «Bokadmin 2» trenger tilgangen write_files
`fileUpdate` krever `write_files` (eller `write_themes`). Tilgangene i CLAUDE.md (products, inventory, publications, online_store_navigation) dekker ikke dette. Eirik legger til `write_files` (og `read_files`) i en ny appversjon i Shopify Dev Dashboard, slipper versjonen, og godkjenner de nye tilgangene i hver butikk der appen er installert (live og Testbutikk). Claude Code bekrefter at «Test tilkobling» viser `write_files`, og at tilgangsnøkkelen er fornyet (nøkkelen caches opptil 24 timer; bytte av aktiv butikk eller lagring av profilen tømmer cachen). Dette gjelder også book-update: alt-tekst på omslag bruker samme `fileUpdate`, så uten tilgangen feiler cover-delen av pilotene.

## Faste regler
- Skrivesperren åpnes av Eirik, aldri av Claude Code. «Åpen til» høyst 1 time. «Lukk live» og skrivesperren på rett etter.
- Bare `fileUpdate` skal skrive, via smal mutasjonsliste (`checkMutationAllowlist`). Ingen `productUpdate`, ingen andre felt. Ingen book-update-jobb (den rører også produkttype, SEO, beskrivelse, metafelt).
- Live-domene, produkt-ID-er og ISBN-lister i git: aldri. Filer i `scripts/out/` (git-ignorert).
- Skript som snakker med live kjøres fra VS Code på PC-en, ikke fra Cowork.
- Stopp ved første uforklarte feil.

## Trinn 1: Velg 5 bøker (bare lesing)
Fra live-eksporten, uten beskyttede, duplikater, uten ISBN og ikke-bøker. Krav:
1. Bok publisert på Google & YouTube og Facebook & Instagram (kanalene leser bildet).
2. Bok med bilde lastet opp fra Bokbasen (typisk `jpg_<uuid>.jpg`).
3. Bok med flere bilder (rør bare omslaget, første bildet).
4. Bok med lesbar handle (ikke ISBN-adresse).
5. Bok som ligger i en bkg-samling som vises på forsiden eller ofte besøkt.
Vis Eirik lista (tittel, ikke ISBN i chat) og få ja før noe skrives.

## Trinn 2: Måling før (bare lesing)
Per bok, lagre i `scripts/out/test-filnavn-foer.json`:
- Medie-ID, nåværende filnavn og full bilde-URL.
- HTTP-status og `content-length` for URL-en (`curl -I`).
- `src` for bildet på produktsiden i butikken (hent siden, les `og:image` og bilde-tags; butikken er ikke passordbeskyttet i live, ellers rapporter).
- Eksisterer bildet i Google Merchant Center (Eirik leser «image link» og status for de 5) og i Facebook-katalogen.
Ta også en eksport av de 5 produktene som sikkerhetskopi.

## Trinn 3: Endring (Eirik åpner live ≤ 1 time)
Lag `scripts/test-omslagsfilnavn.mjs` (tørrkjøring som standard, `--utfor --bekreft-butikk <domene>` skriver). Den:
- tar de 5 media-ID-ene og nytt filnavn fra `coverFilename()` (samme regel som book-update),
- sender én `fileUpdate` per bok med bare `filename` (ikke alt),
- logger svar og brukerfeil per bok.
Kjør tørrkjøring, vis resultatet, få ja, kjør `--utfor`. Vent på at bildeverkøya ferdigstilles (`fileStatus` READY) før måling.

## Trinn 4: Måling etter (bare lesing)
Samme målinger som i trinn 2, til `test-filnavn-etter.json`. Rapporter per bok:
- Ny bilde-URL, og om den er endret.
- Gammel URL: HTTP-status, videresendes den til ny, eller 404?
- Produktsidens bilde-`src` og `og:image` (ny eller gammel).
- Sjekk igjen etter 1 time og etter 24 timer (gammel URL kan leve i cache en stund).
- Eirik: Merchant Center og Facebook-katalogen for de 5, etter neste henting (vanligvis innen et døgn). Feil på bilde («kan ikke hente bilde») er det som teller.

## Trinn 5: Tilbakeføring (alltid, uavhengig av resultat)
Sett filnavnet tilbake til opprinnelig på alle 5 med `fileUpdate` (samme skript, `--tilbake`). Mål om bilde-URL-en og produktsiden er som før (`test-filnavn-tilbake.json`). Hvis URL-en ikke kommer tilbake til den opprinnelige, rapporter det tydelig: det er viktig for hovedkjøringen, fordi filnavn da ikke kan angres uten ny adresse.
Hvis Eirik vil beholde det nye filnavnet på en eller flere bøker etter testen, avtales det i chat før tilbakeføring.

## Rapport (`oppgaver/test-omslagsfilnavn-5-rapport.md`, uten hemmeligheter, domene og ISBN-lister)
Tabell per bok (anonymisert: bok 1–5): URL endret ja/nei, gammel URL ok ja/nei og hvor lenge, produktside, Merchant Center, Facebook, tilbakeføring ok ja/nei. Til slutt en anbefaling:
- **A:** filnavn tas med i hovedkjøringen (bare hvis gammel URL virker eller URL ikke endres, og tilbakeføring gir samme URL),
- **B:** filnavn utgår, bare alt-tekst (anbefalt standard hvis noe er usikkert),
- **C:** filnavn gjøres som egen jobb senere, i små omganger.
Eirik og Cowork leser rapporten før noe annet planlegges. Oppdater `pilot-1000-bokdata.md` og `BOKADMIN2_OPPSETT.md` etter svaret.

## Tid
Trinn 1–2: ca. 1 time. Trinn 3: 15 minutter. Trinn 4–5: 1 time på dagen, pluss kontroll neste dag.
