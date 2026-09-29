-- ============================================================
-- Bokadmin drives én enkelt butikk nå — multi-tenant RLS (auth.uid() = user_id)
-- er unødvendig og blokkerer skriving (bl.a. "legg til i Arbeidsliste" på
-- Bokbasen-siden feilet med "new row violates row-level security policy"
-- for tabellen "books"). Denne migrasjonen bytter til enkle
-- "innlogget bruker har full tilgang"-policyer, jf. ROLLBACK_multi_tenant.sql.
-- user_id-kolonner og auto-fill-triggeren beholdes (ufarlige, ingen policy
-- er lenger avhengig av dem), i tilfelle multi-tenant tas i bruk igjen senere.
-- ============================================================

-- ── books ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "books_select" ON public.books;
DROP POLICY IF EXISTS "books_insert" ON public.books;
DROP POLICY IF EXISTS "books_update" ON public.books;
DROP POLICY IF EXISTS "books_delete" ON public.books;
DROP POLICY IF EXISTS "Authenticated users can read books" ON public.books;
DROP POLICY IF EXISTS "Authenticated users can insert books" ON public.books;
DROP POLICY IF EXISTS "Authenticated users can update books" ON public.books;
DROP POLICY IF EXISTS "Authenticated users can delete books" ON public.books;
DROP POLICY IF EXISTS "Anon can read books" ON public.books;
DROP POLICY IF EXISTS "Anon can update books" ON public.books;

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
DROP POLICY IF EXISTS "Authenticated users full access to sync_log" ON public.sync_log;
DROP POLICY IF EXISTS "Anon can insert sync_log" ON public.sync_log;

CREATE POLICY "Authenticated users full access to sync_log"
  ON public.sync_log FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Anon can insert sync_log"
  ON public.sync_log FOR INSERT WITH CHECK (auth.role() = 'anon');

-- ── banners ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "banners_all" ON public.banners;
DROP POLICY IF EXISTS "Authenticated users full access to banners" ON public.banners;

CREATE POLICY "Authenticated users full access to banners"
  ON public.banners FOR ALL USING (auth.role() = 'authenticated');

-- ── featured_books ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "featured_books_all" ON public.featured_books;
DROP POLICY IF EXISTS "Authenticated users full access to featured_books" ON public.featured_books;

CREATE POLICY "Authenticated users full access to featured_books"
  ON public.featured_books FOR ALL USING (auth.role() = 'authenticated');

-- ── shopify_catalog_snapshots ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "snapshots_all" ON public.shopify_catalog_snapshots;
DROP POLICY IF EXISTS "auth_only" ON public.shopify_catalog_snapshots;

CREATE POLICY "auth_only" ON public.shopify_catalog_snapshots
  FOR ALL USING (auth.role() = 'authenticated');

-- ── jobs ──────────────────────────────────────────────────────────────────────
-- (anon read/insert/update/delete kept: pg_cron's resume-paused calls with the
-- anon key and no user JWT — see "Job resume-arkitektur" in CLAUDE.md)
DROP POLICY IF EXISTS "jobs_select" ON public.jobs;
DROP POLICY IF EXISTS "jobs_insert" ON public.jobs;
DROP POLICY IF EXISTS "jobs_update" ON public.jobs;
DROP POLICY IF EXISTS "jobs_delete" ON public.jobs;
DROP POLICY IF EXISTS "Authenticated users full access to jobs" ON public.jobs;
DROP POLICY IF EXISTS "Anon can read jobs" ON public.jobs;
DROP POLICY IF EXISTS "Anon can update jobs" ON public.jobs;
DROP POLICY IF EXISTS "Anon can insert jobs" ON public.jobs;
DROP POLICY IF EXISTS "Anon can delete jobs" ON public.jobs;

CREATE POLICY "Authenticated users full access to jobs"
  ON public.jobs FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Anon can read jobs"
  ON public.jobs FOR SELECT USING (auth.role() = 'anon');
CREATE POLICY "Anon can update jobs"
  ON public.jobs FOR UPDATE USING (auth.role() = 'anon');
CREATE POLICY "Anon can insert jobs"
  ON public.jobs FOR INSERT WITH CHECK (auth.role() = 'anon');
CREATE POLICY "Anon can delete jobs"
  ON public.jobs FOR DELETE USING (auth.role() = 'anon');

-- ── scheduled_tasks ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "scheduled_tasks_select" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_insert" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_update" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_delete" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "Authenticated users full access to scheduled_tasks" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "Anon can read scheduled_tasks" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "Anon can update scheduled_tasks" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "Anon can insert scheduled_tasks" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "Anon can delete scheduled_tasks" ON public.scheduled_tasks;

CREATE POLICY "Authenticated users full access to scheduled_tasks"
  ON public.scheduled_tasks FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Anon can read scheduled_tasks"
  ON public.scheduled_tasks FOR SELECT USING (auth.role() = 'anon');
CREATE POLICY "Anon can update scheduled_tasks"
  ON public.scheduled_tasks FOR UPDATE USING (auth.role() = 'anon');
CREATE POLICY "Anon can insert scheduled_tasks"
  ON public.scheduled_tasks FOR INSERT WITH CHECK (auth.role() = 'anon');
CREATE POLICY "Anon can delete scheduled_tasks"
  ON public.scheduled_tasks FOR DELETE USING (auth.role() = 'anon');

-- ── user_settings ─────────────────────────────────────────────────────────────
-- Beholdes user_id-scoped som før (kun brukeren selv kan se/endre egne
-- credentials) — dette er ikke relatert til RLS-bugen og skal ikke forenkles.
