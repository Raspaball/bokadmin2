import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import {
  BookOpen, Store, CheckCircle2, ArrowRight, Loader2, AlertCircle, ExternalLink
} from 'lucide-react';
import { userSettings, supabase } from '../utils/api';

interface Props {
  onComplete: () => void;
}

type Step = 1 | 2 | 3 | 4;

export function OnboardingWizard({ onComplete }: Props) {
  const [step, setStep] = useState<Step>(1);

  // Shopify fields
  const [shopDomain, setShopDomain] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [testError, setTestError] = useState('');
  const [shopName, setShopName] = useState('');

  // Bokbasen fields
  const [useGlobalBokbasen, setUseGlobalBokbasen] = useState(true);
  const [bokbasenClientId, setBokbasenClientId] = useState('');
  const [bokbasenClientSecret, setBokbasenClientSecret] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Normalize domain: strip https:// and trailing slashes
  const normalizeDomain = (d: string) =>
    d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  const handleTestShopify = async () => {
    const domain = normalizeDomain(shopDomain);
    if (!domain || !accessToken.trim()) return;

    setTestStatus('loading');
    setTestError('');
    setShopName('');

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
        body: JSON.stringify({ shopDomain: domain, accessToken: accessToken.trim() }),
      });

      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Ukjent feil');
      setShopName(data.shopName ?? domain);
      setTestStatus('ok');
    } catch (e) {
      setTestError((e as Error).message);
      setTestStatus('error');
    }
  };

  const handleSaveShopify = async () => {
    if (testStatus !== 'ok') return;
    setSaving(true);
    setSaveError('');
    try {
      await userSettings.save({
        shopify_shop_domain: normalizeDomain(shopDomain),
        shopify_access_token: accessToken.trim(),
        shopify_shop_name: shopName || null,
      });
      setStep(3);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBokbasen = async () => {
    setSaving(true);
    setSaveError('');
    try {
      if (!useGlobalBokbasen) {
        await userSettings.save({
          bokbasen_client_id: bokbasenClientId.trim() || null,
          bokbasen_client_secret: bokbasenClientSecret.trim() || null,
        });
      }
      setStep(4);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleComplete = async () => {
    setSaving(true);
    try {
      await userSettings.completeSetup();
      onComplete();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Step indicator
  const steps = [
    { n: 1, label: 'Velkommen' },
    { n: 2, label: 'Shopify' },
    { n: 3, label: 'Bokbasen' },
    { n: 4, label: 'Ferdig' },
  ];

  return (
    <div className="size-full flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-lg space-y-6">

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2">
          {steps.map((s, i) => (
            <div key={s.n} className="flex items-center gap-2">
              <div className={`
                flex items-center justify-center size-8 rounded-full text-sm font-medium
                ${step > s.n ? 'bg-green-500 text-white' : step === s.n ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}
              `}>
                {step > s.n ? <CheckCircle2 className="size-4" /> : s.n}
              </div>
              <span className={`text-sm hidden sm:block ${step === s.n ? 'text-gray-900 font-medium' : 'text-gray-400'}`}>
                {s.label}
              </span>
              {i < steps.length - 1 && (
                <div className={`w-8 h-px ${step > s.n ? 'bg-green-400' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>

        {/* ── Steg 1: Velkommen ── */}
        {step === 1 && (
          <Card>
            <CardHeader className="text-center">
              <div className="flex justify-center mb-3">
                <BookOpen className="size-12 text-blue-600" />
              </div>
              <CardTitle className="text-2xl">Velkommen til Bokadmin</CardTitle>
              <CardDescription className="text-base">
                Vi trenger å koble systemet til din Shopify-butikk. Det tar ca. 2 minutter.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900 space-y-1">
                <p className="font-medium">Du trenger:</p>
                <ul className="list-disc list-inside space-y-1 text-blue-800">
                  <li>Shopify-butikkens domene (xxx.myshopify.com)</li>
                  <li>Et Admin API Access Token fra Shopify</li>
                </ul>
              </div>
              <Button className="w-full" onClick={() => setStep(2)}>
                Kom i gang
                <ArrowRight className="size-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* ── Steg 2: Shopify ── */}
        {step === 2 && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 mb-1">
                <Store className="size-5 text-blue-600" />
                <CardTitle>Koble til Shopify</CardTitle>
              </div>
              <CardDescription>
                Opprett en Custom App i Shopify-adminpanelet og lim inn informasjonen under.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">

              {/* Instruksjon */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 space-y-2">
                <p className="font-medium text-gray-900">Slik finner du Access Token:</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Gå til <strong>Shopify Admin → Settings → Apps and sales channels</strong></li>
                  <li>Klikk <strong>Develop apps</strong> → <strong>Create an app</strong></li>
                  <li>Under <strong>Configuration</strong> → Admin API scopes, gi tilgang til: <br />
                    <code className="bg-gray-100 px-1 rounded">read/write_products, read/write_inventory, read/write_metafields, read/write_publications, read/write_content</code>
                  </li>
                  <li>Klikk <strong>Install app</strong> → kopier Access Token</li>
                </ol>
                <a
                  href="https://help.shopify.com/en/manual/apps/app-types/custom-apps"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-blue-600 hover:underline mt-1"
                >
                  <ExternalLink className="size-3" />
                  Shopify-dokumentasjon om Custom Apps
                </a>
              </div>

              <div className="space-y-2">
                <Label htmlFor="shop-domain">Butikkdomene</Label>
                <Input
                  id="shop-domain"
                  placeholder="din-butikk.myshopify.com"
                  value={shopDomain}
                  onChange={e => { setShopDomain(e.target.value); setTestStatus('idle'); }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="access-token">Admin API Access Token</Label>
                <Input
                  id="access-token"
                  type="password"
                  placeholder="shpat_xxxx... eller xxxx... (32 hex-tegn)"
                  value={accessToken}
                  onChange={e => { setAccessToken(e.target.value); setTestStatus('idle'); }}
                />
              </div>

              {/* Test-status */}
              {testStatus === 'ok' && (
                <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm">
                  <CheckCircle2 className="size-4 flex-shrink-0" />
                  Tilkobling bekreftet! Butikk: <strong>{shopName}</strong>
                </div>
              )}
              {testStatus === 'error' && (
                <div className="flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm">
                  <AlertCircle className="size-4 flex-shrink-0 mt-0.5" />
                  <span>{testError || 'Kunne ikke koble til Shopify. Sjekk domene og token.'}</span>
                </div>
              )}
              {saveError && (
                <p className="text-sm text-red-600">{saveError}</p>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={handleTestShopify}
                  disabled={!shopDomain || !accessToken || testStatus === 'loading'}
                  className="flex-1"
                >
                  {testStatus === 'loading' && <Loader2 className="size-4 mr-2 animate-spin" />}
                  Test tilkobling
                </Button>
                <Button
                  onClick={handleSaveShopify}
                  disabled={testStatus !== 'ok' || saving}
                  className="flex-1"
                >
                  {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
                  Neste
                  <ArrowRight className="size-4 ml-2" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Steg 3: Bokbasen ── */}
        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Bokbasen-tilkobling</CardTitle>
              <CardDescription>
                Bokbasen er den norske metadatadatabasen for bøker. De fleste bruker et delt abonnement.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">

              <div className="flex items-start gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50"
                onClick={() => setUseGlobalBokbasen(true)}>
                <input
                  type="radio"
                  checked={useGlobalBokbasen}
                  onChange={() => setUseGlobalBokbasen(true)}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">Bruk delt Bokbasen-abonnement</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Anbefalt for de fleste. Bruker systemets felles tilgang til Bokbasen.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50"
                onClick={() => setUseGlobalBokbasen(false)}>
                <input
                  type="radio"
                  checked={!useGlobalBokbasen}
                  onChange={() => setUseGlobalBokbasen(false)}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">Bruk eget Bokbasen-abonnement</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Velg dette hvis du har egne Bokbasen-credentials.
                  </p>
                </div>
              </div>

              {!useGlobalBokbasen && (
                <div className="space-y-3 pl-4 border-l-2 border-gray-200">
                  <div className="space-y-2">
                    <Label htmlFor="bb-client-id">Client ID</Label>
                    <Input
                      id="bb-client-id"
                      placeholder="din-client-id"
                      value={bokbasenClientId}
                      onChange={e => setBokbasenClientId(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bb-client-secret">Client Secret</Label>
                    <Input
                      id="bb-client-secret"
                      type="password"
                      placeholder="din-client-secret"
                      value={bokbasenClientSecret}
                      onChange={e => setBokbasenClientSecret(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {saveError && <p className="text-sm text-red-600">{saveError}</p>}

              <Button className="w-full" onClick={handleSaveBokbasen} disabled={saving}>
                {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
                Neste
                <ArrowRight className="size-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* ── Steg 4: Ferdig ── */}
        {step === 4 && (
          <Card>
            <CardHeader className="text-center">
              <div className="flex justify-center mb-3">
                <CheckCircle2 className="size-12 text-green-500" />
              </div>
              <CardTitle className="text-2xl">Alt er klart!</CardTitle>
              <CardDescription className="text-base">
                Bokadmin er koblet til din Shopify-butikk og klar til bruk.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-900">
                <p className="font-medium mb-1">Du kan nå:</p>
                <ul className="list-disc list-inside space-y-1 text-green-800">
                  <li>Slå opp bøker via ISBN fra Bokbasen</li>
                  <li>Pushe produkter direkte til Shopify</li>
                  <li>Importere og synkronisere bokkatalogen din</li>
                </ul>
              </div>
              {saveError && <p className="text-sm text-red-600">{saveError}</p>}
              <Button className="w-full" onClick={handleComplete} disabled={saving}>
                {saving
                  ? <><Loader2 className="size-4 mr-2 animate-spin" />Lagrer...</>
                  : 'Start Bokadmin →'}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
