// «Rydd tagger» (taggjobben tag_cleanup) på siden Sjangre. Fjerner alle tagger unntatt bkg-N/NN/NNN og
// gave, lokal, lokalhistorie, lokallitteratur. Sjekk (ingenting endres) er standard. Beskyttede produkter,
// produkter uten ISBN og duplikater røres aldri. Samme jobbvisning (livstegn, CSV) som de andre jobbene.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Eraser, Loader2, RotateCcw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { JobHealth, JobLogCsvButton } from './JobHealth';
import { syncLog, tagCleanup, type Job, type TagCleanupResult } from '../utils/api';
import { tagCleanupCsv } from '../utils/tagCleanup';
import { downloadCsv } from '../utils/download';

export function RyddTagger() {
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // Aktiv jobb, ellers siste ferdige (så resultatet står igjen etter en ny innlasting)
  useEffect(() => {
    tagCleanup.getActive().then((a) => {
      if (a) { setJob(a); setJobId(a.id); return; }
      return tagCleanup.getRecent(1).then((r) => { if (r[0]) setJob(r[0]); });
    }).catch(() => {});
    return stopPoll;
  }, [stopPoll]);

  useEffect(() => {
    if (!jobId) return;
    stopPoll();
    const poll = async () => {
      try {
        const j = await tagCleanup.getStatus(jobId);
        setJob(j);
        if (j.status === 'paused') await tagCleanup.resume(jobId);
        else if (j.status === 'completed' || j.status === 'failed') {
          stopPoll(); setJobId(null);
          if (j.status === 'failed') toast.error('Taggjobben stoppet: ' + (j.error_message ?? 'ukjent feil'));
          else toast.success(((j.result as TagCleanupResult)?.summary ?? 'Ferdig').split('. ')[0]);
        }
      } catch (e) { console.error('Poll error:', e); }
    };
    poll();
    pollRef.current = setInterval(poll, 3000);
    return stopPoll;
  }, [jobId, stopPoll]);

  const mode = (job?.config as { mode?: string } | undefined)?.mode === 'update' ? 'update' : 'analyze';
  const result = job?.status === 'completed' ? (job.result as TagCleanupResult) : null;
  const running = !!jobId || job?.status === 'running' || job?.status === 'paused';

  const start = async (m: 'analyze' | 'update') => {
    if (m === 'update' && !confirm('Fjerne alle tagger unntatt bkg-tagger og gave/lokal/lokalhistorie/lokallitteratur? Beskyttede produkter, produkter uten ISBN og duplikater røres ikke. Kjør Sjekk først. Dette kan angres fra loggen.')) return;
    setBusy(true);
    try {
      const r = await tagCleanup.start(m);
      if (!r.jobId) throw new Error((r as unknown as { error?: string }).error ?? 'Kunne ikke starte');
      setJob(null); setJobId(r.jobId);
    } catch (e) { toast.error('Feil ved start: ' + (e as Error).message); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!jobId) return;
    await tagCleanup.cancel(jobId).catch(() => {});
    stopPoll(); setJobId(null);
    toast.info('Jobben er avbrutt.');
  };

  const downloadCsvFile = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const rows = await syncLog.getJobChanges(job.id);
      downloadCsv(`rydd-tagger-${mode === 'update' ? 'utfort' : 'sjekk'}-${job.created_at.slice(0, 16).replace(/[:T]/g, '-')}.csv`, tagCleanupCsv(rows));
      toast.success(`${rows.length} produkter i CSV-en`);
    } catch (e) { toast.error('Kunne ikke hente loggen: ' + (e as Error).message); }
    finally { setBusy(false); }
  };

  const undo = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const check = await tagCleanup.rollback(job.id, 'analyze');
      if (check.error) throw new Error(check.error);
      if (!check.remaining) { toast.info('Ingenting å legge tilbake.'); return; }
      if (!confirm(`Legge tilbake ${check.tagsToRestore} tagger på ${check.remaining} produkter?`)) return;
      for (;;) {
        const r = await tagCleanup.rollback(job.id, 'update');
        if (r.error) throw new Error(r.error);
        toast.info(`${r.restored} produkter ferdig, ${r.remaining} igjen${r.errors ? `, ${r.errors} feil` : ''}`);
        if (!r.timedOut) break;
      }
      toast.success('Taggene er lagt tilbake.');
    } catch (e) { toast.error('Angre feilet: ' + (e as Error).message); }
    finally { setBusy(false); }
  };

  const pct = job && job.total_items > 0 ? Math.min(99, Math.round((job.processed / job.total_items) * 100)) : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="flex items-center gap-2"><Eraser className="size-5" />Rydd tagger</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => start('analyze')} disabled={running || busy}>
              {running && mode === 'analyze' ? <><Loader2 className="size-4 mr-2 animate-spin" />Sjekker…</> : <><Search className="size-4 mr-2" />Sjekk</>}
            </Button>
            <Button size="sm" onClick={() => start('update')} disabled={running || busy}>
              {running && mode === 'update' ? <><Loader2 className="size-4 mr-2 animate-spin" />Rydder…</> : <><Eraser className="size-4 mr-2" />Rydd tagger</>}
            </Button>
            {running && <Button size="sm" variant="outline" onClick={cancel}><X className="size-4 mr-1" />Avbryt</Button>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-gray-500">
          Beholder bkg-tagger (bkg-1 til bkg-999) og gave, lokal, lokalhistorie og lokallitteratur. Alt annet fjernes (navn, titler, emnetagger, formattagger). Ingen tagger legges til.
          Beskyttede produkter, produkter uten ISBN og duplikater røres ikke. Start alltid med Sjekk.
        </p>
        {job && running && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-gray-600">
              <span>{mode === 'analyze' ? 'Sjekk' : 'Rydding'}: {job.processed}/{job.total_items || '…'} produkter</span>
              <span className="font-mono">{pct}%</span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} /></div>
            <JobHealth job={job} />
          </div>
        )}
        {result && job && (
          <div className="rounded-md border bg-gray-50 p-3 space-y-2">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              {mode === 'analyze' ? 'Sjekk (ingenting endret)' : 'Ryddet i Shopify'}
              {result.rolledBackAt ? ` · lagt tilbake ${new Date(result.rolledBackAt).toLocaleString('nb-NO')}` : ''}
            </p>
            <p className="text-gray-700">{result.summary}</p>
            {result.topTags && result.topTags.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs text-gray-600">De {result.topTags.length} vanligste taggene som fjernes{result.topTagsComplete === false ? ' (utvalg)' : ''}</summary>
                <p className="text-xs text-gray-600 mt-1 leading-relaxed">{result.topTags.map(([t, n]) => `${t} (${n})`).join(' · ')}</p>
              </details>
            )}
            {result.examples && result.examples.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs text-gray-600">Eksempler</summary>
                <ul className="text-xs text-gray-600 mt-1 space-y-0.5">
                  {result.examples.map((e) => <li key={e.handle}><span className="font-mono">{e.handle.slice(0, 40)}</span>: fjernes {e.fjernes.join(', ')}; beholdes {e.beholdes.join(', ') || '(ingen)'}</li>)}
                </ul>
              </details>
            )}
            <div className="flex gap-2 flex-wrap pt-1">
              <Button size="sm" variant="outline" onClick={downloadCsvFile} disabled={busy}><Download className="size-4 mr-1" />Tagger (CSV)</Button>
              <JobLogCsvButton job={job} />
              {mode === 'update' && !result.rolledBackAt && (
                <Button size="sm" variant="outline" onClick={undo} disabled={busy || running}><RotateCcw className="size-4 mr-1" />Angre (legg taggene tilbake)</Button>
              )}
            </div>
          </div>
        )}
        {job?.status === 'failed' && <p className="text-red-600">Siste jobb stoppet: {job.error_message}</p>}
      </CardContent>
    </Card>
  );
}
