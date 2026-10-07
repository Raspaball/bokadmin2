# Fortsett her (overlevering 07.10.2026, kl. 05.45)

**Gjeldende oppdrag: live-sjekk 1** (koble 2.0 til livebutikken, bare lesing og sjekkmodus). Oppdraget og framdriften står i `oppgaver/live-sjekk-1.md`. Les den først, sammen med CLAUDE.md og prosjektdokumentene `live-analyse-2026-10-07`, `plan-veien-til-live` og `oppgaver/pakke-i-del-b-live.md`.

## Kort status
- Del 1 ferdig: skrivesperre (LIVE_READ_ONLY) og butikkstempel på jobber (commit c3b324c, migrasjon 20261007033904 kjørt). **Ikke deployet.**
- Del 2: forslag til lagring av butikker gitt, venter på Eiriks svar på tre spørsmål (Vault, bare Eirik kan endre, dobbel lås).
- Ingen jobber kjører i 2.0. Live er ikke koblet til. Ingenting er skrevet til live.
- Lokale commits ikke pushet til GitHub (main er 3 foran origin).

## Ikke gjør
- Ikke sett `SHOPIFY_SHOP_DOMAIN` til live før sperrene er deployet.
- Ingen deploy eller migrasjon uten ja fra Eirik.
- Git i Cowork: sletting i mappa må være tillatt (git rydder egne låsefiler), ellers blir `.git/index.lock` liggende.

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
