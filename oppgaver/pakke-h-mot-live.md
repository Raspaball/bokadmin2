# Oppgave til Claude Code: pakke H, rett siste feil og ny generalprøve

Skrevet i Cowork 06.10.2026. Les CLAUDE.md og BOKADMIN2_OPPSETT.md (seksjon «Pakke G») først. Bare Testbutikk og Supabase «Bokadmin 2.0». Live røres aldri. Én commit per del, tester før hver commit, si fra før deploy, migrasjon og push. Rapporter kort per del (hva, commit, tall), detaljer til `scripts/out/`.

## Hva Cowork fant 06.10 (bare lesing)
- Pakke G er deployet (funksjonene oppdatert 03.10 kl. 02:53–03:28 UTC). Bokdata-sjekken 03.10 kl. 02:54 UTC (bulk) ga 1 928 nye metabeskrivelser og 0 «manuelt endret» på de første 3 000. Rettingen virker.
- Den stoppet ved 3 000: Supabase-loggen viser **«CPU Time exceeded»** 11 ganger mellom 02:55 og 03:54 UTC. Hver puls planlegger `BULK_CHUNK = 1000` produkter (leser hele JSONL-fila på nytt, tolker ONIX, sammenligner tekster, skriver 1 000 loggrader). Pulsen dør før `save()`, så samme bit prøves om og om igjen uten framgang.
- Den vellykkede oppdateringen 03.10 kl. 00:30 UTC (9 050, 53 min) kjørte med koden fra før pakke F/G. Med dagens kode vil oppdateringsmodus trolig stoppe på samme sted, siden planleggingen er den samme (og oppdatering gjør mer per bit).
- Tilgjengelighetsjobben publiserer ikke. Bare push (`shopify/index.ts`, `publishablePublish`) publiserer. Derfor får bøker som aktiveres av jobben ikke alle salgskanaler.
- «99 beskyttede endret 03.10»: alle beskyttede produkter med `updatedAt` 03.10 har `updatedAt` = `createdAt` + 12 timer (± 20 s), og ingen hendelser i produktloggen etter opprettelsen. Det er Shopifys egen etterbehandling etter CSV-importen 02.10, ikke Bokadmin. Må bekreftes på innhold (del 4).
- Samlingen `wrendale` finnes nå (3 produkter; 102 har leverandør «Wrendale Design ltd», som er beskyttet uansett).

## Del 1: CPU-grensen i bulk-jobbene (gjelder både sjekk og oppdatering)
Gjelder `book-update` og felles `_shared/bulk-job.ts` (samme `BULK_CHUNK` brukes av de andre jobbene).
1. Mål CPU per produkt i planleggingen lokalt (`scripts/sjekk-lokalt.mjs` mot snapshotet) og finn hva som koster mest (ONIX-tolking, tekstsammenligning, JSONL-lesing, logger).
2. Mindre biter med tidsbudsjett: planlegg i små porsjoner (start ca. 100–200), lagre `planIndex`, tellere og logger etter hver porsjon, og avslutt pulsen i god tid. En puls som dør skal aldri miste mer enn én porsjon.
3. Ikke les og tolk hele JSONL-fila for hver bit: hopp raskt til riktig linje, eller del fila én gang (f.eks. i Storage eller en tabell) og les bare biten.
4. Selvjustering: feiler samme `planIndex` to ganger, halver porsjonen. Etter fem forsøk: stopp jobben med en tydelig feilmelding i stedet for å gå i ring.
5. Livstegn minst hvert 20. sekund også i plan- og apply-fasen.
6. Test: hele snapshotet (9 050) lokalt, deretter sjekkmodus i Testbutikk fra Bokadmin. Kriterium: ingen «CPU Time exceeded» i loggen og jobben fullfører.

## Del 2: alle salgskanaler
1. Felles funksjon i `_shared/` som publiserer et produkt på alle salgskanaler appen har (samme som push). Bruk den i push, i tilgjengelighetsjobben når en bok aktiveres, og i bokdata-jobben for aktive bøker som mangler kanaler. Beskyttede, lydbøker, e-bøker og ikke-bøker røres ikke.
2. Sjekkmodus teller «ville blitt publisert på N kanaler». Valider GraphQL mot 2026-07 (`publishablePublish`, `publications`). Bulk der det er mange.
3. Rapport: hvor mange aktive bøker i Testbutikk ligger ikke på alle kanaler i dag.

## Del 3: bøker uten forlagstekst
1. Har ONIX ingen beskrivelse og Shopify-beskrivelsen er tom (også `<p></p>`), lages en kort faktatekst fra feltene (Eirik 06.10): `<p>{Tittel} av {Forfatter}. {Format}, {sider} sider, utgitt {år}.</p>`. Deler som mangler utelates (uten forfatter: «{Tittel}. …»). «Annet» og institusjoner brukes ikke. En eksisterende tekst overskrives aldri.
2. Teksten lagres i `bokadmin.seo_auto` (eller tilsvarende) som generert, så den kan byttes ut når forlagsteksten kommer i ONIX.
3. Metabeskrivelsen for disse er bare «Tittel av Forfatter (format, år).» (som i dag).
4. Liste over alle bøker uten forlagstekst til `scripts/out/uten-beskrivelse.csv`.

## Del 3b: videresending for arkiverte bøker
Arkiverte bøker (kode 41, 43, 46–49) gir 404. Shopify bruker en URL-videresending bare når adressen gir 404, så en videresending gjør ingen skade hvis boka senere blir aktiv igjen.
1. Når tilgjengelighetsjobben arkiverer en bok (og for bøker som allerede er arkivert av Bokadmin), lag en videresending fra `/products/{handle}` (`urlRedirectCreate`, valider mot 2026-07):
   - Kode 41: til den nye utgaven hvis ONIX har en erstatning (RelatedProduct med relasjonskode 05 «Replaced by») og den finnes som aktiv bok i butikken.
   - Ellers: til samlingen for bokas bokgruppe (`bok.bokgruppe`), hvis den finnes.
   - Ellers: ingen videresending, bare liste.
2. Ingen kjeder: den gamle ISBN-adressen (`/products/{ISBN}`) skal peke rett til det nye målet. Oppdater den eksisterende videresendingen i stedet for å legge en ny oppå.
3. Blir en arkivert bok aktiv igjen: slett videresendingen fra handlen.
4. Beskyttede røres aldri. Utkast (40, 42, 44) får ikke videresending nå.
5. Sjekkmodus viser antall per måltype og 10 eksempler. Liste til `scripts/out/videresendinger.csv`.

## Del 4: kontroll av beskyttede produkter (bare lesing)
1. Sammenlign innholdet i alle beskyttede produkter (tittel, beskrivelse, tagger, leverandør, type, status, pris, handle, SEO, bilder, samlinger) mellom importfilene (`scripts/data/full-del-*.csv`) og Testbutikk nå. Rapport: antall like, og alle avvik.
2. Endre kontrollen etter kjøringer: beskyttede sjekkes på innhold, ikke `updatedAt`.

## Del 5: deploy og full sjekk
Etter ja fra Eirik: deploy, så bokdata (sjekk), tilgjengelighet (sjekk) og bokgrupper (sjekk) på hele Testbutikk. Rapport med tall per felt og 10 eksempler. Ikke oppdateringsmodus før Eirik og Cowork har sett rapporten.

## Venter (ikke i denne pakken)
Lesbare samlingsadresser og samlingstekster, videresending for utkast, revisjonsskript, live-forberedelser.
