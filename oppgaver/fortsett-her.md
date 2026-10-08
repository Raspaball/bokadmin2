# Fortsett her (overlevering 08.10.2026, kl. 18.00)

**Gjeldende oppdrag: live-sjekk 1** (koble 2.0 til livebutikken, bare lesing og sjekkmodus). Framdrift og oppskrift for Del 3–6 står i `oppgaver/live-sjekk-1.md`. Les den først, og deretter CLAUDE.md.

## Kort status
- Del 1 (skrivesperre LIVE_READ_ONLY, butikkstempel `jobs.shop_domain`) og Del 2 (Innstillinger → Butikker, secret i Vault, regler for bytte i databasen) er ferdige, testet og deployet til 2.0 (08.10 kl. 17.41).
- Migrasjonene `20261007033904` og `20261008151207` er kjørt.
- Alt til og med 8abb2ee er på GitHub, og Vercel har bygget det.
- Del 3: profilen for livebutikken er lagret, og «Test tilkobling» virker (bare lesing). Live er ikke gjort aktiv.
- **Funn:** produkttellingen stopper på 10 000 (`productsCount` uten `limit: null`). Se `live-sjekk-1.md` («Funnet 08.10»). Må rettes før live-eksporten.
- Testbutikk er aktiv. Ingenting er skrevet til live. Ingen jobber kjører.

## Neste
1. Lagre i git og send til GitHub: `oppgaver/fortsett-her.md`, `live-sjekk-1.md`, `live-sjekk-1-oppdrag.md` og `pakke-h-mot-live.md`. Slett `scripts/out/live-sjekk.bundle`.
2. Rett produkttellingen (`limit: null`) i funksjonene og skriptene, kjør testene, og deploy etter ja.
3. Kjør én liten jobb i sjekkmodus mot Testbutikk (`shop_domain` skal bli satt).
4. Eirik tester live-tilkoblingen på nytt og sender tilgangene. Deretter Del 4 (live-eksport).

## Ikke gjør
- Ikke endre `SHOPIFY_*`-hemmelighetene for å koble til live. Bruk Innstillinger → Butikker.
- Ikke slå av skrivesperren (`shop_settings.read_only`, `LIVE_READ_ONLY`).
- Ingen deploy eller migrasjon uten ja fra Eirik.
- Ikke skriv live-domenet, nøkler eller ISBN-lister fra live i git (repoet er offentlig).
- Rør aldri gamle Bokadmin (`C:\Bokadmin`, Supabase `cvrnkeboqvhvfoxcdbbz`).

---

## Eldre overlevering (06.10.2026, pakke H, ferdig)

Skrevet i Cowork for en ny Claude Code-økt. Les også CLAUDE.md, BOKADMIN2_OPPSETT.md og `pakke-h-mot-live.md`.

## Gjort i pakke H (alt i Testbutikk og Supabase «Bokadmin 2.0», live ikke rørt)
- Del 1–4 committet: 3971398, 2ac461e, 7db1ebc, 9e46bfb, 60e5159. Mindre porsjoner med tidsbudsjett (CPU-grensen), alle salgskanaler, faktatekst for bøker uten forlagstekst («Tittel av Forfatter. Format, N sider, utgitt år.»), videresending for arkiverte bøker, kontroll av beskyttede på innhold (157 av 158 like; avviket er en manuell endring).
- Etterpå: 1bc48e4 (push publiserer bare «Bok»), 41ccb29 (ONIX 41, 47, 48 → ARCHIVED med videresending, Eirik 06.10), 8814d24 (`/resume-paused` i sjangre-sync + migrasjon 20261006120000).
- Deployet til 2.0: shopify, book-update, availability-check, sjangre-sync, price-update, bokbasen. Pushet til GitHub til 8814d24.
- Migrasjon 20261006120000 kjørt av Eirik i SQL Editor. Cowork bekreftet at de seks eldre lokale migrasjonene er kjørt. Alle sju registrert med `migration repair --status applied`. De fem som bare finnes i Supabase (20260929193439, 20260930024650, 20261001194029, 20261001225351, 20261001231758) er urørt; samme endringer med andre tidsstempler. Ikke bruk `supabase db push` før historikken er ryddet.

## Kjører nå (sjekkmodus, startet 06.10 ca. 11:02 UTC, tas videre av pg_cron hvert minutt)
- bokdata `56d35fa8-e2a5-44cf-8548-c21be7c3d983`
- tilgjengelighet `59f7a090-a4a5-4c22-9ec9-39bf40de40af`
- bokgrupper `fe786660-a3f2-4962-9550-a12b28704b24` (ca. 150 per minutt)
Jobbene kjører i Supabase og trenger ikke VS Code eller nettleser.

## Neste steg
1. Sjekk status på de tre jobbene (én gang, ikke overvåk). Er noen ikke ferdige: si fra og stopp.
2. Når alle er ferdige: én rapport til `scripts/out/` og et kort sammendrag:
   1. Status, tid, behandlet, endret, hoppet over (per årsak), feil.
   2. Om «CPU Time exceeded» har forekommet (spør Eirik/Cowork hvis du ikke kan lese loggen).
   3. Bokdata: antall per felt, og 10 eksempler før/etter for metabeskrivelse, SEO-tittel og faktatekst.
   4. Tilgjengelighet: statusendringer per ONIX-kode (særlig 41, 47, 48), videresendinger per måltype, antall som ville blitt publisert på flere kanaler.
   5. Bokgrupper: antall som får bkg-tagger, samlinger som lages eller får nytt navn.
   6. Bekreft 0 beskyttede som «ville endret».
3. Ingen oppdateringsmodus før Eirik sier ja etter at Cowork har kontrollert rapporten.

## Åpent (ikke gjør noe uten beskjed)
- Kvinnerolla og matkulturen og Den gode pølseboka mangler taggen `lokal` i Testbutikk. Eirik setter den selv.
- 36 beskyttede fra importfila finnes ikke i Testbutikk (importhull, ikke Bokadmin).
- Rydding av migrasjonshistorikken (de fem remote-only).
