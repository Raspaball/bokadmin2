-- Pakke F del 3.1 og 3.2: én loggrad per produkt per jobb, og livstegn på jobbene.
--
-- sync_log.outcome / reason / fields: utfallet for produktet i jobben
-- (_shared/job-log.ts). outcome = endret | uendret | hoppet_over | feil;
-- reason = årsak når produktet ble hoppet over (ingen_isbn, ikke_bok,
-- ikke_i_bokbasen, beskyttet, duplikat, egen_pris, egen_tilgjengelighet,
-- paa_lager, arkivert); fields = feltene som ble (eller ville blitt) endret.
-- Eldre rader har null i alle tre.
--
-- jobs.heartbeat_at / last_isbn: settes av en trigger ved hver oppdatering av
-- jobbraden, så alle jobber har livstegn uten egen kode. last_isbn er siste
-- ISBN jobben jobbet med (current_isbn tømmes når jobben pauses).
-- Oppdatering-siden viser «står stille» når heartbeat_at er eldre enn 5 minutter.
--
-- Bare tillegg (ADD COLUMN, indeks og trigger).

alter table public.sync_log add column if not exists outcome text;
alter table public.sync_log add column if not exists reason  text;
alter table public.sync_log add column if not exists fields  text[];

create index if not exists sync_log_job_outcome on public.sync_log (job_id, outcome);

alter table public.jobs add column if not exists heartbeat_at timestamptz;
alter table public.jobs add column if not exists last_isbn    text;

create or replace function public.jobs_heartbeat() returns trigger
language plpgsql as $$
begin
  new.heartbeat_at := now();
  if new.current_isbn is not null then
    new.last_isbn := new.current_isbn;
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_heartbeat on public.jobs;
create trigger jobs_heartbeat
  before insert or update on public.jobs
  for each row execute function public.jobs_heartbeat();

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- drop trigger if exists jobs_heartbeat on public.jobs;
-- drop function if exists public.jobs_heartbeat();
-- alter table public.jobs drop column if exists last_isbn;
-- alter table public.jobs drop column if exists heartbeat_at;
-- drop index if exists public.sync_log_job_outcome;
-- alter table public.sync_log drop column if exists fields;
-- alter table public.sync_log drop column if exists reason;
-- alter table public.sync_log drop column if exists outcome;
