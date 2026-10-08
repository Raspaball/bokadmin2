// Butikker i Innstillinger (live-sjekk 1, Del 2).
// Profiler for Testbutikk og livebutikken: domene, Client ID og Client secret (bare skrivbar,
// lagres i Vault på serveren og vises aldri igjen). «Test tilkobling» leser bare.
// Bytte krever at ingen jobb kjører, at domenet skrives som bekreftelse og, for live,
// «åpen til» høyst 24 timer fram. Skrivesperren mot live er alltid på herfra.
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { AlertCircle, CheckCircle2, Loader2, Lock, ShieldAlert, Store } from 'lucide-react';
import { shops, type ShopProfile, type ShopsState, type ShopTestResult } from '../utils/api';

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' }) : '';

/** Standard «åpen til»: om 6 timer, som verdi for <input type="datetime-local"> */
function defaultUntil(hours = 6): string {
  const d = new Date(Date.now() + hours * 3600e3);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
}

function ProfileForm({ profile, onSaved, disabled }: { profile?: ShopProfile; onSaved: () => void; disabled?: boolean }) {
  const [name, setName] = useState(profile?.name ?? '');
  const [domain, setDomain] = useState(profile?.domain ?? '');
  const [clientId, setClientId] = useState(profile?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await shops.save({ id: profile?.id, name, domain, clientId });
      if (secret.trim()) {
        await shops.saveSecret(r.id, secret);
        setSecret('');
      }
      setMsg({ ok: true, text: 'Lagret.' });
      if (!profile) { setName(''); setDomain(''); setClientId(''); }
      onSaved();
    } catch (e) {
      setSecret('');
      setMsg({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label>Navn</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Live" disabled={disabled} />
      </div>
      <div className="space-y-1">
        <Label>Domene (myshopify.com)</Label>
        <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="navn.myshopify.com" disabled={disabled} autoComplete="off" />
      </div>
      <div className="space-y-1">
        <Label>Client ID</Label>
        <Input value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={disabled} autoComplete="off" />
      </div>
      <div className="space-y-1">
        <Label>Client secret {profile?.secretSaved && <span className="text-green-700 font-normal">(lagret)</span>}</Label>
        <Input
          type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
          placeholder={profile?.secretSaved ? 'Lagret. Skriv ny for å bytte' : 'Lim inn'}
          autoComplete="new-password" disabled={disabled}
        />
      </div>
      <div className="sm:col-span-2 flex items-center gap-3">
        <Button onClick={save} disabled={busy || disabled || !name || !domain || !clientId}>
          {busy && <Loader2 className="size-4 mr-2 animate-spin" />}{profile ? 'Lagre endringer' : 'Legg til butikk'}
        </Button>
        {msg && <span className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

export function Butikker() {
  const [state, setState] = useState<ShopsState | null>(null);
  const [error, setError] = useState('');
  const [tests, setTests] = useState<Record<string, ShopTestResult | 'loading'>>({});
  const [switchFor, setSwitchFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [until, setUntil] = useState(defaultUntil());
  const [busy, setBusy] = useState(false);
  const [switchMsg, setSwitchMsg] = useState('');

  const load = async () => {
    try { setState(await shops.state()); setError(''); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: 'loading' }));
    try { const r = await shops.test(id); setTests((t) => ({ ...t, [id]: r })); }
    catch (e) { setTests((t) => ({ ...t, [id]: { ok: false, error: (e as Error).message } })); }
    load();
  };

  const doSwitch = async (p: ShopProfile | null) => {
    setBusy(true); setSwitchMsg('');
    try {
      const untilIso = p?.live ? new Date(until).toISOString() : null;
      await shops.switchTo(p?.id ?? null, p ? confirm : '', untilIso);
      setSwitchFor(null); setConfirm('');
      await load();
    } catch (e) { setSwitchMsg((e as Error).message); } finally { setBusy(false); }
  };

  const close = async () => {
    setBusy(true);
    try { await shops.close(); await load(); } catch (e) { setSwitchMsg((e as Error).message); } finally { setBusy(false); }
  };

  if (error && !state) {
    return (
      <Card><CardHeader><CardTitle>Butikker</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-red-700">{error}</p></CardContent></Card>
    );
  }
  if (!state) return <Card><CardContent className="py-6"><Loader2 className="size-5 animate-spin" /></CardContent></Card>;

  const active = state.active;
  const jobsBusy = state.activeJobs.length > 0;

  return (
    <Card className={active?.live ? 'border-red-500 border-2' : ''}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Store className="size-5 text-blue-600" />
          <CardTitle>Butikker</CardTitle>
        </div>
        <CardDescription>
          Hvilken Shopify-butikk Bokadmin jobber mot. Bare én er aktiv om gangen.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Aktiv butikk */}
        <div className={`rounded-lg px-4 py-3 text-sm ${active?.live ? 'bg-red-600 text-white' : 'bg-green-50 border border-green-200 text-green-900'}`}>
          {active ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="font-semibold">{active.live ? 'LIVE' : 'Aktiv'}: {active.profileName ?? 'Testbutikk (hemmeligheter)'} – {active.domain}</span>
              {active.live && <span>Åpen til {fmt(active.until)}</span>}
              {active.live && <span className="flex items-center gap-1"><Lock className="size-4" />{active.readOnly ? 'Bare lesing (skrivesperre på)' : 'SKRIVING TILLATT'}</span>}
              {active.live && (
                <Button size="sm" variant="secondary" onClick={close} disabled={busy}>Lukk live</Button>
              )}
            </div>
          ) : (
            <span className="text-red-700">{state.activeError ?? 'Ukjent aktiv butikk'}</span>
          )}
        </div>
        {state.activeError && active && <p className="text-sm text-red-700">{state.activeError}</p>}
        {jobsBusy && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            {state.activeJobs.length} jobb(er) kjører eller står på pause. Bytte av butikk er sperret til de er ferdige eller avbrutt.
          </p>
        )}

        {/* Profiler */}
        {state.profiles.map((p) => {
          const isActive = state.activeProfileId === p.id;
          const t = tests[p.id];
          return (
            <div key={p.id} className={`rounded-lg border p-4 space-y-3 ${p.live ? 'border-red-300' : ''}`}>
              <div className="flex flex-wrap items-center gap-2">
                <strong>{p.name}</strong>
                {p.live && <span className="text-xs font-semibold text-white bg-red-600 rounded px-1.5">LIVE</span>}
                {isActive && <span className="text-xs font-semibold text-green-800 bg-green-100 rounded px-1.5">aktiv</span>}
                <span className="text-sm text-gray-500">{p.domain}</span>
              </div>
              <ProfileForm profile={p} onSaved={load} disabled={isActive} />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => test(p.id)} disabled={!p.secretSaved || t === 'loading'}>
                  {t === 'loading' && <Loader2 className="size-4 mr-2 animate-spin" />}Test tilkobling (bare lesing)
                </Button>
                {!isActive && (
                  <Button variant={p.live ? 'destructive' : 'outline'} size="sm" disabled={!p.secretSaved || jobsBusy}
                    onClick={() => { setSwitchFor(p.id); setConfirm(''); setUntil(defaultUntil()); setSwitchMsg(''); }}>
                    Gjør aktiv{p.live ? ' (live)' : ''}
                  </Button>
                )}
              </div>
              {t && t !== 'loading' && (
                t.ok ? (
                  <div className="text-sm text-green-800 bg-green-50 border border-green-200 rounded px-3 py-2 space-y-1">
                    <div className="flex items-center gap-2"><CheckCircle2 className="size-4" />
                      <span><strong>{t.shopName}</strong> ({t.shopDomain}{t.primaryDomain ? `, ${t.primaryDomain}` : ''}): {t.productsCount} produkter, {t.collectionsCount} samlinger</span>
                    </div>
                    <div className="text-xs text-gray-700">Tilganger: {(t.scopes ?? []).join(', ') || '–'}</div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                    <AlertCircle className="size-4 mt-0.5" /><span>{t.error}</span>
                  </div>
                )
              )}
              {switchFor === p.id && (
                <div className={`rounded border p-3 space-y-3 ${p.live ? 'border-red-400 bg-red-50' : 'bg-gray-50'}`}>
                  {p.live && (
                    <p className="text-sm text-red-800 flex items-start gap-2"><ShieldAlert className="size-4 mt-0.5" />
                      Dette er livebutikken. Skrivesperren er på: Bokadmin kan bare lese og kjøre sjekkmodus.</p>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Skriv domenet for å bekrefte</Label>
                      <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={p.domain} autoComplete="off" />
                    </div>
                    {p.live && (
                      <div className="space-y-1">
                        <Label>Åpen til (høyst 24 timer)</Label>
                        <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button variant={p.live ? 'destructive' : 'default'} disabled={busy || confirm.trim().toLowerCase() !== p.domain}
                      onClick={() => doSwitch(p)}>
                      {busy && <Loader2 className="size-4 mr-2 animate-spin" />}Bytt til {p.name}
                    </Button>
                    <Button variant="ghost" onClick={() => setSwitchFor(null)}>Avbryt</Button>
                  </div>
                  {switchMsg && <p className="text-sm text-red-700">{switchMsg}</p>}
                </div>
              )}
            </div>
          );
        })}

        {state.activeProfileId && !active?.live && (
          <Button variant="outline" size="sm" disabled={busy || jobsBusy} onClick={() => doSwitch(null)}>
            Bruk Testbutikk fra hemmelighetene
          </Button>
        )}
        {switchMsg && !switchFor && <p className="text-sm text-red-700">{switchMsg}</p>}

        {/* Ny profil */}
        <div className="rounded-lg border border-dashed p-4 space-y-3">
          <strong className="text-sm">Legg til butikk</strong>
          <ProfileForm onSaved={load} />
        </div>

        {/* Logg */}
        {state.log.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-gray-600">Logg (siste {state.log.length})</summary>
            <ul className="mt-2 space-y-1 text-gray-700">
              {state.log.map((l, i) => (
                <li key={i} className={l.ok ? '' : 'text-red-700'}>
                  {fmt(l.at)} – {l.action}{l.to_domain ? ` → ${l.to_domain}` : ''}{l.live_until ? ` (åpen til ${fmt(l.live_until)})` : ''}{l.message ? `: ${l.message}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

/** Rød stripe øverst når livebutikken er aktiv (App.tsx). */
export function LiveStripe() {
  const [info, setInfo] = useState<{ domain: string; until: string | null; readOnly: boolean } | null>(null);
  useEffect(() => {
    const load = () => shops.state()
      .then((s) => setInfo(s.active?.live ? { domain: s.active.domain, until: s.active.until, readOnly: s.active.readOnly } : null))
      .catch(() => setInfo(null));
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  if (!info) return null;
  return (
    <div className="bg-red-600 text-white text-sm font-semibold px-4 py-1.5 flex flex-wrap gap-x-4">
      <span>LIVE: {info.domain}</span>
      <span>Åpen til {fmt(info.until)}</span>
      <span>{info.readOnly ? 'Bare lesing' : 'SKRIVING TILLATT'}</span>
    </div>
  );
}
