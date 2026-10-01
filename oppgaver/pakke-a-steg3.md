# Oppgave til Claude Code: steg 3 i Bokadmin 2.0 (pakke A)

Skrevet i Cowork 01.10.2026. Denne fila er oppgaven. Følg den i rekkefølge, og spør Eirik hvis noe er uklart eller ser ut til å treffe live-systemet.

Du jobber i C:\Bokadmin 2.0 (repo Raspaball/bokadmin2, Supabase «Bokadmin 2.0», ref chwpqwblqummlufqdefe, Shopify: bare testbutikk-9434.myshopify.com).

## Sikkerhet
- Ikke rør live-systemet. Det betyr C:\Bokadmin, repoet Raspaball/bokadmin, Supabase-live-prosjektet (ref i C:\Bokadmin\.env), Vercel-prosjektet «bokadmin» og livebutikken. Du kan lese C:\Bokadmin for å sammenligne.
- Du er den eneste som gjør Supabase-endringer mens denne oppgaven pågår. Si fra før du deployer Edge Functions.
- Migrasjoner skal bare legge til. Aldri rediger en migrasjon som allerede er kjørt. Legg aldri hemmeligheter i git.
- Valider alle nye eller endrede GraphQL-spørringer mot Admin API 2026-07 før du bruker dem.
- Gjør én commit per del, og kjør `node --test scripts/` før hver commit.

## Del 1: gjør bok.isbn om til typen `id` (bare i Testbutikk)
Mål: `productByIdentifier(identifier: { customId: { namespace: "bok", key: "isbn", value } })` skal fungere.
1. Tell hvor mange produkter som har bok.isbn. Ta vare på verdiene i `scripts/out/` (ikke i git).
2. Slett definisjonen bok.isbn og lag den på nytt med typen `id`, samme navn og nøkkel, og med samme tilgang for storefront.
3. Sett verdiene inn igjen, hentet fra barcode eller SKU (eksakt ISBN-13, validert med `normalizeIsbn`).
4. Snu oppslagsrekkefølgen i eksporten og migreringen: først shopify_id, så customId bok.isbn, så barcode/SKU, så handle. Behold de andre som reserve.
5. Test med en bok som har fått ny handle og en som ikke har det. Oppdater BOKADMIN2_OPPSETT.md.

## Del 2: Shopify-katalogsiden: FERDIG
Gjort 30.09 (commit f3e4563). Hopp over.

## Del 3: statusfilter
Finn alle `products(query: ...)`-spørringer i `sjangre-sync`, `shopify` (analyse, handles, katalog) og i skriptene. Der meningen er å treffe hele katalogen, legg til `status:active OR status:draft OR status:archived`. List opp hvilke du endret og hvilke du bevisst lot være.

## Del 4: én Bokbasen-innlogging
I dag finnes det fem kopier av innloggingen, i `bokbasen`, `shopify`, `price-update`, `availability-check` og `sjangre-sync`. Alle bruker nå `auth.bokbasen.io` (sjangre-sync ble rettet 30.09).
1. Lag `_shared/bokbasen-auth.ts` med én funksjon som henter token, cacher det til det nesten er utløpt, og leser legitimasjon på samme måte som i dag.
2. Bytt alle funksjonene over til den delte modulen. Oppførselen skal ellers være uendret.

## Del 5: bokgruppekode, skjema 37 eller 23
Alle tre (`bokbasen`, `shopify`, `sjangre-sync`) leser nå `SubjectSchemeIdentifier 37`. Det er ikke kontrollert mot rådata.
1. Hent rå ONIX-XML fra Bokbasen for 5–10 bøker av ulike typer (skjønnlitteratur, sakprosa, barn, tegneserie og en eldre tittel). Noter hvilke skjemaer som finnes og hvilke koder de har.
2. Sjekk hva de to skjemaene betyr i ONIX-kodelisten (List 27), og hvilket som gir de tre sifrene som bkg-taggene og smarte samlinger bruker.
3. Samle lesingen i én funksjon i `_shared`, som brukes av alle tre. Legg til reserve til 23 bare hvis dataene viser at det trengs.
4. Legg ved en kort tabell med funnene i BOKADMIN2_OPPSETT.md. Ikke endre bkg-tagger i Testbutikk før jeg har sett funnene.

## Del 6: prisregelen, først flyttet uendret (som i gamle Bokadmin)
Gamle Bokadmin har to regler, og 2.0 har i dag nøyaktig de samme:
- **Import** (`bokbasen/index.ts`, ca. linje 366): første Price med PriceType 01 eller 02 vinner. Finnes ingen slik, brukes første beløp som finnes.
- **Prisjobben** (`price-update/index.ts`): prioriteten er 04 > 03 > 02 > 01 > andre typer. Priser på 0 eller lavere avvises, og avvik under 0,01 kr regnes som ingen endring.

Det du skal gjøre:
1. Ikke endre hvilken pris som velges. Flytt begge reglene uendret til `_shared/price.ts` som to navngitte funksjoner, `pickImportPrice` og `pickPriceUpdatePrice`, med en kommentar om at de speiler gamle Bokadmin.
2. Skriv tester i `scripts/` med ONIX-utdrag som dekker: bare 01, både 02 og 04 med ulike beløp, bare 03, ingen type, og beløp 0.
3. Kjør den gamle og den nye koden på de samme 10 ekte ISBN-ene fra Bokbasen (bare lesing) og vis at de gir samme pris.

## Del 7: importen bruker fastprisregelen
Bokadmin 2.0 skal ha én prisregel. Importen skal velge pris som prisjobben. Det er et bevisst avvik fra gamle Bokadmin, der importen bruker veiledende pris (01/02). Livebutikken ender uansett på fastprisen når prisjobben har vært innom.
1. La importen og alt annet som leser pris fra ONIX bruke `pickPriceUpdatePrice` (04 > 03 > 02 > 01 > andre).
2. Behold vaktene: ingen pris gir `null`, beløp på 0 eller lavere godtas ikke. Behold dagens oppførsel når en bok mangler pris.
3. Fjern `pickImportPrice` når ingen bruker den. Oppdater testene slik at import og prisjobb gir samme pris i alle tilfellene, også når 02 og 04 har ulike beløp.
4. Bekreft at produktopprettelse, eksport og CSV nå får fastprisen.

## Del 8: valuta og gyldighetsdato
Prioriteten er uendret, men prisvalget i `_shared/price.ts` skal også sjekke valuta, territorium og dato.
1. **Se på rådata først.** Hent rå ONIX for 10–15 bøker (bare lesing): nye, forhåndsbestillinger og eldre bøker der fastprisperioden er over. Noter om `CurrencyCode` står i hver `Price` eller bare som `DefaultCurrencyCode` i headeren, om datoene står som `PriceEffectiveFrom`/`PriceEffectiveUntil` (ONIX 2.1) eller `PriceDate` med `PriceDateRole` 14/15 (ONIX 3), og om `Territory` eller `CountriesIncluded` finnes. Legg en kort tabell i BOKADMIN2_OPPSETT.md.
2. **Valuta:** bare NOK. Mangler `CurrencyCode`, bruk `DefaultCurrencyCode`. Mangler begge, regn prisen som NOK.
3. **Territorium:** står det et territorium, godta prisen bare hvis Norge (NO) er med.
4. **Dato:** bare priser som gjelder i dag (Europe/Oslo). Pris uten datoer gjelder alltid.
5. **Valg:** blant godkjente priser velges etter type. Ved flere av samme type vinner nyest startdato. Ingen godkjent pris gir `null`: prisen endres ikke, og årsaken logges («ingen NOK-pris», «ingen gyldig pris i dag»). Aldri annen valuta som reserve.
6. **Tester** for: NOK og EUR med samme type, bare EUR, `DefaultCurrencyCode` i headeren, 04 fra i morgen mot 02 nå (02 vinner), 04 utløpt i går mot 01 uten datoer (01 vinner), to 04 med ulike startdatoer, territorium uten NO, ingen godkjent pris. Både ONIX 2.1 og 3.
7. **Kontroll:** kjør prisjobben i sjekkmodus (uten oppdatering) på Testbutikk. Rapporter hvor mange som ville fått ny pris, med eksempler og grunn.
8. Dokumenter regelen i BOKADMIN2_OPPSETT.md, og skriv at den er strengere enn i gamle Bokadmin med vilje.

## Til slutt
Ikke endre priser i Testbutikk automatisk. Si fra, deploy de endrede funksjonene til 2.0 og kjør en rask røyktest fra bokadmin2.vercel.app: import av én bok, sjangersynk på én bok og kataloglisten. Rapporter kort per del hva som ble gjort, hva som ble testet, hva som gjenstår og commit-hash.
