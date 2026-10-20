-- Live uten tidsgrense (besluttet av Eirik 20.10.2026: testingen er ferdig). Kjørt 20.10.2026 via Supabase MCP, versjon 20261020094116.
-- shop_switch(): «åpen til» er valgfritt for live. Null = uten tidsgrense; satt = må være fram i tid.
-- Ingen andre regler endres: bekreftet domene, ingen aktive jobber, administrator, og bytte setter
-- alltid skrivesperren (read_only) på. Samme regel i checkShopAllowed() i _shared/shop-guard.js.
-- Bare funksjonen byttes; ingen data endres.

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
  if v_live and p_until is not null and p_until <= now() then
    raise exception '«Åpen til» må være fram i tid (tom = uten tidsgrense)';
  end if;

  update public.shop_settings set active_profile_id = p.id, confirmed_domain = lower(trim(p_confirm)),
    live_until = case when v_live then p_until end, read_only = true,
    changed_at = now(), changed_by = p_user where id;
  insert into public.shop_switch_log (user_id, action, from_domain, to_domain, live_until, read_only)
    values (p_user, 'switch', v_from, p.domain, case when v_live then p_until end, true);
end $$;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Kjør shop_switch-blokken fra 20261008151207_shop_profiles.sql på nytt (24-timersregelen).
