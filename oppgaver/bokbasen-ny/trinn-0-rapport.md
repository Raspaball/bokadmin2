# Trinn 0: rapport (Claude Code, 16.11.2026)

**Gjort:** kopi + kontroll, sletting, pakking, nattlig rydding, repo. **Ikke gjort:** sammenslåing til `main` (venter på Eiriks ja).

| | Før | Etter |
|---|---|---|
| `sync_log` størrelse | 219 MB | 22 MB |
| Databasen | 393 MB | 196 MB (av 500) |
| `sync_log` rader | 378 257 | 81 634 |

- **Kopiert:** `sync_log` 378 257 rader, og `jobs` 101, `books` 405, `price_approvals` 40, `scheduled_tasks` 0, `bokgruppe_cache` 16 773, `shop_switch_log` 32, `shop_settings` 1. Ligger i `C:\Bokadmin-backup\2026-11-16\` (34 MB, gzip-JSONL, `LESMEG.txt` med oppskrift for innlegging). Kontroll grønn: antall i alt og per handling, eldste/nyeste, 6 rader felt for felt (også linjeskift og æøå). Skript: `scripts/backup-tabell.mjs` (bare lesing).
- **Slettet:** 296 623 rader (`book_update` 112 846, `sjangre_sync` 61 659, `update` 49 720, `availability_update` 44 483, `availability_check` 27 915), alle eldre enn 30 dager, i biter på 20 000. SQL: `sql/trinn-0-rydd-sync-log.sql`. Handlingene som beholdes har uendret antall. Ingen jobb kjørte.
- **Klokkejobb:** `rydd-sync-log`, `47 2 * * *` (02:47 UTC), samme fem handlinger eldre enn 90 dager. Fil `supabase/migrations/20261116060000_rydd_sync_log.sql`, registrert i Supabase som versjon `20261116105103` (navnet `rydd_sync_log`; samme mønster som `index_book_id_fks`).
- **Kode sjekket:** bare visning og CSV leser de fem handlingene. Angre (handles, tagger) leser bare sine egne.
- **Repo:** gren `bokbasen-ny/trinn-0`. De to migrasjonene som manglet (kontrollert kjørt: indeksene og `rydd-cron-logg` finnes), `oppgaver/bokbasen-ny/`, skriptet, `fortsett-her.md` (peker), `CLAUDE.md` (klokkejobbene + peker til STATUS). Commit: se `git log` på grenen.
- **Merk:** `20261112060000_rydd_cron_logg.sql` er ikke registrert i `schema_migrations` (ble kjørt direkte 12.11). Jobben finnes.

**Eirik må bestemme / gjøre:**
1. Ja til sammenslåing av `bokbasen-ny/trinn-0` til `main`.
2. Slette den midlertidige Supabase-nøkkelen (Settings → API Keys) og linja `SUPABASE_SERVICE_ROLE_KEY` i `scripts/.env.local`.
