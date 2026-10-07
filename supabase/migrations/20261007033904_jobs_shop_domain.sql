-- Live-sjekk 1, punkt 3: hver jobb husker hvilken butikk den startet mot (jobs.shop_domain).
-- Koden stempler domenet når jobben lages (_shared/job-shop.ts: currentShopDomain) og stopper
-- jobben (failed) ved neste puls hvis aktiv butikk er en annen, eller stempelet mangler
-- (stopIfShopChanged / jobShopMismatch i _shared/shop-guard.js).
-- Bare tillegg: én ny kolonne, ingen data endres.
-- Kjørt 07.10.2026 via Supabase MCP (apply_migration), versjon 20261007033904.

alter table public.jobs add column if not exists shop_domain text;
comment on column public.jobs.shop_domain is
  'Butikkdomenet jobben ble startet mot. Jobben stopper (failed) hvis aktiv butikk er en annen ved fortsettelse.';

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- alter table public.jobs drop column if exists shop_domain;
