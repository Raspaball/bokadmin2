-- ============================================================
-- Bokadmin — Multi-tenant: per-bruker innstillinger og dataisolasjon
-- Kjør i: Supabase Dashboard → SQL Editor
-- ============================================================

-- ── user_settings: Shopify + Bokbasen credentials per bruker ─────────────────
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  shopify_shop_domain     text,
  shopify_access_token    text,
  bokbasen_client_id      text,
  bokbasen_client_secret  text,
  bokbasen_subscription   text DEFAULT 'extended',
  setup_completed         boolean DEFAULT FALSE,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

DROP TRIGGER IF EXISTS user_settings_updated_at ON public.user_settings;

CREATE TRIGGER user_settings_updated_at
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_settings_select" ON public.user_settings;
DROP POLICY IF EXISTS "user_settings_insert" ON public.user_settings;
DROP POLICY IF EXISTS "user_settings_update" ON public.user_settings;

CREATE POLICY "user_settings_select" ON public.user_settings
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "user_settings_insert" ON public.user_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_settings_update" ON public.user_settings
  FOR UPDATE USING (auth.uid() = user_id);

-- ── Legg til user_id på alle relevante tabeller (ikke-destruktivt) ────────────
ALTER TABLE public.books                 ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.sync_log              ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.banners               ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.featured_books        ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.shopify_catalog_snapshots ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.jobs                  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.scheduled_tasks       ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- ── Trigger: sett user_id automatisk ved insert ───────────────────────────────
-- Gjør at eksisterende frontend-kode fungerer uten endringer:
-- frontend inserter uten user_id → trigger setter det til auth.uid()
-- Edge Functions (anon-rolle) inserter uten user_id → beholder NULL

CREATE OR REPLACE FUNCTION public.set_user_id_on_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.user_id IS NULL AND auth.uid() IS NOT NULL THEN
    NEW.user_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS books_set_user_id ON public.books;
DROP TRIGGER IF EXISTS sync_log_set_user_id ON public.sync_log;
DROP TRIGGER IF EXISTS banners_set_user_id ON public.banners;
DROP TRIGGER IF EXISTS snapshots_set_user_id ON public.shopify_catalog_snapshots;

CREATE TRIGGER books_set_user_id
  BEFORE INSERT ON public.books
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_on_insert();

CREATE TRIGGER sync_log_set_user_id
  BEFORE INSERT ON public.sync_log
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_on_insert();

CREATE TRIGGER banners_set_user_id
  BEFORE INSERT ON public.banners
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_on_insert();

CREATE TRIGGER snapshots_set_user_id
  BEFORE INSERT ON public.shopify_catalog_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_on_insert();

-- ── Oppdater RLS-policyer (erstatter gamle) ───────────────────────────────────
-- books
DROP POLICY IF EXISTS "Authenticated users can read books" ON public.books;
DROP POLICY IF EXISTS "Authenticated users can insert books" ON public.books;
DROP POLICY IF EXISTS "Authenticated users can update books" ON public.books;
DROP POLICY IF EXISTS "Authenticated users can delete books" ON public.books;
DROP POLICY IF EXISTS "Anon can read books" ON public.books;
DROP POLICY IF EXISTS "Anon can update books" ON public.books;

-- Brukere ser egne bøker + legacy-rader (user_id IS NULL)
-- INSERT: trigger setter user_id automatisk, så denne er alltid oppfylt
DROP POLICY IF EXISTS "books_select" ON public.books;
DROP POLICY IF EXISTS "books_insert" ON public.books;
DROP POLICY IF EXISTS "books_update" ON public.books;
DROP POLICY IF EXISTS "books_delete" ON public.books;

CREATE POLICY "books_select" ON public.books
  FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');

CREATE POLICY "books_insert" ON public.books
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');

CREATE POLICY "books_update" ON public.books
  FOR UPDATE USING (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');

CREATE POLICY "books_delete" ON public.books
  FOR DELETE USING (auth.uid() = user_id OR user_id IS NULL);

-- sync_log
DROP POLICY IF EXISTS "Authenticated users full access to sync_log" ON public.sync_log;
DROP POLICY IF EXISTS "Anon can insert sync_log" ON public.sync_log;
DROP POLICY IF EXISTS "sync_log_select" ON public.sync_log;
DROP POLICY IF EXISTS "sync_log_insert" ON public.sync_log;
DROP POLICY IF EXISTS "sync_log_delete" ON public.sync_log;

CREATE POLICY "sync_log_select" ON public.sync_log
  FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "sync_log_insert" ON public.sync_log
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');

CREATE POLICY "sync_log_delete" ON public.sync_log
  FOR DELETE USING (auth.uid() = user_id OR user_id IS NULL);

-- banners
DROP POLICY IF EXISTS "Authenticated users full access to banners" ON public.banners;
DROP POLICY IF EXISTS "banners_all" ON public.banners;

CREATE POLICY "banners_all" ON public.banners
  FOR ALL USING (auth.uid() = user_id OR user_id IS NULL);

-- featured_books
DROP POLICY IF EXISTS "Authenticated users full access to featured_books" ON public.featured_books;
DROP POLICY IF EXISTS "featured_books_all" ON public.featured_books;

CREATE POLICY "featured_books_all" ON public.featured_books
  FOR ALL USING (auth.uid() = user_id OR user_id IS NULL);

-- shopify_catalog_snapshots
DROP POLICY IF EXISTS "auth_only" ON public.shopify_catalog_snapshots;
DROP POLICY IF EXISTS "snapshots_all" ON public.shopify_catalog_snapshots;

CREATE POLICY "snapshots_all" ON public.shopify_catalog_snapshots
  FOR ALL USING (auth.uid() = user_id OR user_id IS NULL);

-- jobs
DROP POLICY IF EXISTS "Authenticated users full access to jobs" ON public.jobs;
DROP POLICY IF EXISTS "Anon can read jobs" ON public.jobs;
DROP POLICY IF EXISTS "Anon can update jobs" ON public.jobs;
DROP POLICY IF EXISTS "Anon can insert jobs" ON public.jobs;
DROP POLICY IF EXISTS "jobs_select" ON public.jobs;
DROP POLICY IF EXISTS "jobs_insert" ON public.jobs;
DROP POLICY IF EXISTS "jobs_update" ON public.jobs;

CREATE POLICY "jobs_select" ON public.jobs
  FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');

CREATE POLICY "jobs_insert" ON public.jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');

CREATE POLICY "jobs_update" ON public.jobs
  FOR UPDATE USING (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');

-- scheduled_tasks
DROP POLICY IF EXISTS "Authenticated users full access to scheduled_tasks" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "Anon can read scheduled_tasks" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "Anon can update scheduled_tasks" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "Anon can insert scheduled_tasks" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_select" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_insert" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "scheduled_tasks_update" ON public.scheduled_tasks;

CREATE POLICY "scheduled_tasks_select" ON public.scheduled_tasks
  FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');

CREATE POLICY "scheduled_tasks_insert" ON public.scheduled_tasks
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');

CREATE POLICY "scheduled_tasks_update" ON public.scheduled_tasks
  FOR UPDATE USING (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'anon');
