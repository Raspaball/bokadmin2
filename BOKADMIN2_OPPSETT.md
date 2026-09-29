# Bokadmin 2.0 — oppsett og sikkerhetsregler

Opprettet 2026-09-29 som kopi av Bokadmin slik den kjørte i drift (branch `utvikling`, commit 4a8aa33, pluss ukommitterte endringer i `supabase/functions/shopify/index.ts` og migrasjonen `20260922000000_revert_to_single_tenant_rls.sql`).

**Dagens Bokadmin (C:\Bokadmin, bokadmin.vercel.app, live-prosjektet i Supabase, livebutikken) skal ikke røres fra dette prosjektet.** Live-prosjektets ID står i `C:\Bokadmin\.env`, ikke i dette repoet.

## Hva som er separert

| Del | Bokadmin (live) | Bokadmin 2.0 |
|---|---|---|
| Mappe | C:\Bokadmin | C:\Bokadmin 2.0 |
| Git-branch | `utvikling` / `master` | `main` (i Raspaball/bokadmin2) |
| GitHub | Raspaball/bokadmin, privat | Raspaball/bokadmin2, **offentlig** (remote `origin`) |
| Git-historikk | Full historikk | Starter på nytt fra én commit. Full historikk ligger i live-repoet |
| Supabase | Live-prosjektet | «Bokadmin 2.0», ref `chwpqwblqummlufqdefe` (eu-west-1) |
| Vercel | prosjekt `bokadmin` | Nytt prosjekt — ikke opprettet ennå |
| Shopify | Livebutikken | Kun Test-butikken |
| `.env` / hemmeligheter | Egen | Ikke kopiert. Lag ny fra `.env.example` med 2.0-verdier |

## Opprydding som er gjort

1. pg_cron-migrasjonene (`20260213000001_pgcron.sql`, `20260221000000_pgcron_availability.sql`, `20260226000002_pgcron_scheduled_tasks_with_userid.sql`) inneholdt live-prosjektets URL og anon-nøkkel. De leser nå begge fra Supabase Vault. Opprett hemmelighetene i 2.0-prosjektet **før** migrasjonene kjøres:
   ```sql
   SELECT vault.create_secret('https://<2.0-project-ref>.supabase.co', 'project_url');
   SELECT vault.create_secret('<2.0 anon key>', 'anon_key');
   ```
2. `utils/supabase/info.tsx` og `supabase/functions/server/` (gammel `make-server`) pekte på live-prosjektet og ble ikke brukt. Begge er slettet.

## Regler

1. Repoet er offentlig: commit aldri `.env`, tokens, nøkler eller live-prosjektets ID/URL.
2. Kjør aldri `supabase link` mot live-prosjektet fra denne mappa. `supabase/.temp/` er git-ignorert.
3. Edge Function-hemmeligheter (`SHOPIFY_*`, `BOKBASEN_*`) settes kun i 2.0-prosjektet, med Test-butikkens nøkler.
