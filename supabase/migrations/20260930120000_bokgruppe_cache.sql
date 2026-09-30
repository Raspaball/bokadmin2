-- Egen cache for ISBN → bokgruppekode, fylt av sjangersynkens fase 1
-- (sjangre-sync/enrich-start) og lest av tagge-fasen.
--
-- Hvorfor ikke books: books er også arbeidslista på Import-siden. Minimale rader
-- (title = ISBN, ingen pris) der ville blitt vist som ikke-pushede bøker, og
-- «Push alle» ville overskrevet tittel og satt pris 0 i Shopify. «Tøm liste»
-- sletter dessuten hele books, og dermed cachen.
--
-- Kun Edge Functions (service role) skriver. Innloggede brukere kan lese.

create table if not exists public.bokgruppe_cache (
  isbn          text primary key,
  bokgruppekode text not null,
  updated_at    timestamptz not null default now()
);

alter table public.bokgruppe_cache enable row level security;

create policy "Authenticated users can read bokgruppe_cache"
  on public.bokgruppe_cache for select using (auth.role() = 'authenticated');

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- drop table if exists public.bokgruppe_cache;
