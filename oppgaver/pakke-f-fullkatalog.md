# Oppgave til Claude Code: pakke F, generalprøve med hele livekatalogen

Skrevet i Cowork 02.10.2026. Gjør pakke E ferdig først (koden kan skrives mens Testbutikk fylles). Les også `regel-beskyttede-samlinger.md`, `pakke-d-generalprove.md` og BOKADMIN2_OPPSETT.md.

Mål: Testbutikk skal være en tro kopi av livebutikken (17 169 produkter). Bokadmin 2.0 skal kjøre hele overgangen på den, og vi skal kunne bevise at alle bøker følger den nye standarden, at tagg-rotet er ryddet, og at ingenting annet er rørt.

## Sikkerhet
Som før: live røres aldri (bare lesing av eksportfila), beskyttede produkter røres aldri, si fra før sletting, migrasjoner, deploy og hver push. Live-data bare i `scripts/data/` eller `scripts/out/` (ignorert av git).

## Del 1: analyse av eksportfila (bare lesing)
Eirik legger fila i `scripts/data/live-full-2026-10-02.csv`. Rapporter:
1. Antall produkter per status, og antall med gyldig ISBN-13 (strekkode/SKU/handle) mot uten.
2. **Ikke-bøker med ISBN:** produkter med ISBN som ikke er bøker (kalendere, spill, puslespill, kort, papir o.l.). Bruk produkttype, tagger og senere ONIX `ProductForm`. Forslag til regel: Bokadmin behandler bare produkter med ISBN **og** treff i Bokbasen **og** bokformat (`ProductForm` B*, lydbok A*, e-bok E*). Alt annet hoppes over og telles.
3. **Beskyttede:** hvor mange har `gave`, `lokal`, `lokalhistorie` eller `lokallitteratur`. Sammenlign med samlingene i live (Gaveartikler 83, Lokalhistorie 63). Er tallene ulike, må vi ha hele regelsettet til samlingene (Eirik sender skjermbilder) før noe kjøres.
3b. **Wrendale Designs:** hvor mange produkter har leverandør som inneholder «wrendale» (i live: «Wrendale Design ltd»), og hvor mange av dem har ISBN. Se tillegget i `regel-beskyttede-samlinger.md`.
4. **Tagger som styrer andre samlinger:** bare tre samlinger skal beskyttes (se regel-fila). Rapporter likevel i testen antall produkter i hver smarte samling før og etter, så vi ser om taggryddingen tømmer noen samling Eirik ikke har tenkt på.
5. **Lager:** hvor mange bøker har lagerbeholdning > 0, og hvor mange av dem har en ONIX-kode som ville gjort dem til utkast eller arkivert. Se del 2.
6. **Duplikater:** alle ISBN med flere produkter (rapporten fra pakke D 3b).
7. **Tagger i dag:** antall unike tagger, de 50 vanligste, og et anslag på hvor mange som er tittel-/forfatterbiter som vil bli fjernet.
8. **Størrelse:** Shopify-import tar høyst 15 MB per fil. Lag importfiler (`scripts/data/full-del-NN.csv`) under grensen, med apostrofen foran tall fjernet som i runde 1, og kontroller fil for fil at verdiene leses tilbake likt.

## Del 2: regler som må på plass før kjøringen
1. **Lagerbeholdning går foran Bokbasen:** har en bok fysisk lager > 0 (alle lokasjoner), skal tilgjengelighetsjobben aldri sette den til utkast eller arkivert, og ikke endre `inventoryPolicy`. Den kan fortsatt sette `bok.tilgjengelighet`. Logg «Status beholdt: på lager (N)». Dette gjelder trolig de engelske bøkene med kode 40.
2. **Bare bøker** (regelen i del 1.2). Tester.
3. **Wrendale:** beskyttelse via leverandør og medlemskap i `wrendale` (se regel-fila). Tester.
4. **Bokgruppe som metafelt:** sett `bok.bokgruppe` (i tillegg til bkg-taggene) i sjangersynken og push, så samlingene senere kan bytte regel fra tagg til metafelt.
5. **Samlinger og SEO (valgfritt før testen, Eirik avgjør):** lesbare handles for bkg-samlingene (for eksempel `krim-og-spenning`) med videresending fra `bkg-NNN`, SEO-tittel og en kort beskrivelse. Koden må da finne samlingene på regel/metafelt, ikke på handle.

## Del 3: logging og kontroll som må finnes før kjøringen
1. **Én rad per produkt per jobb** i `sync_log` med utfall: endret (hvilke felt), uendret, hoppet over (årsak: ingen ISBN, ikke bok, ikke i Bokbasen, beskyttet, duplikat, egen pris, egen tilgjengelighet, på lager, arkivert), feil (melding).
2. **Livstegn:** jobbene oppdaterer `jobs` minst hvert minutt (behandlet, gjenstår, siste ISBN). Står en jobb stille i mer enn 5 minutter, skal Oppdatering-siden vise det tydelig. Alle jobber skal kunne gjenopptas uten å gjøre noe dobbelt.
3. **Øyeblikksbilde før og etter:** full lesing av katalogen (bulk query) før første steg og etter siste, lagret i `scripts/out/`. Et skript sammenligner felt for felt og lager rapporten i del 5.
4. **Eksport av logg:** CSV med alle hoppet over og feil, per jobb.

## Del 4: kjøringen (Testbutikk, samme rekkefølge som ved overgangen)
0. Øyeblikksbilde. Duplikatrapport (Eirik bestemmer og sletter).
1. ONIX-henting til cache for alle bøker (mål tid, antall ikke funnet).
2. Bokgrupper. 3. Handles (med videresending). 4. Bokdata (bulk). 5. Tilgjengelighet. 6. Pris: **bare sjekk**. 7. Øyeblikksbilde etter.
Mål tid per steg. Stopp og rapporter ved feilrate over 1 %.

## Del 5: kontroll (beviset)
1. **Alle produkter:** felt-for-felt-sammenligning. Forventet: bøker har ny standard; beskyttede, ikke-bøker og produkter uten ISBN har **0 endringer** (også `updatedAt`).
2. **Standarden på alle bøker:** andel med `bok.isbn`, `bok.forfatter`, format, kategori, SEO-tittel ≤ 60, metabeskrivelse ≤ 155, alt-tekst, filnavn, ingen tittel-/forfattertagger, bkg-tagger. Alt under 100 % listes med årsak.
3. **Tagger:** antall unike tagger før og etter; ingen tagg fra sperrelistene fjernet; antall produkter i hver smarte samling før og etter (ingen skal miste produkter de skal ha).
4. **Videresendinger:** alle gamle adresser gir 301 til riktig produkt (stikkprøve 500 + alle duplikater).
5. **Stikkprøve for øyet:** 100 tilfeldige bøker + 50 utvalgte (to forfattere, uten forlagstekst, kommende, utsolgt med lager, engelsk, lydbok, serie) i en tabell Eirik kan gå gjennom.
6. **Nettbutikken:** 20 produktsider, søk på tittel/forfatter/ISBN, og at bøker finnes i alle salgskanaler.
7. **Tid:** samlet tid og anslag for overgangsdagen.

## Del 6: import og eksport fra Bokadmin (nest viktigst)
Test på den store katalogen:
1. **CSV-opplasting** av 50 ISBN (blanding: nye bøker, bøker som finnes, bok uten pris, beskyttet bok, ikke-bok med ISBN) → import fra Bokbasen → eksport til Shopify. Forventet: nye opprettes med ny standard, eksisterende oppdateres uten duplikat, uten pris blir utkast, beskyttet og ikke-bok røres ikke.
2. **ISBN lagt inn i arbeidslista** (20 stk.) → «Push alle». Samme forventning.
3. **CSV-eksporten** fra Bokadmin: importer den i Testbutikk og kontroller at den gir samme resultat som push.

## Lavere prioritet
- Strømmer: test opprette, legge til, fjerne, sortere, slette, og bytt de to utfasede kallene.
- Shopifykatalog-siden: ingen videre arbeid.
