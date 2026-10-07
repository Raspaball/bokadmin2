# Pakke I del A: import og push til Testbutikk (2026-10-07)

Bare Testbutikk og Supabase «Bokadmin 2.0». Live er ikke rørt. Ingen deploy.

## Utvalg
Eirik slettet 9 Gyldendal-bøker fra Testbutikk (fra `nytesten.csv`) som nye testbøker. Maximum 10 (9788205538269) ble ikke brukt (9 i stedet for 10). Oppslag i Bokbasen med `bokbasen/isbn/<isbn>`, push med `shopify/push-bulk` (samme kall som Import-siden). Skript: `scripts/pakke-i/push.mjs` og `scripts/pakke-i/kontroll.mjs`.

**Ikke testet** (finnes ikke i utvalget og ikke på bobokogpapir.no): kommende bok, bok uten forlagstekst, institusjon som forfatter, lydbok som hoppes over, utenlandsk bok. Kandidater fra bobokogpapir.no (146 ISBN som ikke finnes i Testbutikk) ligger i `scripts/out/pakke-i/mangler.json`, men ingen i disse kategoriene.

## Kontroll mot standarden (18 kontroller, alle ok for alle 9)
handle = `buildBookHandle()`, SEO-tittel (≤70, uten linjeskift) og metabeskrivelse (≤320), alt-tekst «Omslag: {tittel} av {forfatter}», filnavn `{handle}-omslag.jpg`, productType «Bok», kategori Print Books, bok.*-felt (isbn, forfatter, format, sider, utgivelsesår, språk, bokgruppe, tilgjengelighet), bok.isbn = ISBN, bok.tilgjengelighet = `availabilityRule()`, bare bkg-tagger og bkg-taggen for boka, status = regelen, alle 3 salgskanaler, strekkode og SKU = ISBN, `<p>`-beskrivelse, «Spor beholdning» av.

| ISBN | Tittel | Forfattere | ONIX | Pris | Status | År / dato (bok.*) | Tagger | Kanaler |
|---|---|---|---|---|---|---|---|---|
| 9788205523623 | Konstruksjons- og styringsteknikk | 4 | 21 | 855 | ACTIVE | 2021 / 2021-05-10 | bkg-1,12,120 | 3/3 |
| 9788205523647 | Produktivitet og kvalitetsstyring | 2 | 21 | 769 | ACTIVE | 2021 / 2021-03-01 | bkg-1,12,120 | 3/3 |
| 9788205518087 | Portør | 4 | 21 | 479 | ACTIVE | 2019 / 2019-02-19 | bkg-1,12,120 | 3/3 |
| 9788205530645 | En helt vanlig familie | 1 | 21 | 229 | ACTIVE | 2019 / 2019-08-16 | bkg-5,50,504 | 3/3 |
| 9788205551251 | Aqua 1 | 3 | 21 | 455 | ACTIVE | 2021 / 2021-08-17 | bkg-1,12,120 | 3/3 |
| 9788205548749 | Mønster | 4 | 21 | 1175 | ACTIVE | 2021 / 2021-10-13 | bkg-1,12,120 | 3/3 |
| 9788205548695 | Treningslære | 6 | 21 | 1039 | ACTIVE | 2021 / 2021-08-06 | bkg-1,12,120 | 3/3 |
| 9788205548381 | Explore 6, 2. utg | 4 | 21 | 335 | ACTIVE | 2021 / 2021-06-16 | bkg-1,11,110 | 3/3 |
| 9788205537507 | Refleks 6 | 4 | 21 | 505 | ACTIVE | 2021 / 2021-08-10 | bkg-1,11,110 | 3/3 |

År og dato i Shopify er lik ONIX-verdiene for alle ni.

## Push nr. 2 på de samme bøkene
Alle 9 svarte «eksisterte» (ikke ny). Øyeblikksbilde før/etter (tittel, handle, status, type, kategori, leverandør, tagger, beskrivelse, SEO, alle metafelt, alt/filnavn, pris, lagerpolicy, kanaler): **0 forskjeller**. Ingen duplikater (én variant per strekkode). Katalogen: 9059 produkter.

## Observasjon (ikke feil)
SEO-tittelen har noen steder formatet i parentes («Portør – Liv Laukvik Nannestad (Heftet)»), andre steder ikke (Konstruksjons- og styringsteknikk). Det følger regelen i `bookSeo()` (lengdegrense); sjekk om det er ønsket.
