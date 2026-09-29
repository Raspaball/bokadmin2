-- ============================================================
-- Bokadmin — Tilgjengelighetssjekk: nye kolonner på books
-- Kjør i: Supabase Dashboard → SQL Editor → "Run"
-- ============================================================

-- Rå ONIX List 65-kode fra Bokbasen (f.eks. "20", "40")
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS availability_code text;

-- Mappet status basert på koden ("available", "temporarily_unavailable", "not_available")
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS availability_status text;
