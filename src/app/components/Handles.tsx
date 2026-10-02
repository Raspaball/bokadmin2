import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Progress } from './ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Loader2, Search, Link2, ShieldCheck, ShieldAlert, Undo2, CheckCircle2, AlertCircle, FileText } from 'lucide-react';
import {
  handles, syncLog, isBlockingHandleFlag,
  type HandleAnalyzeResult, type HandleJob, type HandleVerifyResult, type SyncLogEntry, type HandleProtectedKept,
} from '../utils/api';
import { toast } from 'sonner';

const TABLE_LIMIT = 500;

// Endrer handles fra ISBN (/products/9788203461392) til tittel-forfatter-ISBN.
// Planen lages på serveren (supabase/functions/_shared/handle-migration.js),
// utføres som én Shopify bulk-operasjon og logges i sync_log.
export function Handles() {
  const [shop, setShop] = useState<{ shopDomain: string; shopName: string | null; allowed: boolean } | null>(null);
  const [job, setJob] = useState<HandleJob | null>(null);
  const [analysis, setAnalysis] = useState<HandleAnalyzeResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [skipFlagged, setSkipFlagged] = useState(false);
  const [starting, setStarting] = useState(false);
  const [verify, setVerify] = useState<HandleVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [rollback, setRollback] = useState<{ running: boolean; restored: number; failed: number; total: number; errors: string[]; protectedKept?: HandleProtectedKept[] } | null>(null);
  const [logEntries, setLogEntries] = useState<SyncLogEntry[] | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const jobRunning = job?.status === 'running' || job?.status === 'finalizing';

  useEffect(() => {
    loadStatus();
    return () => stopPolling();
  }, []);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const loadStatus = async () => {
    try {
      const s = await handles.status();
      setShop({ shopDomain: s.shopDomain, shopName: s.shopName, allowed: s.allowed });
      setJob(s.job);
      if (s.job && (s.job.status === 'running' || s.job.status === 'finalizing')) startPolling(s.job.id);
    } catch (e) {
      toast.error('Kunne ikke hente status: ' + (e as Error).message);
    }
  };

  const startPolling = (jobId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const s = await handles.status(jobId);
        setJob(s.job);
        if (s.job && s.job.status !== 'running' && s.job.status !== 'finalizing') {
          stopPolling();
          if (s.job.status === 'completed') {
            toast.success(`${s.job.succeeded} handles endret${s.job.failed ? `, ${s.job.failed} feilet` : ''}`);
          } else {
            toast.error('Handle-migreringen feilet: ' + (s.job.error_message || 'ukjent feil'));
          }
          setAnalysis(null);
        }
      } catch { /* prøv igjen ved neste intervall */ }
    }, 3000);
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setVerify(null);
    try {
      const result = await handles.analyze();
      setAnalysis(result);
      setSkipFlagged(false);
    } catch (e) {
      toast.error('Analysen feilet: ' + (e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const blockedCount = analysis?.counts.blocked ?? 0;
  const readyCount = analysis?.counts.ready ?? 0;
  const canMigrate = !!analysis && !!shop?.allowed && !jobRunning && !rollback?.running
    && readyCount > 0 && (blockedCount === 0 || skipFlagged);

  const handleMigrate = async () => {
    if (!analysis || !shop) return;
    const rows = analysis.plan.filter(r => !r.flags.some(isBlockingHandleFlag));
    if (!window.confirm(`Endre handle på ${rows.length} produkter i ${shop.shopName ?? shop.shopDomain} (${shop.shopDomain})?\n\nGamle adresser får 301-videresending til de nye.`)) return;
    setStarting(true);
    try {
      const res = await handles.migrate(rows.map(r => r.id), skipFlagged);
      toast.info(`Startet: ${res.total} produkter${res.skippedBlocked ? `, ${res.skippedBlocked} hoppet over` : ''}`);
      const s = await handles.status(res.jobId);
      setJob(s.job);
      startPolling(res.jobId);
    } catch (e) {
      toast.error('Kunne ikke starte: ' + (e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    try {
      setVerify(await handles.verify());
    } catch (e) {
      toast.error('Kontrollen feilet: ' + (e as Error).message);
    } finally {
      setVerifying(false);
    }
  };

  const handleRollback = async () => {
    if (!shop) return;
    if (!window.confirm(`Angre siste handle-migrering i ${shop.shopName ?? shop.shopDomain}?\n\nVideresendingene fjernes og produktene får tilbake ISBN som handle.`)) return;
    setVerify(null);
    setRollback({ running: true, restored: 0, failed: 0, total: 0, errors: [] });
    let restored = 0;
    let total = 0;
    try {
      let jobId: string | undefined;
      // Én puls er maks ~40 s — fortsett til serveren er ferdig
      while (true) {
        const r = await handles.rollback(jobId);
        if (!jobId) total = r.total; // første puls ser alle som gjenstår
        jobId = r.jobId;
        restored += r.restored;
        setRollback({ running: r.timedOut, restored, failed: r.failed, total, errors: r.errors, protectedKept: r.protectedKept });
        if (!r.timedOut) {
          if (r.failed) toast.error(`${r.failed} kunne ikke settes tilbake`);
          else toast.success(`${restored} handles satt tilbake`);
          if (r.protectedKept?.length) toast.warning(`Delvis angret: ${r.protectedKept.length} beskyttede produkter (gave/lokal) beholder ny handle`);
          break;
        }
      }
      setAnalysis(null);
      await loadStatus();
    } catch (e) {
      toast.error('Angre feilet: ' + (e as Error).message);
      setRollback(prev => prev ? { ...prev, running: false } : null);
    }
  };

  const toggleLog = async () => {
    if (logEntries) { setLogEntries(null); return; }
    if (!job) return;
    try {
      setLogEntries(await syncLog.getByJobId(job.id));
    } catch (e) {
      toast.error('Kunne ikke hente loggen: ' + (e as Error).message);
    }
  };

  const visibleRows = useMemo(() => {
    const rows = analysis?.plan ?? [];
    return (onlyFlagged ? rows.filter(r => r.flags.length) : rows).slice(0, TABLE_LIMIT);
  }, [analysis, onlyFlagged]);

  const isTestStore = shop?.shopDomain === 'testbutikk-9434.myshopify.com';
  const jobResult = job?.result as { changed?: number; errors?: number; mismatched?: unknown[]; rolledBackAt?: string; rollbackStatus?: 'full' | 'partial'; protectedKept?: HandleProtectedKept[] } | undefined;
  // Beskyttede som beholdt ny handle ved angring (fra siste angring, ellers fra jobben)
  const protectedKept = rollback?.protectedKept?.length ? rollback.protectedKept : jobResult?.protectedKept ?? [];

  return (
    <div className="space-y-6">
      {/* Butikk */}
      {shop && (
        <div className={`rounded-lg border px-4 py-3 flex items-start gap-3 ${
          isTestStore ? 'bg-green-50 border-green-200' : shop.allowed ? 'bg-amber-50 border-amber-300' : 'bg-red-50 border-red-200'
        }`}>
          {shop.allowed ? <ShieldCheck className="size-5 text-green-700 mt-0.5" /> : <ShieldAlert className="size-5 text-red-700 mt-0.5" />}
          <div className="text-sm">
            <p className="font-medium text-gray-900">
              Denne siden jobber mot {shop.shopName ?? shop.shopDomain} ({shop.shopDomain})
            </p>
            <p className="text-gray-600">
              {isTestStore
                ? 'Testbutikk — endring av handles er tillatt.'
                : shop.allowed
                  ? 'IKKE Testbutikk. Endring er slått på med ALLOW_HANDLE_MIGRATION=true.'
                  : 'Endring av handles er sperret mot denne butikken. Analyse og kontroll kan fortsatt kjøres.'}
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Handles</CardTitle>
          <CardDescription>
            Gir bøker med ISBN som handle en lesbar adresse: tittel-forfatter-ISBN. Den gamle adressen får 301-videresending.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={handleAnalyze} disabled={analyzing || jobRunning}>
              {analyzing ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Search className="size-4 mr-2" />}
              Analyser
            </Button>
            <Button onClick={handleMigrate} disabled={!canMigrate || starting}>
              {starting ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Link2 className="size-4 mr-2" />}
              Endre handles{analysis ? ` (${readyCount})` : ''}
            </Button>
            <Button variant="outline" onClick={handleVerify} disabled={verifying || jobRunning || !job}>
              {verifying ? <Loader2 className="size-4 mr-2 animate-spin" /> : <CheckCircle2 className="size-4 mr-2" />}
              Kontroller videresendinger
            </Button>
            <Button
              variant="outline"
              className="text-red-600 hover:text-red-700"
              onClick={handleRollback}
              disabled={!shop?.allowed || jobRunning || !!rollback?.running || !job || job.status !== 'completed' || !!jobResult?.rolledBackAt}
            >
              {rollback?.running ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Undo2 className="size-4 mr-2" />}
              Angre siste kjøring
            </Button>
          </div>

          {analysis && blockedCount > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox id="skip-flagged" checked={skipFlagged} onCheckedChange={v => setSkipFlagged(v === true)} />
              <Label htmlFor="skip-flagged" className="text-sm font-normal">
                Hopp over {blockedCount} rader med blokkerende merknader (duplikat eller kollisjon)
              </Label>
            </div>
          )}

          {/* Pågående eller siste kjøring */}
          {job && (
            <div className="rounded-lg border p-3 space-y-2">
              {jobRunning ? (
                <>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Loader2 className="size-4 animate-spin text-blue-600" />
                    Endrer handles … {job.bulkStatus ? `(${job.bulkStatus})` : ''}
                  </div>
                  <Progress value={job.total_items ? (job.processed / job.total_items) * 100 : 0} />
                  <p className="text-xs text-gray-500">
                    {job.processed} av {job.total_items} behandlet. Du kan lukke fanen — resultatet hentes neste gang siden åpnes.
                  </p>
                </>
              ) : (
                <div className="flex items-center gap-3">
                  {job.status === 'completed'
                    ? <CheckCircle2 className="size-5 text-green-600 flex-shrink-0" />
                    : <AlertCircle className="size-5 text-red-600 flex-shrink-0" />}
                  <div className="flex-1 text-sm">
                    <p className="font-medium">
                      Siste kjøring: {job.status === 'completed' ? `${job.succeeded} endret` : 'feilet'}
                      {job.failed > 0 && `, ${job.failed} feilet`}
                      {job.skipped > 0 && `, ${job.skipped} hoppet over`}
                      {jobResult?.rolledBackAt && (jobResult.rollbackStatus === 'partial' ? ' — delvis angret' : ' — angret')}
                    </p>
                    <p className="text-xs text-gray-500">
                      {new Date(job.created_at).toLocaleString('nb-NO')}
                      {job.error_message && ` — ${job.error_message}`}
                      {!!jobResult?.mismatched?.length && ` — ${jobResult.mismatched.length} fikk annen handle enn planlagt`}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={toggleLog}>
                    <FileText className="size-4 mr-1" />
                    {logEntries ? 'Skjul logg' : 'Vis logg'}
                  </Button>
                </div>
              )}
              {logEntries && (
                <div className="border-t pt-2 divide-y max-h-[300px] overflow-y-auto">
                  {logEntries.length === 0 && <p className="text-sm text-gray-500 py-2">Ingen loggføringer</p>}
                  {logEntries.map(e => (
                    <div key={e.id} className="py-1.5 text-xs flex items-start gap-2">
                      {e.status === 'success'
                        ? <CheckCircle2 className="size-3 text-green-600 mt-0.5 flex-shrink-0" />
                        : <AlertCircle className="size-3 text-red-600 mt-0.5 flex-shrink-0" />}
                      <span className="text-gray-400 w-24 flex-shrink-0">{e.action === 'handle_rollback' ? 'angret' : 'endret'}</span>
                      <span className="font-mono break-all">{e.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {rollback && (
            <div className="rounded-lg border p-3 text-sm space-y-1">
              <p className="font-medium flex items-center gap-2">
                {rollback.running && <Loader2 className="size-4 animate-spin" />}
                Angre: {rollback.restored} av {rollback.total} satt tilbake{rollback.failed > 0 && `, ${rollback.failed} feilet`}
              </p>
              {rollback.errors.map(err => <p key={err} className="text-xs text-red-600 font-mono break-all">{err}</p>)}
            </div>
          )}

          {protectedKept.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm space-y-1">
              <p className="font-medium">Delvis angret: {protectedKept.length} beskyttede produkter beholder ny handle og videresending</p>
              <p className="text-xs text-gray-600">De har taggen gave, lokal, lokalhistorie eller lokallitteratur, og Bokadmin endrer dem ikke. Sett handlen tilbake i Shopify admin om det trengs.</p>
              {protectedKept.map(p => (
                <p key={p.id} className="text-xs font-mono break-all">{p.title} (tagg: {p.tag}): /products/{p.handle} ← /products/{p.oldHandle}</p>
              ))}
            </div>
          )}

          {verify && (
            <div className="rounded-lg border p-3 space-y-2">
              <p className="text-sm font-medium">
                {verify.ok} av {verify.checked} kontrollerte videresendinger er riktige
                {verify.checked < verify.total && <span className="text-gray-500 font-normal"> (utvalg av {verify.total})</span>}
              </p>
              <p className="text-xs text-gray-500">
                Kontrollen leser videresendingene i Shopify. HTTP-svaret fra nettsiden vises for de første fem:
                301 er riktig; 302 til /password (passordbeskyttet butikk) eller 429 (Shopify begrenser kall fra serveren) betyr at nettsiden ikke kunne sjekkes herfra.
              </p>
              <div className="divide-y max-h-[300px] overflow-y-auto text-xs">
                {verify.results.map(r => (
                  <div key={r.oldHandle} className="py-1.5 flex items-start gap-2">
                    {r.ok ? <CheckCircle2 className="size-3 text-green-600 mt-0.5 flex-shrink-0" /> : <AlertCircle className="size-3 text-red-600 mt-0.5 flex-shrink-0" />}
                    <div className="font-mono break-all">
                      <p>/products/{r.oldHandle} → {r.target ?? '(ingen videresending)'}</p>
                      {r.http && (
                        <p className="text-gray-500">
                          Nettsiden svarer HTTP {r.http.status}{r.http.location ? ` → ${r.http.location}` : ''}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {analysis && (
        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
            <CardDescription>Tørrkjøring — ingenting er endret ennå.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Stat label="Produkter totalt" value={analysis.total} />
              <Stat label="Får ny handle" value={analysis.counts.planned} strong />
              <Stat label="Allerede riktige" value={analysis.skipped.alleredeRiktig} />
              <Stat label="Uten ISBN (hoppes over)" value={analysis.skipped.ingenIsbn} />
              <Stat label="Egendefinert handle (hoppes over)" value={analysis.skipped.egendefinert} />
              <Stat label="Beskyttet (gave/lokal, hoppes over)" value={analysis.skipped.beskyttet ?? 0} />
              <Stat label="Mangler forfatter" value={analysis.counts.missingAuthor} tone={analysis.counts.missingAuthor ? 'amber' : undefined} />
              <Stat label="Duplikat / kollisjon" value={blockedCount} tone={blockedCount ? 'red' : undefined} />
              <Stat label="Klare til endring" value={readyCount} strong />
            </div>

            {analysis.plan.length > 0 && (
              <>
                <div className="flex items-center gap-2">
                  <Checkbox id="only-flagged" checked={onlyFlagged} onCheckedChange={v => setOnlyFlagged(v === true)} />
                  <Label htmlFor="only-flagged" className="text-sm font-normal">Vis bare rader med merknader ({analysis.counts.withFlags})</Label>
                </div>
                <div className="border rounded-md overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tittel / forfatter</TableHead>
                        <TableHead>Gammel handle</TableHead>
                        <TableHead>Ny handle</TableHead>
                        <TableHead>Merknader</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleRows.map(r => (
                        <TableRow key={r.id}>
                          <TableCell className="max-w-[200px]">
                            <p className="truncate text-sm">{r.title}</p>
                            <p className="truncate text-xs text-gray-500">{r.author || '—'}</p>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{r.oldHandle}</TableCell>
                          <TableCell className="font-mono text-xs break-all whitespace-normal">{r.newHandle}</TableCell>
                          <TableCell className="text-xs whitespace-normal">
                            {r.flags.map(f => (
                              <span key={f} className={`block ${isBlockingHandleFlag(f) ? 'text-red-600' : 'text-amber-600'}`}>{f}</span>
                            ))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {analysis.plan.length > TABLE_LIMIT && !onlyFlagged && (
                  <p className="text-xs text-gray-500">Viser de første {TABLE_LIMIT} av {analysis.plan.length} radene.</p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, strong, tone }: { label: string; value: number; strong?: boolean; tone?: 'amber' | 'red' }) {
  const color = tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-gray-900';
  return (
    <div className="rounded-md border bg-white px-3 py-2">
      <p className={`text-lg ${strong ? 'font-semibold' : ''} ${color}`}>{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}
