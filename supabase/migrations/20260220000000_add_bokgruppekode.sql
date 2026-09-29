-- Add bokgruppekode (Forleggerforeningen 3-digit classification) and varegruppe
alter table public.books
  add column if not exists bokgruppekode text,
  add column if not exists varegruppe    text;
