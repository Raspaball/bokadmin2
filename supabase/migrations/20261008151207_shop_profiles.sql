-- Live-sjekk 1, Del 2: butikker i Innstillinger («Butikker»). Kjørt 08.10.2026 via Supabase MCP, versjon 20261008151207 (prøvekjørt i en transaksjon som ble angret først).
-- Bare tillegg: tre nye tabeller og fire funksjoner. Ingen eksisterende data endres.
--
-- Sikkerhet:
-- * Client secret lagres i Supabase Vault, aldri i en tabell. Tabellen har bare secret_id.
-- * RLS på alle tabellene og ingen policyer: nettleseren (anon/authenticated) kan verken lese
--   eller skrive. Alt går via Edge Function med service_role, etter getCaller()-sjekk.
-- * Funksjonene er SECURITY DEFINER og kan bare kjøres av service_role.
-- * shop_switch() håndhever reglene i databasen: ingen aktiv jobb, secret lagret, bekreftet
--   domene og «åpen til» høyst 24 t for live, skrivesperren alltid på.

-- ── Tabeller ────────────────────────────────────────────────────────────────
create table if not exists public.shop_profiles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) between 1 and 40),
  domain      text not null unique check (domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  client_id   text not null check (length(trim(client_id)) between 10 and 100),
  secret_id   uuid,                         -- vault.secrets.id; null = ikke lagret
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
comment on table public.shop_profiles is 'Shopify-butikker Bokadmin kan koble til. Client secret ligger i Vault (secret_id).';

create table if not exists public.shop_settings (
  id                boolean primary key default true check (id),   -- alltid én rad
  active_profile_id uuid references public.shop_profiles(id) on delete restrict,  -- null = Testbutikk fra hemmelighetene
  confirmed_domain  text,          -- domenet slik det ble skrevet ved bytte
  live_until        timestamptz,   -- live er stengt etter dette
  read_only         boolean not null default true,  -- skrivesperre (lås 1 av 2; lås 2 er LIVE_READ_ONLY)
  admin_user_id     uuid,          -- eneste bruker som kan endre butikker
  changed_at        timestamptz,
  changed_by        uuid
);
insert into public.shop_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.shop_switch_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  action      text not null,   -- switch | close | profile_saved | secret_saved | test
  from_domain text,
  to_domain   text,
  live_until  timestamptz,
  read_only   boolean,
  ok          boolean not null default true,
  message     text             -- aldri hemmeligheter
);

alter table public.shop_profiles   enable row level security;
alter table public.shop_settings   enable row level security;
alter table public.shop_switch_log enable row level security;
revoke all on public.shop_profiles, public.shop_settings, public.shop_switch_log from anon, authenticated;
revoke all on sequence public.shop_switch_log_id_seq from anon, authenticated;

-- ── Client secret i Vault ──────────────────────────────────────────────────
create or replace function public.shop_secret_set(p_profile_id uuid, p_secret text, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_secret is null or length(trim(p_secret)) < 10 then raise exception 'Ugyldig Client secret'; end if;
  select secret_id into v_id from public.shop_profiles where id = p_profile_id for update;
  if not found then raise exception 'Fant ikke butikkprofilen'; end if;
  if v_id is null then
    v_id := vault.create_secret(trim(p_secret), 'shopify_client_secret_' || p_profile_id::text,
                                'Client secret for Shopify-app (Bokadmin 2.0)');
    update public.shop_profiles set secret_id = v_id, updated_at = now(), updated_by = p_user where id = p_profile_id;
  else
    perform vault.update_secret(v_id, trim(p_secret));
    update public.shop_profiles set updated_at = now(), updated_by = p_user where id = p_profile_id;
  end if;
  insert into public.shop_switch_log (user_id, action, to_domain, message)
    select p_user, 'secret_saved', domain, 'Client secret lagret' from public.shop_profiles where id = p_profile_id;
end $$;

create or replace function public.shop_secret_get(p_profile_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret
  from public.shop_profiles p join vault.decrypted_secrets ds on ds.id = p.secret_id
  where p.id = p_profile_id;
$$;

-- ── Bytte og lukking ───────────────────────────────────────────────────────
-- p_profile_id null = tilbake til Testbutikk fra hemmelighetene.
-- Live = alle andre domener enn Testbutikk (samme regel som SAFE_SHOPS i shop-guard.js).
create or replace function public.shop_switch(p_profile_id uuid, p_confirm text, p_until timestamptz, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.shop_settings; p public.shop_profiles; v_from text; v_live boolean;
begin
  select * into s from public.shop_settings where id for update;
  if s.admin_user_id is null or p_user is distinct from s.admin_user_id then
    raise exception 'Bare administrator kan bytte butikk';
  end if;
  if exists (select 1 from public.jobs where status in ('running','paused','pending','finalizing')) then
    raise exception 'En jobb kjører eller står på pause. Bytte er ikke tillatt';
  end if;
  select domain into v_from from public.shop_profiles where id = s.active_profile_id;

  if p_profile_id is null then
    update public.shop_settings set active_profile_id = null, confirmed_domain = null, live_until = null,
      read_only = true, changed_at = now(), changed_by = p_user where id;
    insert into public.shop_switch_log (user_id, action, from_domain, to_domain, read_only)
      values (p_user, 'switch', v_from, 'testbutikk (hemmeligheter)', true);
    return;
  end if;

  select * into p from public.shop_profiles where id = p_profile_id;
  if not found then raise exception 'Fant ikke butikkprofilen'; end if;
  if p.secret_id is null then raise exception 'Client secret er ikke lagret for %', p.domain; end if;
  if lower(trim(coalesce(p_confirm, ''))) <> p.domain then
    raise exception 'Bekreftelsen må være hele domenet: %', p.domain;
  end if;
  v_live := p.domain <> 'testbutikk-9434.myshopify.com';
  if v_live and (p_until is null or p_until <= now() or p_until > now() + interval '24 hours') then
    raise exception '«Åpen til» må være fram i tid og høyst 24 timer unna';
  end if;

  update public.shop_settings set active_profile_id = p.id, confirmed_domain = lower(trim(p_confirm)),
    live_until = case when v_live then p_until end, read_only = true,
    changed_at = now(), changed_by = p_user where id;
  insert into public.shop_switch_log (user_id, action, from_domain, to_domain, live_until, read_only)
    values (p_user, 'switch', v_from, p.domain, case when v_live then p_until end, true);
end $$;

-- Lukk live straks (tilbake til Testbutikk). Alltid tillatt, også med aktive jobber:
-- butikkstempelet (jobs.shop_domain) stopper dem ved neste puls.
create or replace function public.shop_close(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_from text;
begin
  if not exists (select 1 from public.shop_settings where id and admin_user_id = p_user) then
    raise exception 'Bare administrator kan lukke';
  end if;
  select p.domain into v_from from public.shop_settings s left join public.shop_profiles p on p.id = s.active_profile_id where s.id;
  update public.shop_settings set active_profile_id = null, confirmed_domain = null, live_until = null,
    read_only = true, changed_at = now(), changed_by = p_user where id;
  insert into public.shop_switch_log (user_id, action, from_domain, to_domain, read_only)
    values (p_user, 'close', v_from, 'testbutikk (hemmeligheter)', true);
end $$;

revoke all on function public.shop_secret_set(uuid, text, uuid)            from public, anon, authenticated;
revoke all on function public.shop_secret_get(uuid)                        from public, anon, authenticated;
revoke all on function public.shop_switch(uuid, text, timestamptz, uuid)   from public, anon, authenticated;
revoke all on function public.shop_close(uuid)                             from public, anon, authenticated;
grant execute on function public.shop_secret_set(uuid, text, uuid)          to service_role;
grant execute on function public.shop_secret_get(uuid)                      to service_role;
grant execute on function public.shop_switch(uuid, text, timestamptz, uuid) to service_role;
grant execute on function public.shop_close(uuid)                           to service_role;

-- Administrator settes for seg (ikke i git, repoet er offentlig):
--   update public.shop_settings set admin_user_id = '<din bruker-id>' where id;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Slett først Vault-hemmelighetene: delete from vault.secrets where name like 'shopify_client_secret_%';
-- drop function if exists public.shop_close(uuid);
-- drop function if exists public.shop_switch(uuid, text, timestamptz, uuid);
-- drop function if exists public.shop_secret_get(uuid);
-- drop function if exists public.shop_secret_set(uuid, text, uuid);
-- drop table if exists public.shop_switch_log;
-- drop table if exists public.shop_settings;
-- drop table if exists public.shop_profiles;
