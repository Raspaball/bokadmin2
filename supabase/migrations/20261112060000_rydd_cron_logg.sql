-- Rydd pg_cron-loggen (12.11.2026).
--
-- cron.job_run_details vokste til 535 MB (seks jobber hvert minutt, ca. 8 600
-- rader per døgn) og tok databasen over gratisplanens 500 MB. Rader eldre enn
-- 7 dager ble slettet 12.11.2026 (ingen kopi, bare kjørehistorikk), og
-- tabellen ble pakket med VACUUM FULL (868 MB -> 375 MB).
--
-- Denne jobben sletter kjørehistorikk eldre enn 7 dager hver natt kl. 02:17 UTC.
-- Jobben ble lagt inn direkte i Supabase 12.11.2026; filen her gjør det samme
-- og kan kjøres på nytt uten skade (unschedule før schedule).
--
-- Bare tillegg (en ny pg_cron-jobb). Rører ingen andre tabeller.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'rydd-cron-logg') then
    perform cron.unschedule('rydd-cron-logg');
  end if;
end $$;

select cron.schedule(
  'rydd-cron-logg',
  '17 2 * * *',
  $$delete from cron.job_run_details where start_time < now() - interval '7 days'$$
);

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- select cron.unschedule('rydd-cron-logg');
