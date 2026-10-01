-- Pakke B del 1: forfatterne som liste.
--
-- books.authors: forfatterne i rekkefølge som «Fornavn Etternavn», fra
-- extractContributors() i supabase/functions/_shared/onix.js. Handle og
-- bok.forfatter bygges fra listen. books.author beholdes som visningstekst.
-- Rader fra før har authors = NULL; da brukes author via firstAuthor() som reserve.
--
-- Bare tillegg (ADD COLUMN).

alter table public.books
  add column if not exists authors text[];

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- alter table public.books drop column if exists authors;
