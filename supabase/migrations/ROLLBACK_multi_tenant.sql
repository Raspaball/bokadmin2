-- ============================================================
-- ROLLBACK: Gjenopprett original single-tenant RLS-policyer
-- Kjør dette KUN hvis noe er galt etter multi-tenant-migrasjonen
-- ============================================================

-- ── books ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "books_select" ON public.books;
DROP POLICY IF EXISTS "books_insert" ON public.books;
DROP POLICY IF EXISTS "books_update" ON public.books;
DROP POLICY IF EXISTS "books_delete" ON public.books;

CREATE POLICY "Authenticated users can read books"
  ON public.books FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can insert books"
  ON public.books FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can update books"
  ON public.books FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can delete books"
  ON public.books FOR DELETE USING (auth.role() = 'authenticated');
CREATE POLICY "Anon can read books"
  ON public.books FOR SELECT USING (auth.role() = 'anon');
CREATE POLICY "Anon can update books"
  ON public.books FOR UPDATE USING (auth.role() = 'anon');

-- ── sync_log ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "sync_log_select" ON public.sync_log;
DROP POLICY IF EXISTS "sync_log_insert" ON public.sync_log;
DROP POLICY IF EXISTS "sync_log_delete" ON public.sync_log;

CREATE POLICY "Authenticated users full access to sync_log"
  ON public.sync_log FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Anon can insert sync_log"
  ON public.sync_log FOR INSERT WITH CHECK (auth.role() = 'anon');

-- ── banners ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "banners_all" ON public.banners;

CREATE POLICY "Authenticated users full access to banners"
  ON public.banners FOR ALL USING (auth.role() = 'authenticated');

-- ── featured_books ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "featured_books_all" ON public.featured_books;

CREATE POLICY "Authenticated users full access to featured_books"
  ON public.featured_books FOR ALL USING (auth.role() = 'authenticated');

-- ── shopify_catalog_snapshots ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "snapshots_all" ON public.shopify_catalog_snapshots;

CREATE POLICY "auth_only" ON public.shopify_catalog_snapshots
  FOR ALL USING (auth.role() = 'authenticated');

-- ── jobs ──────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "jobs_select" ON public.jobs;
DROP POLICY IF EXISTS "jobs_insert" ON public.jobs;
DROP POLICY IF EXISTS "jobs_update" ON public.jobs;

CREATE POLICY "Authenticated users full access to jobs"
  ON public.jobs FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Anon can read jobs"
  ON public.jobs FOR SELECT USING (auth.role() = 'anon');
CREATE POLICY "Anon can update jobs"
  ON public.jobs FOR UPDATE USING (auth.role() = 'anon');
CREATE POLICY "Anon can insert jobs"
  ON public.jobs FOR INSERT WITH CHECK (auth.role() = 'anon');

-- ── scheduled_tasks ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "scheduled_tasks_select" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_insert" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_update" ON public.scheduled_tasks;

CREATE POLICY "Authenticated users full access to scheduled_tasks"
  ON public.scheduled_tasks FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Anon can read scheduled_tasks"
  ON public.scheduled_tasks FOR SELECT USING (auth.role() = 'anon');
CREATE POLICY "Anon can update scheduled_tasks"
  ON public.scheduled_tasks FOR UPDATE USING (auth.role() = 'anon');
CREATE POLICY "Anon can insert scheduled_tasks"
  ON public.scheduled_tasks FOR INSERT WITH CHECK (auth.role() = 'anon');

-- ── Fjern triggere (de er ufarlige, men ryddig å ta dem bort) ────────────────
DROP TRIGGER IF EXISTS books_set_user_id ON public.books;
DROP TRIGGER IF EXISTS sync_log_set_user_id ON public.sync_log;
DROP TRIGGER IF EXISTS banners_set_user_id ON public.banners;
DROP TRIGGER IF EXISTS snapshots_set_user_id ON public.shopify_catalog_snapshots;
DROP FUNCTION IF EXISTS public.set_user_id_on_insert();
