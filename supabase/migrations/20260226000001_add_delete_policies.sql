-- Add missing DELETE policies for scheduled_tasks and jobs tables.
-- SELECT/INSERT/UPDATE were added in 20260220000003 but DELETE was omitted,
-- causing all delete attempts to be silently blocked by RLS.

CREATE POLICY "scheduled_tasks_delete" ON public.scheduled_tasks
  FOR DELETE USING (
    auth.uid() = user_id
    OR (auth.role() = 'anon' AND user_id IS NULL)
  );

CREATE POLICY "jobs_delete" ON public.jobs
  FOR DELETE USING (
    auth.uid() = user_id
    OR (auth.role() = 'anon' AND user_id IS NULL)
  );
