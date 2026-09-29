-- ============================================================
-- Bokadmin — Jobs & Scheduled Tasks
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================

-- ── jobs ────────────────────────────────────────────────────────────────────
-- Tracks background job execution (price updates, etc.)
create table public.jobs (
  id            uuid primary key default gen_random_uuid(),
  type          text not null,                          -- 'price_update'
  status        text not null default 'pending',        -- pending/running/completed/failed/paused
  total_items   integer default 0,
  processed     integer default 0,
  succeeded     integer default 0,
  failed        integer default 0,
  skipped       integer default 0,                      -- items where price unchanged
  current_isbn  text,                                   -- currently processing
  error_message text,
  config        jsonb default '{}',                     -- job-specific config
  result        jsonb default '{}',                     -- summary when completed
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz default now()
);

-- ── scheduled_tasks ─────────────────────────────────────────────────────────
-- Recurring job definitions (cron-style scheduling)
create table public.scheduled_tasks (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  type          text not null,                          -- 'price_update'
  cron_expr     text not null,                          -- '0 3 * * *' = daily 03:00
  config        jsonb default '{}',
  enabled       boolean default true,
  last_run_at   timestamptz,
  next_run_at   timestamptz,
  created_at    timestamptz default now()
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.jobs enable row level security;
alter table public.scheduled_tasks enable row level security;

create policy "Authenticated users full access to jobs"
  on public.jobs for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access to scheduled_tasks"
  on public.scheduled_tasks for all using (auth.role() = 'authenticated');

-- Also allow anon key to read/update jobs (needed for Edge Functions + pg_cron)
create policy "Anon can read jobs"
  on public.jobs for select using (auth.role() = 'anon');
create policy "Anon can update jobs"
  on public.jobs for update using (auth.role() = 'anon');
create policy "Anon can insert jobs"
  on public.jobs for insert with check (auth.role() = 'anon');

-- Allow anon to read scheduled_tasks (for pg_cron scheduler)
create policy "Anon can read scheduled_tasks"
  on public.scheduled_tasks for select using (auth.role() = 'anon');
create policy "Anon can update scheduled_tasks"
  on public.scheduled_tasks for update using (auth.role() = 'anon');

-- Also allow anon to insert sync_log (Edge Functions use anon key)
create policy "Anon can insert sync_log"
  on public.sync_log for insert with check (auth.role() = 'anon');
create policy "Anon can read books"
  on public.books for select using (auth.role() = 'anon');
create policy "Anon can update books"
  on public.books for update using (auth.role() = 'anon');
