-- Pakke B del 8: ONIX-cache og gjenopptak av jobben «Oppdater eksisterende bøker».
--
-- onix_cache: rå ONIX per ISBN fra Bokbasen (_shared/onix-cache.ts). Cache
-- yngre enn 7 dager brukes av book-update og push, så en jobb over hele
-- katalogen ikke gir ett Bokbasen-kall per bok hver gang. Bare Edge Functions
-- (service role) leser og skriver; ingen policyer for andre.
--
-- resume-paused-book-update-jobs: pg_cron gjenopptar en pauset book-update-jobb
-- hvert minutt, som for pris- og tilgjengelighetsjobbene. URL og nøkkel fra Vault.
--
-- Bare tillegg (CREATE TABLE og en ny pg_cron-jobb).

create table if not exists public.onix_cache (
  isbn       text primary key,
  xml        text not null,
  fetched_at timestamptz not null default now()
);

create index if not exists onix_cache_fetched_at on public.onix_cache (fetched_at);

alter table public.onix_cache enable row level security;

select cron.schedule(
  'resume-paused-book-update-jobs',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/book-update/resume-paused',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')),
    body := '{}'::jsonb
  );
  $$
);

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- select cron.unschedule('resume-paused-book-update-jobs');
-- drop table if exists public.onix_cache;
