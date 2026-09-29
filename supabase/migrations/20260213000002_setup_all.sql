-- ============================================================
-- Bokadmin — Komplett setup for prisoppdatering
-- Lim dette inn i: Supabase Dashboard → SQL Editor → "Run"
-- ============================================================

-- 1. Legg til shopify_variant_id på books-tabellen
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS shopify_variant_id text;

-- 2. Jobs-tabell for bakgrunnsjobber
CREATE TABLE IF NOT EXISTS public.jobs (
  id            uuid primary key default gen_random_uuid(),
  type          text not null,
  status        text not null default 'pending',
  total_items   integer default 0,
  processed     integer default 0,
  succeeded     integer default 0,
  failed        integer default 0,
  skipped       integer default 0,
  current_isbn  text,
  error_message text,
  config        jsonb default '{}',
  result        jsonb default '{}',
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz default now()
);

-- 3. Scheduled tasks-tabell
CREATE TABLE IF NOT EXISTS public.scheduled_tasks (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  type          text not null,
  cron_expr     text not null,
  config        jsonb default '{}',
  enabled       boolean default true,
  last_run_at   timestamptz,
  next_run_at   timestamptz,
  created_at    timestamptz default now()
);

-- 4. RLS
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_tasks ENABLE ROW LEVEL SECURITY;

-- Authenticated brukere (frontend)
DO $$ BEGIN
  CREATE POLICY "Authenticated users full access to jobs"
    ON public.jobs FOR ALL USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Authenticated users full access to scheduled_tasks"
    ON public.scheduled_tasks FOR ALL USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Anon-tilgang (Edge Functions + pg_cron)
DO $$ BEGIN
  CREATE POLICY "Anon can read jobs" ON public.jobs FOR SELECT USING (auth.role() = 'anon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Anon can update jobs" ON public.jobs FOR UPDATE USING (auth.role() = 'anon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Anon can insert jobs" ON public.jobs FOR INSERT WITH CHECK (auth.role() = 'anon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Anon can read scheduled_tasks" ON public.scheduled_tasks FOR SELECT USING (auth.role() = 'anon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Anon can update scheduled_tasks" ON public.scheduled_tasks FOR UPDATE USING (auth.role() = 'anon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Anon can insert sync_log" ON public.sync_log FOR INSERT WITH CHECK (auth.role() = 'anon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Anon can read books" ON public.books FOR SELECT USING (auth.role() = 'anon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Anon can update books" ON public.books FOR UPDATE USING (auth.role() = 'anon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
