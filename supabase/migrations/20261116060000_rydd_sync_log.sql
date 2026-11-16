-- Rydd sync_log hver natt (Bokbasen ny, trinn 0, 16.11.2026).
--
-- sync_log vokste til 219 MB (378 257 rader) og var den største tabellen i en database
-- på 392 av 500 MB. Rader eldre enn 30 dager for de fem jobbhandlingene ble slettet én
-- gang 16.11.2026 (kopi i C:\Bokadmin-backup\2026-11-16\).
--
-- Denne jobben sletter de samme fem handlingene når de er eldre enn 90 dager, hver natt
-- kl. 02:47 UTC (rydd-cron-logg går 02:17). Alle andre handlinger beholdes uansett alder
-- (handle_migrate, handle_rollback, tag_cleanup, publish_online_store, push, import_*,
-- bygg_meny, …): angre for handles og tagger leser dem.
--
-- Kan kjøres på nytt uten skade (unschedule før schedule).
-- Bare tillegg (en ny pg_cron-jobb). Rører ingen andre tabeller.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'rydd-sync-log') then
    perform cron.unschedule('rydd-sync-log');
  end if;
end $$;

select cron.schedule(
  'rydd-sync-log',
  '47 2 * * *',
  $$delete from public.sync_log
     where created_at < now() - interval '90 days'
       and action in ('book_update','sjangre_sync','availability_update','availability_check','update')$$
);

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- select cron.unschedule('rydd-sync-log');
