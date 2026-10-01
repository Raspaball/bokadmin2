import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { priceApprovals, userSettings, type PriceApproval } from '../utils/api';

// Sperre mot store prishopp: prisjobben (oppdateringsmodus) og push setter ikke
// en ny pris som avviker mer enn grensen fra den gamle. Endringene havner her
// og må godkjennes. Regelen: supabase/functions/_shared/price-guard.ts.

const DEFAULT_MAX_PCT = 30;

const fmtPrice = (n: number | null) => (n === null ? 'mangler' : `${Number(n).toLocaleString('nb-NO')} kr`);
const fmtPct = (n: number | null) => (n === null ? '–' : `${Number(n).toLocaleString('nb-NO', { maximumFractionDigits: 1 })} %`);

export function PrisGodkjenning() {
  const [pending, setPending] = useState<PriceApproval[]>([]);
  const [decided, setDecided] = useState<PriceApproval[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [maxPct, setMaxPct] = useState<string>(String(DEFAULT_MAX_PCT));
  const [savingPct, setSavingPct] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [p, d] = await Promise.all([priceApprovals.listPending(), priceApprovals.listDecided(10)]);
      setPending(p);
      setDecided(d);
      setSelected(prev => new Set([...prev].filter(id => p.some(a => a.id === id))));
    } catch (e) {
      toast.error('Kunne ikke hente godkjenningslisten: ' + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    userSettings.get().then(s => {
      if (s?.max_price_change_pct) setMaxPct(String(s.max_price_change_pct));
    });
  }, []);

  const decide = async (ids: string[], decision: 'approve' | 'reject') => {
    if (!ids.length) return;
    const verb = decision === 'approve' ? 'Godkjenne' : 'Avvise';
    if (!confirm(`${verb} ${ids.length} prisendring${ids.length === 1 ? '' : 'er'}?${decision === 'approve' ? ' Ny pris settes i Shopify.' : ' Prisen i Shopify endres ikke.'}`)) return;
    setBusy(true);
    try {
      const results = await priceApprovals.decide(ids, decision);
      const ok = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok);
      if (ok) toast.success(`${ok} ${decision === 'approve' ? 'godkjent' : 'avvist'}`);
      for (const f of failed.slice(0, 5)) toast.error(f.error ?? 'Feilet');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const savePct = async () => {
    const n = parseFloat(maxPct.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('Grensen må være et tall over 0');
      return;
    }
    setSavingPct(true);
    try {
      await userSettings.save({ max_price_change_pct: n });
      toast.success(`Grense lagret: ${n} %`);
    } catch (e) {
      toast.error('Kunne ikke lagre: ' + (e as Error).message);
    } finally {
      setSavingPct(false);
    }
  };

  const allSelected = pending.length > 0 && selected.size === pending.length;
  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="size-5 text-amber-600" />
              Priser som krever godkjenning
              {pending.length > 0 && (
                <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">{pending.length}</span>
              )}
            </CardTitle>
            <CardDescription>
              Prisjobben og push endrer ikke en pris som avviker mer enn grensen fra dagens pris. Mangler dagens pris, eller er den 0, settes den nye uten godkjenning.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-2">
          <div>
            <Label htmlFor="max-price-change-pct" className="text-xs">Største prisendring uten godkjenning (%)</Label>
            <Input
              id="max-price-change-pct"
              className="w-24 h-8"
              inputMode="decimal"
              value={maxPct}
              onChange={e => setMaxPct(e.target.value)}
            />
          </div>
          <Button size="sm" variant="outline" onClick={savePct} disabled={savingPct}>
            {savingPct ? <Loader2 className="size-3 animate-spin" /> : 'Lagre'}
          </Button>
        </div>

        {pending.length === 0 ? (
          <p className="text-sm text-gray-500">Ingen prisendringer venter på godkjenning.</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Checkbox
                id="select-all-approvals"
                checked={allSelected}
                onCheckedChange={v => setSelected(v === true ? new Set(pending.map(p => p.id)) : new Set())}
              />
              <Label htmlFor="select-all-approvals" className="text-sm">Velg alle</Label>
              <div className="flex-1" />
              <Button size="sm" onClick={() => decide([...selected], 'approve')} disabled={busy || selected.size === 0}>
                <CheckCircle2 className="size-3 mr-1" />
                Godkjenn valgte ({selected.size})
              </Button>
              <Button size="sm" variant="outline" onClick={() => decide([...selected], 'reject')} disabled={busy || selected.size === 0}>
                <XCircle className="size-3 mr-1" />
                Avvis valgte
              </Button>
            </div>
            <div className="border rounded-lg divide-y max-h-[400px] overflow-y-auto">
              {pending.map(a => (
                <div key={a.id} className="p-2 flex items-center gap-3 text-sm">
                  <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggle(a.id)} />
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium">{a.title ?? a.isbn}</p>
                    <p className="text-xs text-gray-500">
                      <span className="font-mono">{a.isbn}</span>
                      {' · '}{a.source === 'push' ? 'push' : 'prisjobb'}
                      {' · '}{new Date(a.updated_at).toLocaleString('nb-NO')}
                    </p>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <p>{fmtPrice(a.old_price)} → <strong>{fmtPrice(a.new_price)}</strong></p>
                    <p className="text-xs text-amber-700">{fmtPct(a.change_pct)}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => decide([a.id], 'approve')} disabled={busy}>Godkjenn</Button>
                  <Button size="sm" variant="ghost" onClick={() => decide([a.id], 'reject')} disabled={busy}>Avvis</Button>
                </div>
              ))}
            </div>
          </>
        )}

        {decided.length > 0 && (
          <div>
            <p className="text-xs font-medium text-gray-500 mb-1">Sist behandlet</p>
            <div className="text-xs text-gray-600 space-y-0.5">
              {decided.map(a => (
                <p key={a.id}>
                  {a.status === 'approved' ? '✓' : '✗'} {a.title ?? a.isbn}: {a.decision_note}
                  {a.decided_at && ` (${new Date(a.decided_at).toLocaleString('nb-NO')})`}
                </p>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
