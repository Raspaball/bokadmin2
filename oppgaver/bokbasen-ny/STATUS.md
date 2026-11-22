# Bokbasen ny: STATUS

Dette er den eneste statusfila for arbeidet «Bokbasen ny». Les den først i hver samtale.
Plan: prosjektdokumentet `plan-bokbasen-ny.md` (Eiriks beslutninger 16.11.2026).

## Supabase-nøkkelen

**Ledig.** (Ingen endrer Supabase nå. Claude Code leverte den tilbake 16.11.2026 etter trinn 0.)

Regel: bare én aktør endrer Supabase om gangen. Eirik er den eneste som gir nøkkelen videre.
Den som får den, skriver her: «Hos <hvem> siden <dato kl.>, for trinn N». Cowork/chat kjører bare SELECT.

## Fase nå

**Utkast 22.11.2026 (Eirik):** fanen «Bokbasen ny» er laget som et raskt utkast i 2.0 for å prøve listeoppslaget i praksis, selv om trinn 1–3 ikke er gjort og nybyggingen ellers skjer i Bokadmin 3. Se loggen nederst. Ikke deployet, ikke lagt i git.

**Fase 1: bare tester mot Bokbasen (bare lesing).** Utviklingsbutikken og livebutikken venter.
Ingen ny kode skriver til Shopify. Dagens drift mot live fortsetter som før, styrt av Eirik.

## Status kontrollert 16.11.2026 kl. 05.40 (bare lesing)

| Hva | Funn | Kilde |
|---|---|---|
| Gren og siste commit | `main`, e131614 (20.10.2026) | [Kode] |
| Ikke lagret i git | `supabase/migrations/20261022070000_index_book_id_fks.sql` og `20261112060000_rydd_cron_logg.sql`. Begge er alt kjørt i Supabase (indeksene og klokkejobben finnes) | [Kode] [DB] |
| Databasestørrelse | 392 MB av 500 MB | [DB] |
| Største tabeller | `sync_log` 219 MB, `onix_cache` 90 MB, klokkeloggen 59 MB, `jobs` 5 MB | [DB] |
| Jobber som kjører | Ingen (90 ferdige, 11 feilet, 0 kjører eller venter) | [DB] |
| Planlagte oppgaver | 0 påslått | [DB] |
| Klokkejobber (pg_cron) | 6 hvert minutt (gjenopptak) + `rydd-cron-logg` hver natt | [DB] |
| `sync_log` | 378 257 rader, siste rad 09.11.2026 | [DB] |
| Bokbasen-adresser i koden | Alt bruker v2: `_shared/bokbasen-auth.ts` (konstanten), 5 steder i `bokbasen/index.ts`, 1 i `scripts/lib/clients.mjs` | [Kode] |

`sync_log` per handling (alle radene som foreslås slettet er eldre enn 30 dager):

| Handling | Rader | Trinn 0 |
|---|---|---|
| `book_update` | 112 846 | slettes |
| `sjangre_sync` | 61 659 | slettes |
| `update` | 49 720 | slettes |
| `availability_update` | 44 483 | slettes |
| `availability_check` | 27 915 | slettes |
| `handle_migrate` | 41 839 | beholdes (angre) |
| `tag_cleanup` | 34 338 | beholdes (angre) |
| `publish_online_store` | 3 115 | beholdes |
| `push` | 1 761 | beholdes |
| `import_failed` / `import_skipped` | 440 / 101 | beholdes |
| `handle_rollback` | 39 | beholdes |
| `bygg_meny` | 1 | beholdes |
| **Sum** | **296 623 slettes, 81 634 beholdes** | |

## Trinnene

| # | Trinn | Oppdrag | Status |
|---|---|---|---|
| 0 | Opprydding (kopi, rydd `sync_log`, nattlig rydding, repo) | `trinn-0-opprydding.md` | **Ferdig 16.11.2026** (rapport: `trinn-0-rapport.md`). Gren `bokbasen-ny/trinn-0` venter på Eiriks ja til sammenslåing |
| 1 | v3 i dagens kode, test 25 ISBN v2 mot v3 (50 oppslag) | `trinn-1-v3.md` | Oppdrag skrevet. Venter på Eiriks ja |
| 2 | Måling og tester mot listeoppslaget (bare lesing) | `trinn-2-maaling.md` | Oppdrag skrevet. Venter på Eiriks ja |
| 3 | Lager + henter + `shop_isbns` + bokmerke | – | Ikke startet. Starter ikke før trinn 2 har svart på om lista gir hele katalogen |
| 4 | Fanen «Bokbasen ny» v1 | – | Ikke startet |
| 5 | Skyggedrift 2 uker | – | Ikke startet |
| 6 | «Bokbasen ny» v2: eksport (utviklingsbutikken først) | – | Ikke startet |
| 7 | Jobbene leser lageret | – | Ikke startet |
| 8 | Steng gamle fanen, fjern enkeltoppslag | – | Ikke startet |

## Neste trinn

1. Eirik leser de tre oppdragene og svarer på spørsmålene i chatten.
2. ~~Trinn 0~~ ferdig 16.11.2026. Gjenstår: Eiriks ja til sammenslåing av `bokbasen-ny/trinn-0` til `main`, og å slette den midlertidige Supabase-nøkkelen.
3. Trinn 1, deretter trinn 2. Ett trinn om gangen (Eirik 16.11.2026): trinn 2 bruker tolkeren og adressen fra trinn 1.
4. Etter hvert trinn: en ny Claude-samtale kontrollerer, så Eiriks ja, så oppdateres denne fila.

## Faste regler for dette arbeidet (kort)

- Gamle Bokadmin røres aldri (`C:\Bokadmin`, Raspaball/bokadmin, Supabase cvrnkeboqvhvfoxcdbbz, Vercel «bokadmin»).
- Bokbasen: bare lesing. Enkeltoppslag bare til stikkprøver, høyst ca. 50 per testrunde. Aldri i selve systemet.
- Ingen deploy, migrasjon, klokkejobb eller sammenslåing til `main` uten Eiriks ja. Vercel bygger `main` automatisk.
- Ingen deploy eller endring i databasen mens en jobb kjører.
- Endringer i databasen: fil i repoet først. Bare tillegg. Ikke `supabase db push`.
- Repoet er offentlig: ingen nøkler, ISBN-lister eller rå ONIX i git. Slikt ligger i `scripts/out/` (ikke i git) eller `C:\Bokadmin-backup`.
- Felles regler i `supabase/functions/_shared/` gjenbrukes, ikke kopieres.

## Logg

| Dato | Hva | Hvem |
|---|---|---|
| 16.11.2026 | Status kontrollert (bare lesing). STATUS og oppdrag for trinn 0, 1 og 2 skrevet. Ingenting endret i kode, Supabase eller Shopify | Cowork (Claude) |
| 16.11.2026 | Eirik: 25 ISBN i trinn 1 (50 oppslag). Prisjobbens logg slettes i trinn 0. Trinnene går etter hverandre: 0, 1, 2 | Eirik |
| 16.11.2026 | Trinn 0: kopi av `sync_log` (378 257 rader) og 7 små tabeller i `C:\Bokadmin-backup\2026-11-16\`, kontroll grønn. 296 623 rader slettet, `VACUUM FULL`: `sync_log` 219 → 22 MB, databasen 393 → 196 MB. Klokkejobb `rydd-sync-log` (02:47 UTC, 90 dager). Migrasjonene i git | Claude Code |
| 22.11.2026 | Utkast: ny funksjon `bokbasen-ny/` (listeoppslag v3, én bunke per kall, lagrer ingenting), ny side `BokbasenNy.tsx` + menyvalg, `parseOnix` flyttet uendret til `_shared/onix-book.ts`, `BOKBASEN_ONIX_V3_URL`, `scripts/bokbasen-ny/probe-liste.mjs`. Tester 378/378 grønne, bygget går. **Ikke prøvd mot Bokbasen** (ingen nøkler lokalt), ikke deployet, ikke lagt i git. Uten lager: bokmerket ligger i nettleseren, valgte bøker legges i `books` | Cowork (Claude) |
