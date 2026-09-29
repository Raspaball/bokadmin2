-- ============================================================
-- Bokadmin — Multi-tenant hardening for jobs/scheduled_tasks
-- ============================================================

-- Ensure all relevant tables auto-populate user_id on insert from authenticated clients
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'featured_books_set_user_id'
      AND tgrelid = 'public.featured_books'::regclass
  ) THEN
    CREATE TRIGGER featured_books_set_user_id
      BEFORE INSERT ON public.featured_books
      FOR EACH ROW EXECUTE FUNCTION public.set_user_id_on_insert();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'jobs_set_user_id'
      AND tgrelid = 'public.jobs'::regclass
  ) THEN
    CREATE TRIGGER jobs_set_user_id
      BEFORE INSERT ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.set_user_id_on_insert();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'scheduled_tasks_set_user_id'
      AND tgrelid = 'public.scheduled_tasks'::regclass
  ) THEN
    CREATE TRIGGER scheduled_tasks_set_user_id
      BEFORE INSERT ON public.scheduled_tasks
      FOR EACH ROW EXECUTE FUNCTION public.set_user_id_on_insert();
  END IF;
END $$;

-- Replace broad policies that exposed NULL-scoped rows to all authenticated users
DROP POLICY IF EXISTS "jobs_select" ON public.jobs;
DROP POLICY IF EXISTS "jobs_insert" ON public.jobs;
DROP POLICY IF EXISTS "jobs_update" ON public.jobs;

CREATE POLICY "jobs_select" ON public.jobs
  FOR SELECT USING (
    auth.uid() = user_id
    OR (auth.role() = 'anon' AND user_id IS NULL)
  );

CREATE POLICY "jobs_insert" ON public.jobs
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    OR (auth.role() = 'anon' AND user_id IS NULL)
  );

CREATE POLICY "jobs_update" ON public.jobs
  FOR UPDATE USING (
    auth.uid() = user_id
    OR (auth.role() = 'anon' AND user_id IS NULL)
  );

DROP POLICY IF EXISTS "scheduled_tasks_select" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_insert" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_update" ON public.scheduled_tasks;

CREATE POLICY "scheduled_tasks_select" ON public.scheduled_tasks
  FOR SELECT USING (
    auth.uid() = user_id
    OR (auth.role() = 'anon' AND user_id IS NULL)
  );

CREATE POLICY "scheduled_tasks_insert" ON public.scheduled_tasks
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    OR (auth.role() = 'anon' AND user_id IS NULL)
  );

CREATE POLICY "scheduled_tasks_update" ON public.scheduled_tasks
  FOR UPDATE USING (
    auth.uid() = user_id
    OR (auth.role() = 'anon' AND user_id IS NULL)
  );
