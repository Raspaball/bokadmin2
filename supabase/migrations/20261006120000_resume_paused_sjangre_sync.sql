-- Pakke H: pg_cron gjenopptar en pauset sjangre-sync-jobb hvert minutt (resume-paused-sjangre-sync-jobs),
-- som for pris-, tilgjengelighets- og book-update-jobbene. Til nå ble sjangersynken bare tatt videre av
-- frontend-siden; overgangsdagen kan ikke være avhengig av en åpen nettleserfane.
-- URL og nøkkel fra Vault (project_url, anon_key), som de andre cron-jobbene.
--
-- Bare tillegg (én ny pg_cron-jobb, ingen data endres). Krever at sjangre-sync med endepunktet
-- /resume-paused er deployet først.

select cron.schedule(
  'resume-paused-sjangre-sync-jobs',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/sjangre-sync/resume-paused',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
    body := '{}'::jsonb
  );
  $$
);

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- select cron.unschedule('resume-paused-sjangre-sync-jobs');
