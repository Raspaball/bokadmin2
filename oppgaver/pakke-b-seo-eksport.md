# Oppgave til Claude Code: pakke B, ny standard i eksporten (SEO og bokfelt)

Skrevet i Cowork 02.10.2026. Start etter pakke C. Følg delene i rekkefølge, og spør Eirik hvis noe er uklart eller ser ut til å treffe live-systemet.

Miljø: C:\Bokadmin 2.0, repo Raspaball/bokadmin2, Supabase «Bokadmin 2.0» (ref chwpqwblqummlufqdefe), Shopify bare testbutikk-9434.myshopify.com.

Bakgrunn: prosjektdokumentet «plan-handles-og-seo-eksport» (seksjon 2 og 6) og «datamodell-bok» (feltene i navnerommet `bok`). Målet er at hver bok som går fra Bokadmin til Shopify følger én standard, og at bøker som allerede ligger i butikken kan oppdateres til den samme standarden. Pakke D (stor testimport) bygger på dette.

## Sikkerhet
- Ikke rør live-systemet: mappa C:\Bokadmin (den kan leses), repoet Raspaball/bokadmin, Supabase-prosjektet «Bokadmin» (live), Vercel «bokadmin» og livebutikken.
- Du er den eneste som gjør Supabase-endringer mens dette pågår. Si fra før du kjører migrasjoner, deployer eller pusher. Kan du ikke kjøre en migrasjon selv, be Eirik lime den inn i SQL Editor for Bokadmin 2.0.
- Migrasjoner skal bare legge til. Legg aldri hemmeligheter i git, og skriv aldri live-prosjektets ref i filer i repoet.
- Valider nye eller endrede GraphQL-operasjoner direkte mot Testbutikk med 2026-07.
- Endre ikke pris (pakke A/A2), status og tilgjengelighet (pakke C) eller handle på eksisterende produkter. Bruk de delte funksjonene som finnes.
- Én commit per del. Kjør `node --test scripts/*.test.mjs` før hver commit.

## Del 1: forfatterne som liste (først, fordi handles bygger på dette)
I dag skjøtes forfatterne sammen til én tekst med `", "`, og `firstAuthor()` gjetter om teksten er «Etternavn, Fornavn». «Nina Brochmann, Ellen Støkken Dahl» gir derfor feil handle.
1. ONIX-lesingen returnerer `authors: string[]` i rekkefølge (`SequenceNumber`), som «Fornavn Etternavn» (`PersonName`, ellers snudd fra `PersonNameInverted`, ellers `NamesBeforeKey` + `KeyNames`). Ta med rolle A01 (forfatter). Finnes ingen A01, bruk første bidragsyter uansett rolle (for eksempel B01 redaktør) og noter rollen.
2. Lagre listen i `books` (ny kolonne `authors text[]`, migrasjonen skal bare legge til). Behold `author` som visningstekst.
3. `buildBookHandle` og migreringen får listen direkte. `firstAuthor()` brukes bare som reserve for gamle data.
4. Tester med: én forfatter, to forfattere som `PersonName`, to som `PersonNameInverted`, bare redaktør, ingen bidragsytere.

## Del 2: bokfeltene (veikartets steg 4)
Fyll metafeltene i `bok` fra ONIX ved push. Definisjonene finnes i Testbutikk; opprett de som mangler slik datamodellen beskriver.

| Felt | Kilde i ONIX |
|---|---|
| `bok.forfatter` | listen fra del 1 |
| `bok.format` | `ProductForm` (+ `ProductFormDetail`), se under |
| `bok.sider` | `Extent` med type 00/07/08 (sidetall) |
| `bok.utgivelsesaar` | år fra `PublishingDate` rolle 01, ellers `PublicationDate` |
| `bok.spraak` | `Language` rolle 01: nob → Bokmål, nno → Nynorsk, eng → Engelsk, osv. |
| `bok.serie` | `Collection` / `TitleOfSeries` (med nummer hvis det finnes) |
| `bok.alder` | `AudienceRange` eller Thema-kvalifikatorer for alder, hvis det finnes |
| `bok.thema` | `Subject` med skjema 93 (og 94–99 for kvalifikatorer) |

Format: hent rå ONIX for 30–50 bøker av ulike typer (du har rådata i `scripts/out/` fra pakke A), og lag en tabell over hvilke `ProductForm`/`ProductFormDetail` som faktisk finnes. Foreslå en kort, norsk valgliste (for eksempel Innbundet, Heftet, Pocket, Spiral, Kartonert, Lydbok, E-bok) og hvordan kodene skal oversettes. Legg tabellen og forslaget i BOKADMIN2_OPPSETT.md og **vis Eirik forslaget før du låser listen**.

`productType` skal ikke lenger være forfatter. Sett den til «Bok», «Lydbok» eller «E-bok».

## Del 3: produktkategori
Sett `category` ved push: Print Books `gid://shopify/TaxonomyCategory/me-1-3`, Audiobooks `me-1-1`, E-Books `me-1-2`, ut fra formatet. Kontroller ID-ene mot taksonomien i 2026-07 før bruk.

## Del 4: SEO-tittel og metabeskrivelse
1. **SEO-tittel** (`seo.title`): «{Hovedtittel} – {Forfatter} ({format})», der forfatter er første forfatter og hovedtittel er teksten før første kolon. Er den lengre enn ca. 60 tegn, dropp formatet; er den fortsatt for lang, kutt hovedtittelen ved helt ord. Uten forfatter: «{Hovedtittel} ({format})».
2. **Metabeskrivelse** (`seo.description`), høyst 155 tegn: «{Hovedtittel} av {Forfatter} ({format}, {år}). » og så starten av forlagsteksten, kuttet ved helt ord (helst ved setningsslutt) med «…» hvis den er kuttet. Fjern HTML, og sørg for mellomrom der avsnitt og linjeskift fjernes (i dag blir det «søtsuget?Glukoserevolusjonens»).
3. **Ikke overskriv manuelle endringer:** lagre det Bokadmin sist genererte i et skjult metafelt (for eksempel `bokadmin.seo_auto`, JSON med tittel og beskrivelse). Oppdater bare hvis feltet i Shopify er tomt, lik forrige genererte verdi, eller lik den gamle automatikken (`title_tag = book.title` eller forlagsteksten kuttet på 320 tegn). Ellers: la stå, og logg «SEO-tittel endret manuelt, ikke overskrevet».
4. Tester for lengde, kutting ved ord, manglende forfatter, manglende format og manuelt endret felt.

## Del 5: omslag (alt-tekst og filnavn)
1. **Alt-tekst:** «Omslag: {Hovedtittel} av {Forfatter}» (uten forfatter: «Omslag: {Hovedtittel}»).
2. **Filnavn:** `{handle}-omslag.jpg` (eller riktig filendelse) når bildet lastes opp. Sjekk i 2026-07 hvordan filnavn settes ved opplasting, og om eksisterende filer kan få nytt navn (for eksempel `fileUpdate`).
3. Push setter i dag alt-tekst bare første gang. Oppdateringsjobben (del 8) skal kunne rette alt-tekst og filnavn på eksisterende bilder, uten å laste opp bildet på nytt hvis det ikke trengs.

## Del 6: forlagsteksten og reservebeskrivelse
1. Behold avsnitt og linjeskift fra ONIX når teksten blir HTML (`<p>` per avsnitt). Ingen sammenlimte setninger.
2. Mangler forlagstekst: lag en kort reservebeskrivelse fra feltene, for eksempel «{Hovedtittel} av {Forfatter}. {Format}, {sider} sider, utgitt {år} på {forlag}.» Utelat det som mangler.
3. Vis bøker som mangler forlagstekst på Import-siden (som listen «Mangler pris»), så de kan få en egen tekst.

## Del 7: tagger
1. Push skal ikke lenger legge forfatter eller tittel inn som tagger. `bkg-*` og andre interne tagger beholdes.
2. Ved oppdatering av eksisterende produkter: fjern bare tagger som er lik en forfatter eller tittelen på boka (sammenlign uten store/små bokstaver og ekstra mellomrom). Rør ikke andre tagger. Logg hva som ble fjernet.

## Del 8: jobben «Oppdater eksisterende bøker»
Dette er selve testen Eirik vil kjøre i pakke D.
1. En ny jobb i samme rammeverk som pris- og tilgjengelighetsjobben (pulser, kan pauses og gjenopptas, statusside), som går gjennom alle produkter med ISBN i butikken.
2. For hver bok: hent ONIX (fra cache, se punkt 4), regn ut alt fra del 1–7, sammenlign med det som står i Shopify, og oppdater bare det som er annerledes. Pris, status, tilgjengelighet og handle endres ikke her.
3. **Sjekkmodus** (standard) viser per felt hvor mange bøker som ville blitt endret, med eksempler. **Oppdateringsmodus** gjør endringene. Sammendraget viser endret, uendret, hoppet over (med årsak) og feil.
4. **ONIX-cache:** lagre rå ONIX per ISBN i en ny tabell (for eksempel `onix_cache` med `isbn`, `xml`, `fetched_at`), så 11 000 bøker ikke betyr 11 000 nye Bokbasen-kall hver gang. Bruk cache yngre enn for eksempel 7 dager. Migrasjonen skal bare legge til.
5. Hold deg innenfor Shopifys grenser for API-kall (se på `extensions.cost` og vent ved behov). Bulk-operasjoner for hele katalogen kommer i pakke D. Lag jobben slik at den senere kan bytte til bulk uten å skrive om regnelogikken (én ren funksjon som gir ønsket tilstand for en bok).
6. En knapp på Oppdatering-siden for å starte jobben i sjekk- eller oppdateringsmodus.

## Del 9: samlingsnavn
Sjangersynken skal også rette navnet på samlinger som allerede finnes når navnet er feil (for eksempel `bkg-33`, `bkg-328` og `bkg-432` med «Bokgruppe NNN»). Bruk den felles navnelisten. Handle på samlingene endres ikke i denne pakka.

## Test i Testbutikk
1. Velg 10 bøker av ulike typer (to forfattere, redaktør, lang tittel, uten forlagstekst, serie, barnebok, kommende bok).
2. Kjør oppdateringsjobben i sjekkmodus og legg ved sammendraget.
3. Kjør den i oppdateringsmodus på de 10. Kontroller i Shopify: metafeltene, kategori, productType, SEO-tittel, metabeskrivelse, alt-tekst, filnavn, beskrivelse og tagger. Kontroller at pris, status og handle er uendret.
4. Endre SEO-tittelen manuelt på én bok og kjør på nytt: den skal stå urørt.
5. Push én ny bok med to forfattere og kontroller handle og alle feltene.

## Til slutt
- Deploy (si fra først) og push til GitHub (si fra først).
- Oppdater BOKADMIN2_OPPSETT.md (standarden, formatlisten, jobben, testen) og CLAUDE.md.
- Rapporter kort per del: gjort, testet, gjenstår, commit-hash. Bekreft at pris, status og handle ikke er endret av jobben, og at live ikke er rørt.
