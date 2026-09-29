import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { CheckCircle2, AlertCircle, Loader2, Store, BookOpen, Database, KeyRound, Activity, XCircle } from 'lucide-react';
import { userSettings, supabase, jobs, jobTypeLabel, type UserSettings, type Job } from '../utils/api';

export function Innstillinger() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);

  // Shopify — styres av serveren (Dev Dashboard-app, Supabase-hemmeligheter)
  const [testStatus, setTestStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [testError, setTestError] = useState('');
  const [shopInfo, setShopInfo] = useState<{ name: string; domain: string; productsCount: number } | null>(null);

  // Bokbasen fields
  const [bokbasenClientId, setBokbasenClientId] = useState('');
  const [bokbasenClientSecret, setBokbasenClientSecret] = useState('');
  const [savingBokbasen, setSavingBokbasen] = useState(false);
  const [bokbasenSaved, setBokbasenSaved] = useState(false);

  // Change password
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [passwordError, setPasswordError] = useState('');

  const handleChangePassword = async () => {
    if (newPassword.length < 6) {
      setPasswordError('Passordet må være minst 6 tegn.');
      setPasswordStatus('error');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passordene stemmer ikke overens.');
      setPasswordStatus('error');
      return;
    }
    setSavingPassword(true);
    setPasswordStatus('idle');
    setPasswordError('');
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setPasswordStatus('ok');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e) {
      setPasswordError((e as Error).message);
      setPasswordStatus('error');
    } finally {
      setSavingPassword(false);
    }
  };

  // Active jobs
  const [activeJobs, setActiveJobs] = useState<Job[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [killingJobs, setKillingJobs] = useState(false);

  const loadJobs = async () => {
    try {
      const data = await jobs.getActive();
      setActiveJobs(data);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleCancelJob = async (jobId: string) => {
    setLoadingJobs(true);
    try {
      await jobs.cancelOne(jobId);
      await loadJobs();
    } catch { /* ignore */ } finally {
      setLoadingJobs(false);
    }
  };

  const handleKillAll = async () => {
    if (!confirm(`Avbryte alle ${activeJobs.length} pågående jobber?`)) return;
    setKillingJobs(true);
    try {
      await jobs.cancelAll();
      await loadJobs();
    } catch { /* ignore */ } finally {
      setKillingJobs(false);
    }
  };

  // Claim legacy data
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [claimError, setClaimError] = useState('');

  useEffect(() => {
    userSettings.get().then(s => {
      setSettings(s);
      if (s) {
        setBokbasenClientId(s.bokbasen_client_id ?? '');
      }
      setLoading(false);
    });
  }, []);

  const handleTestShopify = async () => {
    setTestStatus('loading');
    setTestError('');
    setShopInfo(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

      const res = await fetch(`${supabaseUrl}/functions/v1/shopify/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token ?? supabaseKey}`,
          apikey: supabaseKey,
        },
        body: JSON.stringify({}),
      });

      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Ukjent feil');
      setShopInfo({ name: data.shopName, domain: data.shopDomain, productsCount: data.productsCount });
      setTestStatus('ok');
      // Lagre kun navn og domene (ingen nøkler) slik at sidemenyen viser butikken
      if (data.shopDomain && data.shopDomain !== settings?.shopify_shop_domain) {
        setSettings(await userSettings.save({
          shopify_shop_domain: data.shopDomain,
          shopify_shop_name: data.shopName ?? null,
        }));
      }
    } catch (e) {
      setTestError((e as Error).message);
      setTestStatus('error');
    }
  };

  const handleSaveBokbasen = async () => {
    setSavingBokbasen(true);
    setBokbasenSaved(false);
    try {
      await userSettings.save({
        bokbasen_client_id: bokbasenClientId.trim() || null,
        bokbasen_client_secret: bokbasenClientSecret.trim() || null,
      });
      setBokbasenSaved(true);
      setBokbasenClientSecret('');
    } catch {
      // ignore
    } finally {
      setSavingBokbasen(false);
    }
  };

  const handleClaimLegacy = async () => {
    setClaiming(true);
    setClaimError('');
    try {
      await userSettings.claimLegacyData();
      setClaimed(true);
    } catch (e) {
      setClaimError((e as Error).message);
    } finally {
      setClaiming(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const JOB_STATUS: Record<string, { label: string; className: string }> = {
    running: { label: 'Kjører', className: 'bg-green-100 text-green-800' },
    paused:  { label: 'Pauset', className: 'bg-yellow-100 text-yellow-800' },
    pending: { label: 'Venter', className: 'bg-gray-100 text-gray-700' },
  };

  return (
    <div className="space-y-6">

      {/* ── Active jobs ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="size-5 text-blue-600" />
              <CardTitle>Pågående jobber</CardTitle>
            </div>
            {activeJobs.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleKillAll}
                disabled={killingJobs}
              >
                {killingJobs
                  ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                  : <XCircle className="size-3.5 mr-1.5" />}
                Drep alle ({activeJobs.length})
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {activeJobs.length === 0 ? (
            <p className="text-sm text-gray-400">Ingen pågående jobber.</p>
          ) : (
            <div className="space-y-2">
              {activeJobs.map(job => {
                const statusInfo = JOB_STATUS[job.status] ?? { label: job.status, className: 'bg-gray-100 text-gray-700' };
                const progress = job.total_items > 0
                  ? Math.min(100, Math.round((job.processed / job.total_items) * 100))
                  : null;
                return (
                  <div key={job.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-800">{jobTypeLabel(job.type)}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${statusInfo.className}`}>
                          {statusInfo.label}
                        </span>
                        {progress !== null && (
                          <span className="text-xs text-gray-500">{progress}%</span>
                        )}
                        {job.current_isbn && (
                          <span className="text-xs text-gray-400 font-mono truncate">{job.current_isbn}</span>
                        )}
                      </div>
                      {progress !== null && (
                        <div className="mt-1.5 bg-gray-200 rounded-full h-1.5">
                          <div className="bg-blue-500 rounded-full h-1.5 transition-all" style={{ width: `${progress}%` }} />
                        </div>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 flex-shrink-0"
                      disabled={loadingJobs}
                      onClick={() => handleCancelJob(job.id)}
                    >
                      <XCircle className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Shopify ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Store className="size-5 text-blue-600" />
            <CardTitle>Shopify-tilkobling</CardTitle>
          </div>
          <CardDescription>
            {settings?.shopify_shop_domain
              ? <>Koblet til: <strong>{settings.shopify_shop_domain}</strong></>
              : 'Test tilkoblingen for å se hvilken butikk serveren er koblet til.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">
            Shopify styres av serveren. Bokadmin bruker en Shopify-app fra Dev Dashboard, og
            butikkdomene og app-nøkler settes som Supabase-hemmeligheter
            (<code>SHOPIFY_SHOP_DOMAIN</code>, <code>SHOPIFY_CLIENT_ID</code>, <code>SHOPIFY_CLIENT_SECRET</code>).
            Tilgangsnøkkelen fornyes automatisk.
          </p>

          {testStatus === 'ok' && shopInfo && (
            <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm">
              <CheckCircle2 className="size-4 flex-shrink-0" />
              <span>
                Tilkobling bekreftet! Butikk: <strong>{shopInfo.name}</strong> ({shopInfo.domain}),{' '}
                {shopInfo.productsCount} produkter
              </span>
            </div>
          )}
          {testStatus === 'error' && (
            <div className="flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm">
              <AlertCircle className="size-4 flex-shrink-0 mt-0.5" />
              <span>{testError}</span>
            </div>
          )}
          <Button
            variant="outline"
            onClick={handleTestShopify}
            disabled={testStatus === 'loading'}
          >
            {testStatus === 'loading' && <Loader2 className="size-4 mr-2 animate-spin" />}
            Test tilkobling
          </Button>
        </CardContent>
      </Card>

      {/* ── Bokbasen ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <BookOpen className="size-5 text-blue-600" />
            <CardTitle>Bokbasen-tilkobling</CardTitle>
          </div>
          <CardDescription>
            La feltene stå tomme for å bruke systemets delte Bokbasen-abonnement.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bb-client-id">Client ID (valgfritt)</Label>
            <Input
              id="bb-client-id"
              placeholder="La stå tomt for å bruke delt abonnement"
              value={bokbasenClientId}
              onChange={e => setBokbasenClientId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bb-client-secret">Client Secret (valgfritt)</Label>
            <Input
              id="bb-client-secret"
              type="password"
              placeholder="La stå tomt for å bruke delt abonnement"
              value={bokbasenClientSecret}
              onChange={e => setBokbasenClientSecret(e.target.value)}
            />
          </div>
          {bokbasenSaved && (
            <p className="text-sm text-green-600 flex items-center gap-1">
              <CheckCircle2 className="size-4" /> Bokbasen-innstillinger lagret.
            </p>
          )}
          <Button onClick={handleSaveBokbasen} disabled={savingBokbasen}>
            {savingBokbasen && <Loader2 className="size-4 mr-2 animate-spin" />}
            Lagre Bokbasen-innstillinger
          </Button>
        </CardContent>
      </Card>

      {/* ── Change password ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="size-5 text-blue-600" />
            <CardTitle>Endre passord</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">Nytt passord</Label>
            <Input
              id="new-password"
              type="password"
              placeholder="Minst 6 tegn"
              value={newPassword}
              onChange={e => { setNewPassword(e.target.value); setPasswordStatus('idle'); }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Bekreft nytt passord</Label>
            <Input
              id="confirm-password"
              type="password"
              placeholder="Gjenta passordet"
              value={confirmPassword}
              onChange={e => { setConfirmPassword(e.target.value); setPasswordStatus('idle'); }}
            />
          </div>
          {passwordStatus === 'ok' && (
            <p className="text-sm text-green-600 flex items-center gap-1">
              <CheckCircle2 className="size-4" /> Passordet er oppdatert.
            </p>
          )}
          {passwordStatus === 'error' && (
            <div className="flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm">
              <AlertCircle className="size-4 flex-shrink-0 mt-0.5" />
              <span>{passwordError}</span>
            </div>
          )}
          <Button onClick={handleChangePassword} disabled={savingPassword || !newPassword}>
            {savingPassword && <Loader2 className="size-4 mr-2 animate-spin" />}
            Endre passord
          </Button>
        </CardContent>
      </Card>

      {/* ── Claim legacy data ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="size-5 text-blue-600" />
            <CardTitle>Koble eksisterende data</CardTitle>
          </div>
          <CardDescription>
            Hvis du hadde bøker i systemet før multi-bruker-støtte ble aktivert, kan du koble dem til din bruker her.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {claimed ? (
            <p className="text-sm text-green-600 flex items-center gap-1">
              <CheckCircle2 className="size-4" /> Eksisterende data er koblet til din bruker.
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                Dette tilordner alle bøker og loggoppføringer uten brukertilknytning til din bruker.
                Kan kun gjøres én gang per bruker.
              </p>
              {claimError && (
                <p className="text-sm text-red-600">{claimError}</p>
              )}
              <Button variant="outline" onClick={handleClaimLegacy} disabled={claiming}>
                {claiming && <Loader2 className="size-4 mr-2 animate-spin" />}
                Koble eksisterende data til min bruker
              </Button>
            </>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
