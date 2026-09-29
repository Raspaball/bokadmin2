-- ============================================================
-- Bokadmin 2.0 — sync_log.job_id
-- ============================================================
-- Koden skriver og filtrerer på sync_log.job_id (price-update,
-- availability-check, Import.tsx, Sjangre.tsx, api.ts → syncLog.getByJob),
-- men ingen migrasjon opprettet kolonnen. I en database bygget fra
-- migrasjonene feilet derfor alle jobblogg-innslag stille.
--
-- Ingen fremmednøkkel til jobs: Import.tsx bruker egne UUID-er
-- (crypto.randomUUID()) for import-kjøringer som ikke ligger i jobs.
-- ============================================================

alter table public.sync_log
  add column if not exists job_id uuid;

create index if not exists sync_log_job_id_idx
  on public.sync_log (job_id);

-- ── Rollback ────────────────────────────────────────────────
-- drop index if exists public.sync_log_job_id_idx;
-- alter table public.sync_log drop column if exists job_id;
