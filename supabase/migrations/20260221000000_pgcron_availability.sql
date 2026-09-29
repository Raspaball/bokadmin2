-- ============================================================
-- Bokadmin — pg_cron: legg til availability-check i scheduled jobs
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================

-- Fjern eksisterende run-scheduled-tasks (re-oppretter med availability-støtte)
SELECT cron.unschedule('run-scheduled-tasks');

-- ── Resume paused availability-check jobs every minute ───────────────────────
SELECT cron.schedule(
  'resume-paused-availability-jobs',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/availability-check/resume-paused',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
    body := '{}'::jsonb
  );
  $$
);

-- ── Scheduled tasks runner — every minute (støtter price_update + availability_check) ──
SELECT cron.schedule(
  'run-scheduled-tasks',
  '* * * * *',
  $$
  DO $body$
  DECLARE
    task RECORD;
    response_id BIGINT;
    task_mode TEXT;
  BEGIN
    FOR task IN
      SELECT id, name, type, cron_expr, config
      FROM public.scheduled_tasks
      WHERE enabled = true
        AND (
          next_run_at IS NULL
          OR next_run_at <= now()
        )
    LOOP
      IF task.type = 'price_update' THEN
        SELECT net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/price-update/start',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
          body := '{}'::jsonb
        ) INTO response_id;

      ELSIF task.type = 'availability_check' THEN
        task_mode := COALESCE(task.config->>'mode', 'update');
        SELECT net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/availability-check/start',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
          body := ('{"mode":"' || task_mode || '"}')::jsonb
        ) INTO response_id;
      END IF;

      -- Oppdater last_run_at og beregn next_run_at for alle oppgavetyper
      UPDATE public.scheduled_tasks
      SET
        last_run_at = now(),
        next_run_at = CASE
          WHEN cron_expr = '0 3 * * *'   THEN date_trunc('day',  now()) + interval '1 day'  + interval '3 hours'
          WHEN cron_expr = '0 6 * * *'   THEN date_trunc('day',  now()) + interval '1 day'  + interval '6 hours'
          WHEN cron_expr = '0 3 * * 1'   THEN date_trunc('week', now()) + interval '1 week' + interval '3 hours'
          WHEN cron_expr = '0 3 1 * *'   THEN date_trunc('month',now()) + interval '1 month'+ interval '3 hours'
          WHEN cron_expr = '0 */6 * * *'  THEN date_trunc('hour', now()) + interval '6 hours'
          WHEN cron_expr = '0 */12 * * *' THEN date_trunc('hour', now()) + interval '12 hours'
          ELSE now() + interval '1 day'
        END
      WHERE id = task.id;

      RAISE NOTICE 'Triggered scheduled task: % (%)', task.name, task.id;
    END LOOP;
  END;
  $body$;
  $$
);
