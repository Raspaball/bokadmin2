# Bokbasen ny, trinn 0: opprydding   (16.11.2026, skrevet av Cowork/Claude for Claude Code)

## Mål (én setning)
Få plass i databasen og orden i repoet før noe nytt bygges: sikker kopi av `sync_log`, sletting av gamle loggrader, nattlig rydding, og de to migrasjonene inn i git.

## Les først
- `CLAUDE.md` (særlig «Regler for trygge endringer» og jobbene)
- `oppgaver/bokbasen-ny/STATUS.md` (tallene fra 16.11 står der)
- Prosjektdokumentet `plan-bokbasen-ny.md`, avsnittet «Trinn 0»
- `supabase/migrations/20261112060000_rydd_cron_logg.sql` (mal for en klokkejobb som rydder)

## Modell
Opus. Trinnet sletter data i databasen som livebutikken driftes fra.

## Før du starter
1. Svar Eirik med en plan på høyst 15 linjer (filer, rekkefølge, hvordan kopien tas, hvordan SQL kjøres). Ingen endringer før han sier ja.
2. Eirik gir deg Supabase-nøkkelen. Skriv det øverst i STATUS.md («Hos Claude Code siden …, for trinn 0»).
3. Kontroller at ingen jobb kjører: `select type, status from jobs where status in ('running','paused','finalizing','pending')` skal gi 0 rader. Kjører noe: stopp og si fra.

## Dette skal lages, i denne rekkefølgen. Stopp ved første feil.

### Del 1: kopi (ingen endring i Supabase)
- Mappe på Eiriks maskin, **utenfor repoet**: `C:\Bokadmin-backup\2026-11-16\`. Ikke `scripts/out/`.
  - Mappa finnes ikke fra før. Lag den. Den skal ligge ved siden av `C:\Bokadmin 2.0`, ikke inni, slik at kopien aldri kan havne på GitHub.
- Full kopi av `sync_log`: alle 14 kolonner, alle rader (378 257 den 16.11 [DB]).
  - Velg metoden selv og si hvilken i planen: `supabase db dump --data-only` (krever Docker og databasepassord), eller et lite skript `scripts/backup-tabell.mjs` som leser tabellen side for side i fast rekkefølge (`created_at, id`) og skriver JSONL (én rad per linje), gjerne pakket.
  - Skriptet kan ligge i git. Det skal ikke inneholde nøkler (bruk `.env.local` som de andre skriptene) og bare lese.
- Kopi også av disse små tabellene, samme sted: `jobs`, `books`, `price_approvals`, `scheduled_tasks`, `bokgruppe_cache`, `shop_switch_log`, `shop_settings`.
- **Ikke** kopier `user_settings`, `shop_profiles` eller noe fra Vault. De har hemmeligheter.
- `onix_cache` (90 MB) kopieres ikke. Den kan hentes på nytt.
- **Kontroll av kopien (må være grønn):**
  1. Antall rader i kopien = antall i databasen, i alt og per `action`.
  2. Eldste og nyeste `created_at` er like.
  3. Fem tilfeldige rader leses tilbake fra fila og er like raden i databasen, felt for felt (også `fields` og `message` med linjeskift og norske tegn).
  4. En fil `LESMEG.txt` i mappa: dato, hva som er kopiert, antall rader per tabell, og hvordan radene legges inn igjen.
- **Stopp her.** Rapporter tallene til Eirik og vent på ja til slettingen.

### Del 2: sletting (etter Eiriks ja til akkurat denne slettingen)
- Skriv SQL-en til fil først: `oppgaver/bokbasen-ny/sql/trinn-0-rydd-sync-log.sql`. Så kjøres den.
- Slett rader i `sync_log` der `created_at` er eldre enn 30 dager **og** `action` er en av: `book_update`, `sjangre_sync`, `availability_update`, `availability_check`, `update`.
  - Eirik har bekreftet 16.11.2026 at prisjobbens logg (`update`) også slettes. Den ligger i kopien.
  - Ventet antall: ca. 296 623. Igjen: ca. 81 634 [DB 16.11]. Avviker tallet med mer enn noen få rader: stopp og spør.
- Alle andre handlinger beholdes uansett alder: `handle_migrate`, `handle_rollback`, `tag_cleanup`, `publish_online_store`, `push`, `import_*`, `bygg_meny` og alt som ikke står i lista over.
- Slett i biter (for eksempel 20 000 rader om gangen), så ingen spørring går i tidsavbrudd.
- Mål størrelsen på `sync_log` og hele databasen før og etter.
- Pakk tabellen: `VACUUM FULL public.sync_log`. Den låser tabellen mens den går, så kontroller på nytt at ingen jobb kjører rett før. Den kan ikke kjøres inne i en transaksjon.
- Kontroll etterpå: antall per `action` for de handlingene som beholdes er uendret fra før slettingen.

### Del 3: nattlig rydding (migrasjonsfil først, kjøring etter Eiriks ja)
- Ny fil `supabase/migrations/<nytt tidsstempel>_rydd_sync_log.sql`, bygd som `20261112060000_rydd_cron_logg.sql`:
  - klokkejobb `rydd-sync-log`, én gang per natt på et annet minutt enn `rydd-cron-logg` (02:17 UTC)
  - sletter de samme fem handlingene når de er eldre enn **90 dager**
  - kan kjøres på nytt uten skade (unschedule før schedule)
  - ROLLBACK-avsnitt nederst
- Ikke `supabase db push`. Kjør fila slik migrasjoner har vært kjørt før (SQL Editor eller tilsvarende), og registrer den som kjørt.
- Kontroll: `select jobname, schedule, active from cron.job` viser den nye jobben.

### Del 4: repoet
- Gren `bokbasen-ny/trinn-0`. Ingenting slås sammen til `main` uten Eiriks ja (Vercel bygger `main`).
- Commit de to migrasjonene som ikke er i git: `20261022070000_index_book_id_fks.sql` og `20261112060000_rydd_cron_logg.sql`. Begge er alt kjørt [DB 16.11: indeksene `sync_log_book_id_idx` og `featured_books_book_id_idx` og jobben `rydd-cron-logg` finnes]. Kontroller det selv før commit.
- Commit `oppgaver/bokbasen-ny/` (STATUS og de tre oppdragene).
- Erstatt innholdet i `oppgaver/fortsett-her.md` med en kort peker: «Gjeldende arbeid: Bokbasen ny. Les `oppgaver/bokbasen-ny/STATUS.md`.» Den gamle teksten ligger i git-historikken.
- Oppdater `CLAUDE.md`: klokkejobbene (`rydd-cron-logg`, `rydd-sync-log`, og at det finnes gjenopptak for sjangre og rydd tagger), og at status for «Bokbasen ny» står i `oppgaver/bokbasen-ny/STATUS.md`.
- Oppdater STATUS.md: trinn 0 ferdig, tall, og Supabase-nøkkelen tilbake til «Ledig».

## Dette skal IKKE røres
- Livebutikken og utviklingsbutikken (ingen kall til Shopify i dette trinnet).
- Gamle Bokadmin.
- Edge Functions (ingen deploy), frontend, `_shared/`.
- Alle andre tabeller enn `sync_log`. Ingen andre klokkejobber.
- Handlingene som beholdes (se over). Angre for handles og tagger leser dem.

## Vær obs på
- Loggvisningen for gamle jobber på sidene Oppdatering, Tilgjengelighet og Sjangre blir tom for de slettede handlingene. Det er ventet. Sjekk likevel i koden at ingenting **annet enn visning** leser disse fem handlingene (`sync_log` leses i `availability-check`, `book-update`, `price-update`, `publish-books`, `sjangre-sync`, `tag-cleanup`, `_shared/bulk-job.ts` og `src/app/utils/api.ts`). Finner du noe som trenger radene (for eksempel angre eller gjenopptak): stopp og spør.
- Kopien skal aldri i git, og aldri i `scripts/data/` eller `scripts/out/`.

## Miljø
Gren: `bokbasen-ny/trinn-0`. Supabase 2.0 (ref `chwpqwblqummlufqdefe`). Butikk: ingen. Bokbasen: ikke i bruk.

## Tester og kontroll (må være grønne)
- `node --test scripts/*.test.mjs`
- Kontrollen av kopien (del 1), tallene etter sletting (del 2), klokkejobben (del 3)
- `git status` er ren på grenen, og ingen hemmeligheter eller ISBN-lister er lagt til

## Stopp og spør hvis
- noe krever endring utenfor lista over
- en jobb kjører, eller en ny starter underveis
- antall rader avviker fra tallene i STATUS.md med mer enn noen få
- kontrollen av kopien ikke er helt lik
- du er i tvil om hvilket miljø en handling treffer

## Krever Eiriks ja (hver for seg)
1. Planen din.
2. Slettingen, etter at kopien er kontrollert.
3. Kjøring av migrasjonen med den nattlige ryddingen.
4. Sammenslåing til `main`.

## Tilbakerulling
- Slettede rader: legges inn igjen fra kopien i `C:\Bokadmin-backup\2026-11-16\` (oppskrift i `LESMEG.txt`).
- Nattlig rydding: `select cron.unschedule('rydd-sync-log');`
- Repoet: grenen slettes, `main` er urørt.

## Rapport (maks 20 linjer, til `oppgaver/bokbasen-ny/trinn-0-rapport.md`)
Gjort og ikke gjort. Størrelse på `sync_log` og databasen før og etter. Antall rader kopiert, slettet og igjen. Hvor kopien ligger og hvor stor den er. Navn og tid for klokkejobben. Commit-hash. Hva Eirik må bestemme.
