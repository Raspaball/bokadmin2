-- Trinn 0 i «Bokbasen ny» (16.11.2026): rydd sync_log én gang.
-- Supabase 2.0 (chwpqwblqummlufqdefe). Kjøres bare etter Eiriks ja, etter at kopien i
-- C:\Bokadmin-backup\2026-11-16\ er kontrollert.
--
-- Sletter rader eldre enn 30 dager for de fem jobbhandlingene. Alt annet beholdes
-- (handle_migrate, handle_rollback, tag_cleanup, publish_online_store, push, import_*,
-- bygg_meny, …): angre for handles og tagger leser dem.

-- 0. Ingen jobb skal kjøre (0 rader)
select type, status from jobs where status in ('running','paused','finalizing','pending');

-- 1. Før: størrelse og antall
select pg_size_pretty(pg_total_relation_size('public.sync_log')) as sync_log,
       pg_size_pretty(pg_database_size(current_database())) as databasen;
select action, count(*) from public.sync_log group by action order by action;
select count(*) as skal_slettes from public.sync_log
 where created_at < now() - interval '30 days'
   and action in ('book_update','sjangre_sync','availability_update','availability_check','update');

-- 2. Slett i biter på 20 000. Kjøres på nytt til den sletter 0 rader.
with del as (
  select id from public.sync_log
   where created_at < now() - interval '30 days'
     and action in ('book_update','sjangre_sync','availability_update','availability_check','update')
   limit 20000
)
delete from public.sync_log s using del where s.id = del.id;

-- 3. Pakk tabellen (sjekk punkt 0 rett før; låser tabellen; ikke i en transaksjon)
vacuum full public.sync_log;

-- 4. Etter: samme spørringer som i punkt 1. Handlingene som beholdes skal ha samme antall.

-- ── TILBAKERULLING ──────────────────────────────────────────────────────────
-- Radene legges inn igjen fra C:\Bokadmin-backup\2026-11-16\sync_log.jsonl.gz
-- (oppskrift i LESMEG.txt i samme mappe).
