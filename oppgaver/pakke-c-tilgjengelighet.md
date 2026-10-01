# Oppgave til Claude Code: pakke C, kommende og midlertidig utsolgte bøker (Bokadmin 2.0)

Skrevet i Cowork 02.10.2026. Start først når pakke A2 er ferdig. Følg delene i rekkefølge, og spør Eirik hvis noe er uklart eller ser ut til å treffe live-systemet.

Miljø: C:\Bokadmin 2.0, repo Raspaball/bokadmin2, Supabase «Bokadmin 2.0» (ref chwpqwblqummlufqdefe), Shopify bare testbutikk-9434.myshopify.com.

## Beslutning (Eirik, 02.10.2026)
Kommende bøker og bøker som er midlertidig utsolgt skal ikke lenger bli utkast (DRAFT). De skal være synlige og kunne kjøpes, med en tydelig tekst på produktsiden. Bakgrunnen er at en side som blir utkast gir 404, og da mister Google den, nettopp når kommende bøker gir søketrafikk.

Dette endrer tilgjengelighetslogikken (ONIX List 65) med vilje. Pris-logikken (List 58) endres ikke.

## Sikkerhet
- Ikke rør live-systemet: mappa C:\Bokadmin (den kan leses), repoet Raspaball/bokadmin, Supabase-prosjektet «Bokadmin» (live), Vercel «bokadmin» og livebutikken.
- Du er den eneste som gjør Supabase-endringer mens dette pågår. Si fra før du kjører migrasjoner, deployer eller pusher.
- Migrasjoner skal bare legge til. Legg aldri hemmeligheter i git.
- Valider nye eller endrede GraphQL-operasjoner mot Admin API 2026-07.
- Én commit per del. Kjør `node --test scripts/*.test.mjs` før hver commit.

## Ny regel (erstatter `mapAvailabilityToShopifyStatus` i `availability-check`)

| ONIX List 65 | Status i Shopify | Kan kjøpes | `bok.tilgjengelighet` |
|---|---|---|---|
| 20–23 (tilgjengelig) | ACTIVE | Ja | `tilgjengelig` |
| 10, 11, 12 (ikke utkommet, kommer, utsatt) | ACTIVE | Ja (forhåndsbestilling) | `kommer` |
| 30–34 (midlertidig utilgjengelig, trykkes på nytt o.l.) | ACTIVE | Ja (vi bestiller) | `midlertidig_utsolgt` |
| 43, 46, 49 | ARCHIVED (som i dag) | Nei | `utgatt` |
| Alt annet | DRAFT (som i dag) | Nei | `ikke_tilgjengelig` |

«Kan kjøpes» skal være sant uansett lagerbeholdning. Sjekk først hvordan varianter blir laget i dag: om lageret spores (`inventoryItem.tracked`) og hva `inventoryPolicy` er. Velg den minste endringen som gjør at bøker med `kommer` og `midlertidig_utsolgt` kan kjøpes. Det kan være lager som ikke spores, eller `inventoryPolicy: CONTINUE`. Ikke endre lagerbeholdning eller lokasjoner. Rapporter hva du fant og valgte.

## Del 1: nye metafelt
Opprett i Testbutikk (navnerom `bok`, lesetilgang i Storefront, festet i admin):
- `bok.tilgjengelighet`: single_line_text_field, med validering (choices) for de fem verdiene i tabellen.
- `bok.utgivelsesdato`: date. Hentes fra ONIX `PublishingDate` (rolle 01), ellers `PublicationDate`. Importen leser allerede dette i `bokbasen/index.ts`, men lagrer bare året.

## Del 2: tilgjengelighetssjekken
1. Bytt ut regelen med tabellen over, i én delt funksjon i `_shared` (for eksempel `_shared/availability.ts`) med tester for hver kodegruppe, ukjent kode og tom kode.
2. Jobben setter status, `bok.tilgjengelighet` og `bok.utgivelsesdato`, og gjør boka kjøpbar der tabellen sier det.
3. Loggen sier hva som ble endret, for eksempel «Kommer 15.11.2026: ACTIVE, kan forhåndsbestilles» eller «Midlertidig utsolgt: ACTIVE».
4. Sjekkmodus (analyse) skal vise hva som ville blitt endret, uten å endre noe.

## Del 3: push og CSV bruker samme regel
1. Push skal ikke lenger alltid sette `ACTIVE`. Status og `bok.tilgjengelighet` kommer fra ONIX-koden etter den delte regelen. Det betyr at importen må lese tilgjengelighetskoden (`ProductAvailability`) hvis den ikke gjør det allerede.
2. Regelen fra pakke A2 del 1 gjelder fortsatt: en ny bok uten godkjent pris blir alltid utkast, uansett tilgjengelighet.
3. Push setter `bok.utgivelsesdato`.
4. CSV-eksporten følger samme regel for status.

## Del 4: test i Testbutikk
1. Kjør tilgjengelighetssjekken i sjekkmodus. I september ville den satt 35 bøker til utkast (ONIX 10: 27, 11: 8). Nå skal de bli `kommer` og forbli ACTIVE.
2. Kjør i oppdateringsmodus. Kontroller på 3 bøker at status, `bok.tilgjengelighet`, `bok.utgivelsesdato` og kjøpbarhet er riktige, og at én kommende bok kan legges i handlekurven på nettsiden.
3. Ingen priser skal endres.

## Ikke i denne pakka
- Visningen i temaet («Kommer 15. november», knappetekst «Forhåndsbestill», «Midlertidig utsolgt – vi bestiller den til deg»). Det kommer i Folio. Midlertidig kan det vises med en enkel blokk i Horizon hvis det er raskt, men det er valgfritt.
- 301-videresending for utgåtte bøker (43, 46, 49) og kode 41 (erstattet). Det tas senere.

## Til slutt
- Deploy de endrede funksjonene til 2.0 (si fra først) og push til GitHub (si fra først).
- Oppdater BOKADMIN2_OPPSETT.md (ny regel og test) og CLAUDE.md.
- Rapporter kort per del: hva som ble gjort, testet og gjenstår, med commit-hash. Bekreft at ingen priser er endret og at live ikke er rørt.
