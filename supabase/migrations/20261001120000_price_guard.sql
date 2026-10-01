-- Pakke A2 del 2: sperre mot store prishopp.
--
-- user_settings.max_price_change_pct: største prisendring (prosent av gammel
-- pris) som prisjobben og push setter uten godkjenning. Standard 30.
--
-- price_approvals: prisendringer som er stoppet av sperren og venter på
-- godkjenning i Bokadmin (Oppdatering-siden). Kun Edge Functions (service role)
-- skriver; innloggede brukere kan lese. Én ventende rad per variant.
--
-- Bare tillegg (ADD COLUMN / CREATE TABLE).

alter table public.user_settings
  add column if not exists max_price_change_pct numeric not null default 30
  check (max_price_change_pct > 0);

create table if not exists public.price_approvals (
  id                 uuid primary key default gen_random_uuid(),
  isbn               text not null,
  title              text,
  shopify_product_id text not null,
  shopify_variant_id text not null,
  old_price          numeric,
  new_price          numeric not null check (new_price > 0),
  change_pct         numeric,
  source             text not null check (source in ('price-update', 'push')),
  status             text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  job_id             uuid,
  user_id            uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         text,
  decision_note      text
);

create unique index if not exists price_approvals_one_pending_per_variant
  on public.price_approvals (shopify_variant_id) where status = 'pending';
create index if not exists price_approvals_status_created
  on public.price_approvals (status, created_at desc);

alter table public.price_approvals enable row level security;

create policy "Authenticated users can read price_approvals"
  on public.price_approvals for select using (auth.role() = 'authenticated');

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- drop table if exists public.price_approvals;
-- alter table public.user_settings drop column if exists max_price_change_pct;
