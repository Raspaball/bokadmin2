# Fast regel: beskyttede produkter (gjelder alle pakker fra nå av)

Skrevet i Cowork 02.10.2026 etter beskjed fra Eirik, oppdatert samme dag. Denne regelen går foran alt annet i oppgavefilene.

## Regelen
Et produkt som har **minst én** av disse taggene er beskyttet:

- `gave`
- `lokal`
- `lokalhistorie`
- `lokallitteratur`

Bokadmin 2.0 skal **under ingen omstendigheter** endre noe ved et beskyttet produkt: ikke tittel, beskrivelse, handle, pris, status, tilgjengelighet, tagger, metafelt, SEO, kategori, productType, bilder eller videresendinger. Det gjelder push, oppdateringsjobben, handle-migreringen, prisjobben, tilgjengelighetssjekken, sjangersynken, taggryddingen, bulk-operasjoner og alle skript. Ingen innstilling, knapp eller parameter skal kunne overstyre dette.

## Bevisst unntak: strømmer (manuelle samlinger)
Siden «Strømmer» (Feeder) kan fortsatt legge beskyttede produkter inn i og ta dem ut av manuelle samlinger, og endre rekkefølgen. Det er en manuell handling som en person gjør for ett og ett produkt, og den endrer ikke selve produktet (verken felt, tagger, metafelt, bilder, handle eller videresendinger), bare hvilke manuelle samlinger det står i. Unntaket er bestemt av Eirik 02.10.2026. Det gjelder bare strømmene; alt annet i regelen står.

## Hvordan taggene sammenlignes
- **Hele taggen må være lik**, ikke en del av den. `oppgaver`, `gaveide`, `lokalkunnskap` eller `Lokallitteratur i Telemark` er **ikke** beskyttet.
- Store og små bokstaver og mellomrom før og etter teller ikke: `LOKALHISTORIE`, `Lokalhistorie` og ` lokalhistorie ` er beskyttet. (Shopify behandler tagger uten hensyn til store og små bokstaver.)

## Slik skal det bygges
1. **Én delt funksjon** `_shared/protected.ts` med `isProtected(tags: string[]): boolean` og listen over taggene. Listen ligger i koden (ikke i en innstilling som kan endres fra nettsiden).
2. **Alle steder som skriver til Shopify** sjekker produktets **nåværende tagger i Shopify** rett før de skriver, også i bulk (filtrer ut beskyttede produkter før JSONL-fila lages). Treff logges som «Hoppet over: beskyttet (tagg: <tagg>)».
3. **Nye produkter via push:** finnes produktet allerede og er beskyttet, gjøres ingenting. Push skal aldri legge til eller fjerne disse taggene.
4. **Taggene fjernes aldri** fra noe produkt, heller ikke av taggryddingen (selv om en tagg tilfeldigvis er lik en tittel- eller forfatterbit).
5. **Rapport:** hver jobb viser i sammendraget hvor mange produkter som ble hoppet over fordi de er beskyttet.
6. **Tester:** hver av de fire taggene i ulike skrivemåter er beskyttet; `oppgaver`, `gaveide` og `lokalkunnskap` er ikke beskyttet; et beskyttet produkt hoppes over i hver jobb og i bulk; taggryddingen fjerner aldri de fire taggene.

## Test i Testbutikk
Lag 4–6 testprodukter (med og uten ISBN) med taggene over i ulike skrivemåter, og ett med `oppgaver`. Kjør generalprøven (pakke D, del 4) og vis at de beskyttede er helt uendret (sammenlign alle felt før og etter), og at produktet med `oppgaver` ble behandlet som vanlig.

## Til orientering
I live styres samlingene «Gaveartikler» (83) og «Lokalhistorie» (63) av slike tagger. Rapporter hvilke av de beskyttede taggene som finnes i live-eksporten, og hvor mange produkter som har dem.

## Tillegg 02.10.2026: manuelle samlinger som er beskyttet
Den manuelle samlingen **«Wrendale Designs»** i live (57 produkter, «Diverse produkter fra Wrendale Designs by Hannah Dale», 7 kanaler) skal ikke røres under noen omstendigheter, verken samlingen eller produktene i den. Manuelle samlinger følger ikke med i produkteksporten, så tagg-regelen dekker den ikke.

1. **Produktene beskyttes på to måter (begge gjelder):**
   - **Leverandør:** produkter der `vendor` inneholder «wrendale» (uten hensyn til store og små bokstaver) er beskyttet. I live heter leverandøren «Wrendale Design ltd» (sett 02.10.2026). Kontroller i live-eksporten hvor mange som treffer, og rapporter avvik mot de 57 i samlingen.
   - **Medlemskap:** produkter i en manuell samling med handle på listen `PROTECTED_COLLECTION_HANDLES` i `_shared/protected.ts` (fast i koden: `wrendale`, bekreftet av Eirik 02.10.2026) er beskyttet. Lista over produkt-ID-er hentes ved start av hver jobb; finnes ikke samlingen, stopper jobben.
2. **Samlingen selv:** ingen funksjon i Bokadmin (sjangersynk, megameny, strømmer, opprydding) skal endre, sortere, legge til, fjerne eller slette produkter i en beskyttet samling, eller endre selve samlingen. **Unntaket for strømmer gjelder ikke beskyttede samlinger.** Strømmer-siden skal bare vise og endre samlinger Bokadmin selv har laget som strømmer.
3. **Test i Testbutikk:** lag en manuell samling med samme handle og noen produkter (minst ett med ISBN), og vis at verken samlingen eller produktene endres i generalprøven.
4. **Avklart av Eirik 02.10.2026:** bare disse tre samlingene skal beskyttes: «Wrendale Designs» (manuell, handle `wrendale`), «Gaveartikler» (smart, regel «Tag er lik gave») og «Lokalhistorie» (smart, taggene lokal, LOKALHISTORIE og tre til). Kontroll: tell produkter med de beskyttede taggene i live-eksporten og sammenlign med 83 og 63. Er tallet for Lokalhistorie lavere enn 63, finnes det en tagg i regelen som ikke er på lista. Stopp da og spør Eirik om de tre siste verdiene.
