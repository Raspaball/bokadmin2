# Pakke I del B: sjekkliste og forberedelser for live (07.10.2026)

Bare skrevet og testet mot Testbutikk. Ingenting er kjørt mot live, ingen deploy er gjort, ingen hemmeligheter er endret. Repoet er offentlig: ingen live-domener, nøkler eller ISBN-lister fra live i denne filen eller i git (bruk `scripts/.env.local` og `scripts/data/`, begge git-ignorert).

Åpne spørsmål til Eirik er samlet nederst.

---

## 1. Appens tilganger i live og hva hver brukes til

Slik er appen «Bokadmin 2.0» konfigurert i Testbutikk (lest med `currentAppInstallation.accessScopes` 07.10.2026). Live trenger de samme, minus de som ikke brukes.

| Tilgang | Brukes til | Hvor |
|---|---|---|
| `read_products`, `write_products` | Alt: opprette og oppdatere bøker (`productCreate`, `productUpdate`), varianter og pris (`productVariantsBulkUpdate`), metafelt (`metafieldsSet`, `metafieldsDelete`), tagger (`tagsAdd`), samlinger (`collectionCreate/Update/Delete`), les for alle jobber og bulk-spørringer | push, book-update, price-update, availability-check, sjangre-sync, samlinger, feeder |
| `read_inventory`, `write_inventory` | Slå av «Spor beholdning» (`inventoryItem.tracked`), lagerpolicy (CONTINUE/DENY), vekt og SKU på `InventoryItem` | availability-check, push |
| `read_locations` | Følger med lager (Shopify krever den for lagernivå); brukes ikke direkte av koden | (indirekte) |
| `read_publications`, `write_publications` | Finne alle salgskanaler og publisere aktive bøker (`publishablePublish`) | push, availability-check, book-update |
| `read_online_store_navigation`, `write_online_store_navigation` | Videresendinger (`urlRedirectCreate/Update/Delete`, også ved handle-migrering og arkiverte bøker) og megameny (`menuUpdate`) | availability-check, handle-migrering, build-menu |
| `read_files`, `write_files` | Alt-tekst og filnavn på omslag (`fileUpdate`) | push, book-update |
| `read/write_metaobject_definitions`, `read/write_metaobjects` | **Ikke brukt av koden.** Står i Testbutikk-appen (trolig for «Notat av»). Utelates i live hvis butikken ikke trenger det via appen | (ingen) |

Merknader:
- Appen bruker client credentials (ingen `shpat_`-nøkkel). Det fungerer bare hvis livebutikken er i **samme Shopify-organisasjon** som Dev Dashboard-appen og appen er installert der. Ellers må en annen løsning velges (se spørsmål 1).
- Minste mulige: dropp metaobject-tilgangene i live. Legg dem til senere om nødvendig.
- Ingen tilgang til kunder, bestillinger eller betaling, og den skal ikke ha det.

## 2. Metafeltdefinisjoner (skript, testet)

`scripts/lag-metafelt-definisjoner.mjs` lager det som mangler av 15 definisjoner: `bok.isbn` (type `id`, unik), `bok.forfatter`, `format`, `sider`, `utgivelsesaar`, `spraak`, `serie`, `alder`, `thema`, `tilgjengelighet` (med verdiliste), `utgivelsesdato`, `bokgruppe`, `egen_pris`, `egen_tilgjengelighet` og `bokadmin.seo_auto` (json). Innstillinger (festing, storefront-tilgang, filter, samlingsregel, unikhet) er kopiert fra Testbutikk.

- Lager bare det som mangler. Endrer og sletter aldri noe eksisterende.
- Har en eksisterende definisjon feil type (typisk `bok.isbn` som tekst i live), stopper skriptet for den og peker på `scripts/isbn-definition.mjs` (egen prosedyre med sikkerhetskopi). Der trengs en egen avtale først.
- Testet i Testbutikk: `--prove` lager alle 15 i et midlertidig navnerom, leser dem tilbake, sammenligner type, festing, tilgang, filter, unikhet og validering, og sletter dem. 15 av 15 ok, ingenting igjen i butikken.
- `bok.notat` og `bok.notat_av` (Bokhandlerens notat) er butikkens egne og lages ikke her.

```
node scripts/lag-metafelt-definisjoner.mjs                         # Testbutikk: status
node scripts/lag-metafelt-definisjoner.mjs --prove                 # Testbutikk: prøv uten å røre de ekte
node scripts/lag-metafelt-definisjoner.mjs --live --bekreft-butikk <hele domenet>            # live: bare status
node scripts/lag-metafelt-definisjoner.mjs --live --bekreft-butikk <hele domenet> --create   # live: lag det som mangler
```
Eirik kjører live-kommandoene selv, først uten `--create`.

## 3. Eksport og sikkerhetskopi fra live (bare lesing, skript, testet)

`scripts/live-eksport.mjs`: alle produkter (aktive, utkast, arkiverte) med handle, tittel, SEO, status, produkttype, leverandør, tagger, beskrivelse, kategori, varianter (pris, strekkode, SKU, lagerpolicy), **alle** metafelt, bilder med alt-tekst og antall salgskanaler; alle samlinger med regler og produkter; alle videresendinger; metafeltdefinisjoner, salgskanaler, menyer og butikkinfo. `manifest.json` har sha256 per fil og kontrollerer antall mot butikkens egne tellinger. Lagres i `scripts/data/` (git-ignorert, aldri i git).

- Bare lesing: klienten avviser alle mutasjoner i live bortsett fra `bulkOperationRunQuery` (som bare leser).
- Testet mot Testbutikk 07.10.2026: 9 059 produkter, 126 465 metafelt, 165 samlinger, 8 542 videresendinger, 3 salgskanaler. Kontroll 9059/9059 og 165/165. Tid: ca. 2,5 minutter. Live (ca. 17 000 produkter) anslått ca. 5–6 minutter.
- Samme filformat som `scripts/snapshot.mjs`, så `scripts/snapshot-diff.mjs` (før/etter, beskyttede) fungerer på live-eksporten. Spørringene ligger nå i `scripts/lib/snapshot-queries.mjs` og deles av begge.

```
node scripts/live-eksport.mjs --live --bekreft-butikk <hele domenet> --name foer-pilot
```
Behold minst tre eksporter: `foer-pilot`, `foer-overgang`, og en daglig i første uke.

### Plan for tilbakerulling

`scripts/live-tilbakerull.mjs <foer-mappe> <etter-mappe>` leser to eksporter lokalt og lager en plan uten noen API-kall (testet med tre enhetstester og på Testbutikk-eksporten: to like eksporter gir tom plan). Resultat i `scripts/data/tilbakerulling-<tid>/`:

| Fil | Innhold | Hvordan rulles det tilbake |
|---|---|---|
| `endringer.csv` | Alle felt som er endret, før og etter | Les gjennom først |
| `gjenopprett-produkter.jsonl` | Tittel, status, leverandør, type, tagger, beskrivelse, SEO, kategori og metafelt som skal settes tilbake (bare endrede felt) | `bulkOperationRunMutation` med `productUpdate` (`startBulkMutation()` i `_shared/shopify-bulk.ts`) |
| `gjenopprett-metafelt-slett.jsonl` | Metafelt som ikke fantes før | `metafieldsDelete` |
| `gjenopprett-varianter.jsonl` | Pris, sammenligningspris, lagerpolicy | `productVariantsBulkUpdate` per produkt |
| `gjenopprett-bilder-alt.jsonl` | Alt-tekst | `fileUpdate` |
| `gjenopprett-handle.csv` | Endrede handles (ikke med i produktfilen) | `/shopify/handles/rollback` (sletter videresendingen fra gammel handle først), ikke `productUpdate`, ellers kan en videresendingssløyfe oppstå |
| `nye-produkter.csv` | Produkter som ikke fantes før | Eirik avgjør. Slettes aldri automatisk. Vanlig valg: sett til DRAFT/ARCHIVED |
| `slettede-produkter.csv` | Produkter som er borte | Lages på nytt fra `products.jsonl` i før-eksporten |
| `redirects-nye.csv`, `redirects-borte.csv`, `samlinger.csv` | Videresendinger og samlinger som er lagt til eller borte | `urlRedirectDelete/Create`, samlingsregler for hånd |

**Status for tilbakerulling:** planleggeren er laget og testet. **Utførelsestrinnet (som sender mutasjonene) er ikke laget**, med vilje: det skal skrives og godkjennes av Eirik og Cowork først, og må bruke live-sperren i punkt 4. Det er raskt å lage fordi formatet i filene er `productUpdate`-input. Tilbakerulling per nivå:

1. **Én bok feil:** sett boka tilbake for hånd i Shopify admin med verdiene fra `endringer.csv`.
2. **Pilot (50 bøker) feil:** kjør planen mellom `foer-pilot` og en ny eksport for de 50.
3. **Hele overgangen:** stans alle jobber, steng live-vinduet (punkt 4), eksporter nå-tilstanden, lag plan mot `foer-overgang`, gå gjennom og kjør utførelsestrinnet. For vanlige feil er dette mye bedre enn Shopifys egen historikk, som ikke har angre for masseendringer.
4. **Siste utvei:** Shopify-butikken har ingen databaserestore. Derfor: ta eksport og eventuelt Shopify CSV-eksport rett før overgangen.

Det som ikke kan rulles tilbake fra en eksport: kundenes bestillinger og lagerantall som endres av salg, tema og apper. Bokadmin endrer aldri lagerantall.

## 4. Kobling til livebutikken og sperre mot feil

### Sperren (laget og testet, ikke deployet)

Regelen står i `supabase/functions/_shared/shop-guard.js` (8 tester, `scripts/shop-guard.test.mjs`) og brukes av `_shared/shopify.ts` før hvert token- og GraphQL-kall. Dermed går alle jobber (push, pris, tilgjengelighet, bokdata, sjangre, samlinger, feeder, handle-migrering, bulk) gjennom samme sperre, også en jobb som gjenopptas av pg_cron.

- **Testbutikk** (`testbutikk-9434.myshopify.com`) er alltid tillatt.
- **Enhver annen butikk** (live) er tillatt bare når to hemmeligheter er satt bevisst:
  - `LIVE_SHOP_CONFIRMED` = hele butikkdomenet, lik `SHOPIFY_SHOP_DOMAIN` (bekreftelsen: Eirik må skrive domenet selv)
  - `LIVE_SHOP_UNTIL` = tidspunkt (ISO 8601) fram i tid, **høyst 24 timer unna**
- Mangler noen av dem, eller har tiden gått ut, kaster hvert Shopify-kall «Shopify-sperre: …» og jobbene settes til `failed`/stopper. Vinduet lukker seg selv: glemmer vi å skru av, stopper alt senest etter 24 timer.
- Bytter noen `SHOPIFY_SHOP_DOMAIN` til live ved en feil (uten de to hemmelighetene), stopper alt umiddelbart. Også «Test tilkobling» i Innstillinger gir sperremeldingen.
- Handle-migrering har sin egen sperre (`ALLOW_HANDLE_MIGRATION=true`) i tillegg. Den er uendret.

Lokale skript: `SHOPIFY_*` i `scripts/.env.local` peker alltid på Testbutikk, og alle eksisterende skript stopper hvis domenet ikke er Testbutikk. Live har egne variabler (`LIVE_SHOPIFY_SHOP_DOMAIN` og `LIVE_SHOPIFY_ACCESS_TOKEN` eller `LIVE_SHOPIFY_CLIENT_ID`/`_CLIENT_SECRET`) og krever **både** `--live` **og** `--bekreft-butikk <hele domenet>`. I live avviser klienten alle mutasjoner som skriptet ikke har navngitt (eksport: ingen; definisjoner: bare `metafieldDefinitionCreate`).

### Hva sperren IKKE gjør (ærlig)
- Den stopper ikke en jobb som allerede kjører mot Testbutikk når hemmelighetene byttes: jobben fortsetter da mot det nye domenet (og stopper, hvis vinduet ikke er åpent). **Derfor skal det ikke finnes aktive jobber ved bytte** (sjekkliste under).
- Jobbradene lagrer ikke butikkdomenet. Et ekstra, valgfritt tiltak er å stemple `config.shopDomain` ved start og sjekke det ved hver puls i de fire jobbene (ca. en times arbeid og en deploy). Anbefales før overgangsdagen, ikke før piloten.
- `books.shopify_id` og `price_approvals`, `jobs`, `sync_log` i Supabase 2.0 inneholder Testbutikk-data. Tøm arbeidslista (`books`, «Tøm liste») og ventende `price_approvals` før piloten, så ingen Testbutikk-ID-er slår opp i live.

### Slik kobles 2.0 til live (når Eirik bestemmer det)
Bokadmin 2.0 bruker Supabase-prosjektet «Bokadmin 2.0» (`--project-ref` fra CLAUDE.md). Butikken byttes bare med hemmeligheter, ingen kodeendring:

```
supabase secrets set SHOPIFY_SHOP_DOMAIN=<live> SHOPIFY_CLIENT_ID=<live-app> SHOPIFY_CLIENT_SECRET=<live-app> LIVE_SHOP_CONFIRMED=<live> LIVE_SHOP_UNTIL=<nå + 6 t, ISO> --project-ref chwpqwblqummlufqdefe
```
Sperren må være deployet først (`shopify`, `price-update`, `availability-check`, `book-update`, `sjangre-sync`, `bokbasen` bruker alle `_shared/shopify.ts`). Lukk igjen: `supabase secrets unset LIVE_SHOP_CONFIRMED LIVE_SHOP_UNTIL --project-ref chwpqwblqummlufqdefe`, og sett `SHOPIFY_*` tilbake til Testbutikk når økta er over. Bekreft hver gang med «Test tilkobling» (viser butikknavn og produktantall) at riktig butikk svarer, før noe annet kjøres.

## 5. Oppskrift: pilot på 50 bøker og overgangsdagen

Tidsanslagene bygger på målinger i Testbutikk (9 059 produkter) og er ca. 2× for live (ca. 17 000). Tid for Eirik/Cowork er med.

### Før pilotdagen (dagen før, ca. 2–3 t)
1. Bestem koblingen (spørsmål 1) og installer appen i live med tilgangene i punkt 1. (30–60 min)
2. Legg `LIVE_SHOPIFY_*` i `scripts/.env.local`. (5 min)
3. Deploy sperren til 2.0 (si fra først; jeg deployer funksjonene). Kjør alle tester. (15 min)
4. Velg 50 piloter: 10 vanlige norske, 10 flerforfatter/skolebøker, 5 utenlandske, 5 med institusjon som forfatter, 5 uten forlagstekst, 5 «kommer», 5 midlertidig utsolgt/utgått, 5 med egen pris (`bok.egen_pris`) eller tilbud. **Ingen beskyttede** (gave, lokal, lokalhistorie, lokallitteratur, Wrendale). ISBN-lista legges i `scripts/data/pilot-isbn.txt`. (30 min)
5. Gammel Bokadmin kjører videre uendret. Piloten endrer bare de 50.

### Pilotdagen (ca. 3–4 t, hvorav ca. 1 t venting på Cowork)
| # | Steg | Tid |
|---|---|---|
| 1 | Sjekk at ingen jobber kjører i 2.0 (`jobs`: ingen `running`/`paused`). Skru av pg_cron `resume-paused-*` og `run-scheduled-tasks` (`cron.alter_job(jobid, active := false)`). Tøm `books` og ventende `price_approvals` | 10 min |
| 2 | `live-eksport.mjs --live … --name foer-pilot`. Kontroll: antall OK | 6 min |
| 3 | Definisjoner: status, så `--create` (bare det som mangler). Er `bok.isbn` feil type: **stopp**, egen avtale | 5 min |
| 4 | Åpne vinduet: sett `SHOPIFY_*` til live og `LIVE_SHOP_CONFIRMED`, `LIVE_SHOP_UNTIL` (+6 t). «Test tilkobling» viser riktig butikk | 5 min |
| 5 | Importer de 50 (Bokbasen-oppslag) og push med vanlig push. Eksisterende bok oppdateres uten duplikat (oppslag på `bok.isbn`/strekkode) | 15 min |
| 6 | `book-update` med `isbns` (50): først `analyze`, les resultatet, så `update` | 10 min |
| 7 | Kontroll med `scripts/pakke-i/kontroll.mjs` (tilpasset live-lesing): handle, SEO, alt-tekst, metafelt, tagger, status, kanaler, pris. Sjekk i butikken: søk, samling, bokside | 30 min |
| 8 | Lukk vinduet (`secrets unset`) og sett `SHOPIFY_*` tilbake til Testbutikk | 5 min |
| 9 | `live-eksport.mjs … --name etter-pilot`, `live-tilbakerull.mjs foer etter`, `snapshot-diff.mjs`. Bare de 50 skal ha endringer; 0 på beskyttede og andre | 15 min |
| 10 | Cowork gjennomgår rapporten. Beslutning: gå videre, rette, eller rulle tilbake de 50 | 30–60 min |

Merk: `price-update` og `availability-check` har ikke ISBN-filter. For piloten setter push pris og status per bok, og tilgjengelighet og pris for resten kjøres først i analysemodus på overgangsdagen.

### Overgangsdagen (ca. 8–10 t, helst en rolig dag; butikken kan være åpen)
Forutsetning: piloten godkjent, ekstra tiltak (jobb-stempel) deployet, handle-migrering avtalt (spørsmål 3).

| # | Steg | Tid |
|---|---|---|
| 1 | Stans gammel Bokadmin (cron, planlagte oppgaver, jobber). Bekreft at den er stille. 2.0 tar over | 20 min |
| 2 | Sjekk at ingen jobber kjører i 2.0. pg_cron av. Tøm `books`, `price_approvals` | 10 min |
| 3 | `live-eksport.mjs … --name foer-overgang`. Ta også Shopify CSV-eksport fra admin som ekstra kopi | 10 min |
| 4 | Åpne vinduet (+12 t). «Test tilkobling» | 5 min |
| 5 | Definisjoner (ferdig fra pilot, kontroller) | 5 min |
| 6 | `book-update` hele katalogen, `analyze` (bulk). Cowork leser rapporten (0 beskyttede, 0 «manuelt endret» overskrevet, feil per årsak) | 1–1,5 t + 30 min |
| 7 | `book-update` `update` (bulk). Testbutikk-målingen var 53 min for 9 050 med eldre kode, anslått ca. 1,5–2 t | 2 t |
| 8 | `availability-check` `analyze`, så `update` (bulk, statusrapport). Les statusendringer (særlig 41/47/48 → ARCHIVED med videresending) | 1–1,5 t |
| 9 | `sjangre-sync` (bkg-tagger, samlinger, samlingsnavn). Eksisterende samlinger omdøpes ikke | 1 t |
| 10 | `price-update` `analyze`, les hoppene over grensen (`price_approvals`), så `update` | 1 t |
| 11 | Handle-migrering (hvis avtalt): `analyze`, deretter `migrate` i bulk, `verify`, rollback-test på én | 1–2 t |
| 12 | Salgskanaler og samlinger kontrolleres (`scripts/kanaler-rapport.mjs`). Kontroll av beskyttede: `scripts/kontroll-beskyttede.mjs` og `snapshot-diff.mjs` (0 endringer) | 30 min |
| 13 | Stikkprøve i butikken: 20 bøker (søk, kategori, bokside, kassa), mobil | 30 min |
| 14 | Lukk vinduet. `live-eksport.mjs … --name etter-overgang`. Cowork godkjenner | 30 min |
| 15 | Slå på pg_cron igjen. Planlagte oppgaver legges inn av Eirik (ukentlig tilgjengelighet, pris i analysemodus) | 15 min |

Stopp-regler: ved første uforklarte feil i steg 6–10 stanses jobben (`/cancel`), vinduet lukkes, og tilbakerullingsplanen lages mot `foer-overgang` før noe annet gjøres. «Ikke overvåk» gjelder ikke på overgangsdagen: Cowork leser rapporten mellom hvert steg.

## Åpne spørsmål til Eirik
1. **Kobling:** Er livebutikken i samme Shopify-organisasjon som Dev Dashboard-appen «Bokadmin 2.0»? Ellers må vi bruke en egen custom app/token for live (skriptene støtter `LIVE_SHOPIFY_ACCESS_TOKEN`, men Edge Functions støtter i dag bare client credentials, så det krever en liten kodeendring).
2. **Gammel Bokadmin:** Når skal den stenges? 2.0 setter nye handles; gammel Bokadmin slår opp på ISBN-handle (CLAUDE.md: «live tåler ikke nye handles» før 2.0 har overtatt).
3. **Handle-migrering:** Skal den tas på overgangsdagen eller senere?
4. **`bok.isbn` i live:** Er den tekst med verdier i dag? Da trengs prosedyren i `scripts/isbn-definition.mjs` (sletter og lager definisjonen på nytt), som er det eneste i denne planen med risiko, og må avtales for seg.
5. **Pilotens 50:** Skal jeg foreslå listen fra live-eksporten (etter at du har tatt den), eller velger du selv?
6. **Jobb-stempel** (butikkdomene i jobbraden, sjekket ved hver puls): lage før overgangsdagen?
