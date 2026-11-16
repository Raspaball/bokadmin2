# Bokbasen ny, trinn 2: måling og tester mot listeoppslaget   (16.11.2026, skrevet av Cowork/Claude for Claude Code)

## Mål (én setning)
Finne ut, bare ved å lese fra Bokbasen, om listeoppslaget i v3 kan være eneste kilde til bokdata: først og fremst om det gir **hele katalogen**.

## Hvorfor dette avgjør resten
Den nye standarden bruker ikke enkeltoppslag. Da må lista gi alle bøkene våre, også de som ikke er endret på lenge, og nye bøker vi ikke har. Gjør den ikke det, stopper vi og går tilbake til Eirik før trinn 3.

## Les først
- `CLAUDE.md`, `oppgaver/bokbasen-ny/STATUS.md`
- Prosjektdokumentet `plan-bokbasen-ny.md`, tabellen «Det vi tester selv»
- Bokbasen: «ONIX» https://bokbasen.jira.com/wiki/spaces/api/pages/67993632 og «Export Service» (paginering, `next`, `after`, `pagesize`) https://bokbasen.jira.com/wiki/spaces/api/pages/48955432
- `scripts/lib/clients.mjs` (innlogging), `scripts/cpu-maling.mjs` (mønster for tidsmåling), `supabase/functions/_shared/onix.js`, `price.ts`, `availability.ts`
- `supabase/functions/bokbasen/index.ts` rundt linje 360–400 (dagens datoperiode bruker alt listeoppslaget i v2)

## Modell
Sonnet til skriptene. Opus til å tolke resultatet i del A og C hvis svaret ikke er entydig.

## Rammer (gjelder alle testene)
- **Bare lesing.** Ingen skriving til Supabase, Shopify eller Bokbasen. Ingen deploy, ingen migrasjon, ingen klokkejobb.
- Skriptene ligger i `scripts/bokbasen-ny/`. Alt de lagrer, ligger i `scripts/out/bokbasen-ny/` (ikke i git).
- **«Våre ISBN»** i denne fasen = ISBN-ene i `onix_cache` (16 973 rader, bare SELECT). Shopify leses ikke.
- **Skånsomt mot Bokbasen:** ett kall om gangen (unntatt test E), minst 1 sekund pause mellom kallene, ingen omstart i løkke. Ved 429 eller 5xx: vent 60 sekunder, prøv én gang til, så stopp. Vi tester ikke grensene deres.
- **Enkeltoppslag:** høyst 50 per testrunde. Skriptet teller dem og nekter å gå over. Antallet står i rapporten.
- Lagre per post bare et utdrag (én linje JSON): ISBN, NotificationType, ProductForm, ONIX-kode, valgt pris og pristype, bokgruppe, utgivelsesdato, størrelse i byte, og et fingeravtrykk av pris + kode + bokgruppe. Hel XML lagres bare for våre ISBN og for prøvene som trengs i test B, G og I.
- Lagre alltid siste bokmerke (`next`) med tidspunkt i en egen fil, så en henting kan fortsette der den stoppet.
- Bruk adresse-konstanten fra trinn 1 hvis den er ferdig; ellers én konstant øverst i `scripts/bokbasen-ny/lib.mjs`.

## Testene

### Runde 1 (dag 0, noen timer)

**A. Hele katalogen eller et utvalg? Hvor mye per døgn? (viktigst)**
- Hent alt «endret siden i går kl. 00.00» (`after`), abonnement `extended`, 200 per bunke, følg `next` til svaret er tomt.
- Tell: poster, bunker, byte, tid per kall. Fordel på NotificationType, ProductForm, ONIX-kode og språk.
- Tell hvor mange som er våre ISBN, og hvor mange som **ikke** er det. Ta med 10 eksempler på bøker vi ikke har (tittel, forlag, format).
- Se om poster kommer flere ganger i samme henting.

**B. Hele poster eller delposter?**
- Ta 10 av våre ISBN fra test A. Sammenlign elementene i lista med kopien i `onix_cache`: er alle hoveddelene med (tittel, forfatter, pris, tilgjengelighet, tekst, emner, omslag)?
- Se spesielt på NotificationType og på slettede poster (05): hva inneholder de?

**C1. Langt tilbake i tid, prøve**
- `after` = 01.01.2020. Hent bare de 20 første bunkene.
- Noter: virker det, hvilke endringsdatoer har de første postene, kommer de i rekkefølge etter tid, og hvor langt i tid 20 bunker rekker. Anslå ut fra det hvor mange poster og hvor lang tid en hel henting fra 2020 vil ta.
- Stopp ved første feil og noter feilen ordrett. **Hele hentingen (C2) gjøres ikke uten Eiriks ja.**

**C-okt. Fra eldste rad i lageret til i dag**
- `after` = eldste `fetched_at` i `onix_cache` minus ett døgn (slå opp datoen med SELECT; ventet rundt 29.09.2026).
- Hent alt fram til nå, i flere økter om nødvendig (fortsett fra lagret bokmerke).
- Dette er grunnlaget for test H, og viser hvor stor en «første henting» på sju uker er.
- Tell: hvor mange av våre 16 973 ISBN kom med i lista i perioden.

**E. To bokmerker samtidig**
- Kjør to hentinger parallelt med hver sin `after` (for eksempel i går og for tre dager siden), 5 bunker hver.
- Kontroll: begge går framover uavhengig av hverandre, og gir samme poster som når de samme to kjøres etter hverandre.

**F. `basic`, `extended` og `school`**
- Samme `after` og bare første bunke for hvert abonnement.
- Sammenlign antall poster og hvilke elementer som mangler i `basic`. Gir `school` 401/403: noter det og gå videre, ikke prøv igjen.

**G. Stemmer lista med enkeltoppslaget? (50 enkeltoppslag, hele rundens kvote)**
- Velg 50 poster fra test A og C-okt: 30 av våre og 20 vi ikke har, spredt på format og ONIX-kode.
- Slå opp hver med enkeltoppslag (v3) og sammenlign felt for felt med de samme funksjonene som i trinn 1 (tittel, forfatter, pris og pristype, kode, status, dato, år, bokgruppe, format, tekst).
- Krav: 0 uforklarte forskjeller. En forskjell som skyldes at boka ble endret mellom de to kallene, kontrolleres ved å se om en nyere post ligger i lista.

**I. Regnetid per bunke**
- Mål på Eiriks maskin (CPU-tid, ikke klokketid, som i `scripts/cpu-maling.mjs`) for én bunke på 200 og én på 50 poster:
  1. bare dele opp i poster og finne ISBN med enkelt tekstsøk
  2. lage utdraget (pris, kode, bokgruppe, tittel, forfatter, format, dato) med funksjonene i `_shared/`
  3. full `bookFieldsFromOnix()`
- Kjør hver måling 10 ganger og oppgi median og høyeste. Si tydelig at Supabase er tregere enn maskinen, og hvor stor margin vi bør ha til grensen på 2 sekunder.

### Etter runde 1: stopp og rapporter (se «Rapport»). Vent på Eirik.

### Runde 2 (etter Eiriks ja)

**C2. Hele hentingen langt tilbake**
- Bare hvis C1 viste at det virker og Eirik har sett anslaget. Fortsett fra bokmerket til C1.
- Tak: avtales med Eirik ut fra anslaget (antall bunker eller timer per økt). Kan deles over flere økter.
- **Hovedtallet:** hvor mange av våre 16 973 ISBN finnes i lista når hentingen er ferdig?
- For ISBN som mangler: del dem i grupper (utgåtte, utenlandske, ikke-bøker, annet) ut fra `onix_cache`, og slå opp inntil 50 av dem med enkeltoppslag for å se om Bokbasen fortsatt har dem.

### Løpende over to uker

**D. Hvor lenge virker et bokmerke?**
- Ta vare på bokmerket fra slutten av test A (dag 0). Bruk det på dag 2, dag 4 og dag 7, ett kall hver gang.
- Noter: virker det, og begynner svaret der vi slapp (første post er nyere enn siste fra dag 0)?

**H. Kommer prisendringer i lista? (uke 1 og uke 2, 50 enkeltoppslag hver gang)**
- Først: hent lista fram til nå fra lagret bokmerke (eller `after` hvis bokmerket er dødt).
- Velg 50 tilfeldige av våre ISBN som **ikke** har kommet i lista siden raden i `onix_cache` ble hentet.
- Slå dem opp med enkeltoppslag. Pris, pristype og ONIX-kode skal være like kopien i `onix_cache`.
- Er noe ulikt, har Bokbasen endret boka **uten** at den kom i lista. Det er et uforklart avvik og skal rapporteres med ISBN (i `scripts/out/`), felt, gammel og ny verdi.
- Husk at kopiene er hentet i v2. Bruk tolkeren fra trinn 1 som tåler begge.

**J. Hvor ofte skal vi hente?**
- Ingen egen test. Foreslå ut fra tallene: poster per time og døgn, tid per henting, og hvor mye som er vårt.

## Hva som regnes som svar på hovedspørsmålet

| Svar | Når |
|---|---|
| **Ja, hele katalogen** | Bøker vi ikke har, kommer i lista (A), **og** minst 99 % av våre ISBN finnes etter C2, **og** de som mangler er forklart (for eksempel fjernet hos Bokbasen) |
| **Nei** | Lista gir bare et utvalg, henting langt tilbake virker ikke, eller en vesentlig del av våre bøker mangler uten forklaring |
| **Uklart** | Alt annet. Si nøyaktig hva som mangler for å avgjøre det |

Ved «Nei» eller «Uklart»: ingen forslag om omveier i koden. Legg fram funnene for Eirik.

## Dette skal IKKE røres
- Supabase (bare SELECT), Shopify (ikke i bruk i dette trinnet), Edge Functions, frontend, `_shared/` (les, ikke endre).
- Gamle Bokadmin. Den bruker samme Bokbasen-innlogging: ikke gjør noe som kan forstyrre den (derfor skånsom takt).
- Ingen henter, tabell eller klokkejobb bygges her. Det er trinn 3.

## Miljø
Gren: `bokbasen-ny/trinn-2` (bare skript og rapport). Supabase 2.0 (ref `chwpqwblqummlufqdefe`), bare SELECT. Butikk: ingen. Bokbasen: bare lesing.

## Tester og kontroll (må være grønne)
- `node --test scripts/*.test.mjs` (også en liten test for telleren som stopper enkeltoppslag over 50)
- Hvert skript har `--torr` som viser hva det vil gjøre og hvor mange kall, uten å kalle Bokbasen
- Ingen rå ONIX, ISBN-lister eller bokmerker i git

## Stopp og spør hvis
- Bokbasen svarer 401, 403 eller 413, eller 429/5xx to ganger
- en henting ser ut til å bli mye større enn ventet (over 1 GB på disk eller over 2 timer i én økt)
- lista ser ut til bare å gi et utvalg (test A): stopp etter runde 1, ikke start C2
- du er i tvil om et kall er lesing

## Krever Eiriks ja
1. Planen din (maks 15 linjer) før runde 1.
2. C2 (hele hentingen langt tilbake), etter rapporten fra runde 1.
3. Sammenslåing til `main` (bare skript og rapport).

## Tilbakerulling
Ingenting å rulle tilbake: bare lesing. Stopp skriptet. Slett `scripts/out/bokbasen-ny/` hvis dataene ikke trengs.

## Rapport

**Hvor:** `oppgaver/bokbasen-ny/trinn-2-rapport.md` i git. Bare tall og korte forklaringer, **ingen ISBN-lister** (repoet er offentlig). Detaljer og rådata i `scripts/out/bokbasen-ny/`.

**Når:** én rapport etter runde 1, og tillegg nederst etter runde 2, uke 1 og uke 2 (med dato).

**Form:**
1. Øverst, to linjer: «Gir listeoppslaget hele katalogen? **Ja / Nei / Uklart**», og hovedgrunnen.
2. Én tabell med en linje per test (A–J):

   | Test | Spørsmål | Svar | Tall | Sikkerhet |
   |---|---|---|---|---|
   | A | Hele katalogen? Endringer per døgn? | … | poster, bunker, andel våre, andel ikke våre | Målt / Antar |

3. «Uforklarte avvik»: liste, eller «Ingen».
4. «Brukt»: antall listekall, antall enkeltoppslag per runde (skal være ≤ 50), tid, MB på disk.
5. «Forslag»: hvor ofte vi bør hente, bunkestørrelse (200 eller 50), og om første henting langt tilbake er gjennomførbar.
6. «Eirik må bestemme»: nummerert liste.

Merk hvert tall **Målt** eller **Antar**. Tall fra hentinger som ikke er ferdige, merkes «foreløpig».
Høyst 40 linjer utenom tabellen. Cowork lager etterpå et kort sammendrag i prosjektet.
