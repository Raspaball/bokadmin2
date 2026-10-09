-- Rydd tagger (taggjobben tag_cleanup, 09.10.2026): pg_cron gjenopptar en pauset taggjobb hvert minutt,
-- som for pris-, tilgjengelighets-, bokdata- og sjangerjobbene. URL og nøkkel fra Vault (project_url, anon_key).
-- Uten denne gjenopptas jobben bare av siden Sjangre (mens den er åpen) eller av scripts/drive-jobb.mjs.
--
-- Bare tillegg (én ny pg_cron-jobb).

select cron.schedule(
  'resume-paused-tag-cleanup-jobs',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/tag-cleanup/resume-paused',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
    body := '{}'::jsonb
  );
  $$
);

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- select cron.unschedule('resume-paused-tag-cleanup-jobs');
