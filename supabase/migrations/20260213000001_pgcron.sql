-- ============================================================
-- Bokadmin — pg_cron + pg_net setup for background job processing
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================
-- NOTE: pg_cron and pg_net are pre-installed on Supabase but need
-- to be enabled via Dashboard → Database → Extensions first.
--
-- The cron jobs read the project URL and anon key from Supabase Vault,
-- so no project is hardcoded here. Create both secrets first:
--   SELECT vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   SELECT vault.create_secret('<anon key>', 'anon_key');
-- ============================================================

-- Enable extensions (if not already enabled via Dashboard)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Resume paused price-update jobs every minute ─────────────────────────────
-- When a batch completes, the Edge Function sets status='paused'.
-- This cron job picks it up within 1 minute and continues processing.
SELECT cron.schedule(
  'resume-paused-jobs',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/price-update/resume-paused',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
    body := '{}'::jsonb
  );
  $$
);

-- ── Scheduled tasks runner — every minute ────────────────────────────────────
-- Checks the scheduled_tasks table for tasks that are due to run.
-- Creates a new job and calls the appropriate Edge Function.
SELECT cron.schedule(
  'run-scheduled-tasks',
  '* * * * *',
  $$
  -- For each enabled scheduled task where next_run_at is in the past (or null on first run),
  -- check if the cron expression matches current time (simplified: we use next_run_at).
  -- If next_run_at is null, calculate it from cron_expr; if it's past, trigger the task.
  DO $body$
  DECLARE
    task RECORD;
    response_id BIGINT;
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
      -- Only trigger price_update tasks
      IF task.type = 'price_update' THEN
        -- Call the price-update/start Edge Function
        SELECT net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/price-update/start',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
          body := '{}'::jsonb
        ) INTO response_id;

        -- Update last_run_at and calculate next_run_at
        -- Simple interval calculation based on common cron patterns
        UPDATE public.scheduled_tasks
        SET
          last_run_at = now(),
          next_run_at = CASE
            WHEN cron_expr = '0 3 * * *' THEN date_trunc('day', now()) + interval '1 day' + interval '3 hours'
            WHEN cron_expr = '0 6 * * *' THEN date_trunc('day', now()) + interval '1 day' + interval '6 hours'
            WHEN cron_expr = '0 3 * * 1' THEN date_trunc('week', now()) + interval '1 week' + interval '3 hours'
            WHEN cron_expr = '0 3 1 * *' THEN date_trunc('month', now()) + interval '1 month' + interval '3 hours'
            WHEN cron_expr = '0 */6 * * *' THEN date_trunc('hour', now()) + interval '6 hours'
            WHEN cron_expr = '0 */12 * * *' THEN date_trunc('hour', now()) + interval '12 hours'
            ELSE now() + interval '1 day'  -- fallback: daily
          END
        WHERE id = task.id;

        RAISE NOTICE 'Triggered scheduled task: % (%)', task.name, task.id;
      END IF;
    END LOOP;
  END;
  $body$;
  $$
);
