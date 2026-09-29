-- ============================================================
-- Bokadmin — Supabase database schema
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================

-- gen_random_uuid() is available by default in Supabase (pgcrypto)

-- ── books ────────────────────────────────────────────────────────────────────
create table public.books (
  id            uuid primary key default gen_random_uuid(),
  isbn          text not null unique,
  title         text not null,
  author        text,
  publisher     text,
  year          text,
  format        text,
  price         numeric(10,2),
  description   text,
  image_url     text,
  genre         text,
  bokgruppe     text,
  vekt          numeric(10,2),
  stock         integer default 0,
  -- Shopify
  shopify_id    text,
  shopify_handle text,
  shopify_variant_id text,
  synced_at     timestamptz,
  -- Meta
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger books_updated_at
  before update on public.books
  for each row execute function update_updated_at();

-- ── banners ──────────────────────────────────────────────────────────────────
create table public.banners (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  subtitle   text,
  cta        text default 'Se mer',
  link       text default '/',
  bg_color   text default '#1a1230',
  active     boolean default true,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create trigger banners_updated_at
  before update on public.banners
  for each row execute function update_updated_at();

-- ── featured_books ───────────────────────────────────────────────────────────
create table public.featured_books (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid references public.books(id) on delete cascade,
  sort_order integer default 0,
  created_at timestamptz default now()
);

-- ── sync_log ─────────────────────────────────────────────────────────────────
create table public.sync_log (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid references public.books(id) on delete set null,
  isbn       text,
  title      text,
  action     text not null, -- 'push' | 'update' | 'csv_export'
  status     text not null, -- 'success' | 'error'
  message    text,
  shopify_id text,
  created_at timestamptz default now()
);

-- ── Row Level Security ───────────────────────────────────────────────────────
alter table public.books enable row level security;
alter table public.banners enable row level security;
alter table public.featured_books enable row level security;
alter table public.sync_log enable row level security;

-- Only authenticated users can read/write
create policy "Authenticated users can read books"
  on public.books for select using (auth.role() = 'authenticated');
create policy "Authenticated users can insert books"
  on public.books for insert with check (auth.role() = 'authenticated');
create policy "Authenticated users can update books"
  on public.books for update using (auth.role() = 'authenticated');
create policy "Authenticated users can delete books"
  on public.books for delete using (auth.role() = 'authenticated');

create policy "Authenticated users full access to banners"
  on public.banners for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access to featured_books"
  on public.featured_books for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access to sync_log"
  on public.sync_log for all using (auth.role() = 'authenticated');

-- ── Secure API keys in Vault ─────────────────────────────────────────────────
-- Run these separately in SQL editor after setting up Vault:
--
-- select vault.create_secret('YOUR_BOKBASEN_CLIENT_ID', 'BOKBASEN_CLIENT_ID');
-- select vault.create_secret('YOUR_BOKBASEN_CLIENT_SECRET', 'BOKBASEN_CLIENT_SECRET');
-- select vault.create_secret('YOUR_SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_SHOP_DOMAIN');
-- select vault.create_secret('YOUR_SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_ACCESS_TOKEN');
--
-- Or set them as Edge Function environment variables:
-- supabase secrets set BOKBASEN_CLIENT_ID=your_id
-- supabase secrets set BOKBASEN_CLIENT_SECRET=your_secret
-- supabase secrets set SHOPIFY_SHOP_DOMAIN=minbutikk.myshopify.com
-- supabase secrets set SHOPIFY_ACCESS_TOKEN=shpat_xxx

-- ── Seed some example banners ─────────────────────────────────────────────────
insert into public.banners (title, subtitle, cta, link, bg_color, sort_order) values
  ('Norges beste krimserie', 'Alle Harry Hole-bøkene nå med 20% rabatt', 'Se tilbudet', '/krim', '#1a1230', 1),
  ('Årets debuttant', 'Tante Ulrikkes vei er årets mest omtalte debutbok', 'Kjøp nå', '/debut', '#12201a', 2);
