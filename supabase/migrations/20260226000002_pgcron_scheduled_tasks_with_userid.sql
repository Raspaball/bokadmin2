-- Fix: run-scheduled-tasks pg_cron job now includes user_id in POST body.
-- Previously sent anon JWT with no sub claim → userId=null → global env var fallback.
-- Now each task's user_id is passed in the request body so edge functions
-- can look up per-user Shopify/Bokbasen credentials from user_settings.

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
  BEGIN
    FOR task IN
      SELECT id, name, type, cron_expr, config, user_id
      FROM public.scheduled_tasks
      WHERE enabled = true
        AND (
          next_run_at IS NULL
          OR next_run_at <= now()
        )
    LOOP
      IF task.type = 'price_update' THEN
        post_body := jsonb_build_object('user_id', task.user_id);
        SELECT net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/price-update/start',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
          body := post_body
        ) INTO response_id;

      ELSIF task.type = 'availability_check' THEN
        task_mode := COALESCE(task.config->>'mode', 'update');
        post_body := jsonb_build_object('user_id', task.user_id, 'mode', task_mode);
        SELECT net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/availability-check/start',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
          body := post_body
        ) INTO response_id;
      END IF;

      UPDATE public.scheduled_tasks
      SET
        last_run_at = now(),
        next_run_at = CASE
          WHEN cron_expr = '0 3 * * *'    THEN date_trunc('day',  now()) + interval '1 day'   + interval '3 hours'
          WHEN cron_expr = '0 6 * * *'    THEN date_trunc('day',  now()) + interval '1 day'   + interval '6 hours'
          WHEN cron_expr = '0 3 * * 1'    THEN date_trunc('week', now()) + interval '1 week'  + interval '3 hours'
          WHEN cron_expr = '0 3 1 * *'    THEN date_trunc('month',now()) + interval '1 month' + interval '3 hours'
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
