-- Indekser på fremmednøkler mot books (2026-10-22).
-- Uten disse må «Tøm liste» (delete fra books) lese hele sync_log én gang per bok
-- (ON DELETE SET NULL), og med ~366 000 loggrader gikk det i statement timeout.
-- Additiv: legger bare til indekser, endrer ingen data.

create index if not exists sync_log_book_id_idx on public.sync_log (book_id);
create index if not exists featured_books_book_id_idx on public.featured_books (book_id);

-- ROLLBACK:
-- drop index if exists public.sync_log_book_id_idx;
-- drop index if exists public.featured_books_book_id_idx;
