-- Pakke A2 del 4: planlagte prisjobber.
--
-- Endrer pg_cron-jobben run-scheduled-tasks (samme mekanisme som før, URL og
-- nøkkel fra Vault: project_url / anon_key):
--   1. Prisjobber sender mode fra scheduled_tasks.config->>'mode'. Mangler den,
--      sendes 'analyze' (sjekk). price-update/start bruker også 'analyze' uten mode.
--   2. Tidspunktene i cron_expr regnes i norsk tid (Europe/Oslo), ikke UTC.
--   3. Kjører det allerede en prisjobb (running/paused/pending), venter oppgaven
--      (next_run_at flyttes ikke) til den er ferdig. Før fikk den andre oppgaven
--      409 og forsvant stille. Bare én prisoppgave startes per minutt, og en
--      oppdatering går foran en sjekk.
--
-- Endrer ingen tabeller. De to planlagte prisoppgavene i 2.0 (nattlig sjekk og
-- ukentlig oppdatering, avslått) legges inn med SQL, se BOKADMIN2_OPPSETT.md.

SELECT cron.unschedule('run-scheduled-tasks');

SELECT cron.schedule(
  'run-scheduled-tasks',
  '* * * * *',
  $$
  DO $body$
  DECLARE
    task RECORD;
    response_id BIGINT;
    task_mode TEXT;
    post_body JSONB;
    oslo_now TIMESTAMP := now() AT TIME ZONE 'Europe/Oslo';
    price_started BOOLEAN := false;
  BEGIN
    FOR task IN
      SELECT id, name, type, cron_expr, config, user_id
      FROM public.scheduled_tasks
      WHERE enabled = true
        AND (
          next_run_at IS NULL
          OR next_run_at <= now()
        )
      ORDER BY (type = 'price_update' AND config->>'mode' = 'update') DESC, created_at
    LOOP
      IF task.type = 'price_update' THEN
        -- Én prisjobb om gangen: vent til den som kjører er ferdig
        IF price_started OR EXISTS (
          SELECT 1 FROM public.jobs
          WHERE type = 'price_update'
            AND status IN ('running', 'paused', 'pending')
            AND user_id IS NOT DISTINCT FROM task.user_id
        ) THEN
          CONTINUE;
        END IF;
        task_mode := CASE WHEN task.config->>'mode' = 'update' THEN 'update' ELSE 'analyze' END;
        post_body := jsonb_build_object('user_id', task.user_id, 'mode', task_mode);
        SELECT net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/price-update/start',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
          body := post_body
        ) INTO response_id;
        price_started := true;

      ELSIF task.type = 'availability_check' THEN
        task_mode := COALESCE(task.config->>'mode', 'update');
        post_body := jsonb_build_object('user_id', task.user_id, 'mode', task_mode);
        SELECT net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/availability-check/start',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
          body := post_body
        ) INTO response_id;
      END IF;

      -- Neste kjøring i norsk tid (date_trunc på lokal tid, tilbake til timestamptz)
      UPDATE public.scheduled_tasks
      SET
        last_run_at = now(),
        next_run_at = CASE
          WHEN cron_expr = '0 3 * * *'    THEN (date_trunc('day',  oslo_now) + interval '1 day'   + interval '3 hours') AT TIME ZONE 'Europe/Oslo'
          WHEN cron_expr = '0 6 * * *'    THEN (date_trunc('day',  oslo_now) + interval '1 day'   + interval '6 hours') AT TIME ZONE 'Europe/Oslo'
          WHEN cron_expr = '0 3 * * 1'    THEN (date_trunc('week', oslo_now) + interval '1 week'  + interval '3 hours') AT TIME ZONE 'Europe/Oslo'
          WHEN cron_expr = '0 3 1 * *'    THEN (date_trunc('month',oslo_now) + interval '1 month' + interval '3 hours') AT TIME ZONE 'Europe/Oslo'
          WHEN cron_expr = '0 */6 * * *'  THEN date_trunc('hour', now()) + interval '6 hours'
          WHEN cron_expr = '0 */12 * * *' THEN date_trunc('hour', now()) + interval '12 hours'
          ELSE now() + interval '1 day'
        END
      WHERE id = task.id;

      RAISE NOTICE 'Triggered scheduled task: % (%) for user %', task.name, task.id, task.user_id;
    END LOOP;
  END;
  $body$;
  $$
);

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Kjør innholdet i 20260226000002_pgcron_scheduled_tasks_with_userid.sql på nytt
-- (unschedule + schedule av den forrige versjonen). NB: den sender ikke mode for
-- prisjobber, og price-update/start gir da 'analyze' etter del 4.
