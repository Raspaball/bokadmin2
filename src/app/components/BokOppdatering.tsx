import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { AlertCircle, CheckCircle2, FileText, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { bookUpdateJobs, syncLog, type BookUpdateCounts, type Job, type SyncLogEntry } from '../utils/api';

// Jobben «Oppdater eksisterende bøker» (pakke B del 8): retter metafelt, kategori,
// productType, SEO, omslag, beskrivelse og tagger etter standarden. Endrer aldri
// pris, status, tilgjengelighet eller handle. Regelen: supabase/functions/_shared/book-update.ts.

const FIELD_LABELS: Record<string, string> = {
  productType: 'Produkttype',
  category: 'Kategori',
  'bok.forfatter': 'Forfatter',
  'bok.format': 'Format',
  'bok.sider': 'Sider',
  'bok.utgivelsesaar': 'Utgivelsesår',
  'bok.spraak': 'Språk',
  'bok.serie': 'Serie',
  'bok.alder': 'Alder',
  'bok.thema': 'Thema',
  seoTitle: 'SEO-tittel',
  seoDescription: 'Metabeskrivelse',
  coverAlt: 'Alt-tekst på omslag',
  coverFilename: 'Filnavn på omslag',
  description: 'Beskrivelse',
  tags: 'Tagger (fjernet)',
};

const modeOf = (job: Job) => ((job.config as { mode?: string })?.mode === 'update' ? 'update' : 'analyze');
const countsOf = (job: Job) => ((job.result as { counts?: BookUpdateCounts })?.counts ?? (job.config as { counts?: BookUpdateCounts })?.counts ?? null);

function FieldSummary({ counts }: { counts: BookUpdateCounts }) {
  const fields = Object.entries(counts.fields).sort((a, b) => b[1].count - a[1].count);
  const notes = Object.entries(counts.notes);
  return (
    <div className="space-y-2 text-sm">
      <p className="text-gray-600">
        {counts.changed} endres, {counts.unchanged} uendret, hoppet over {counts.skippedNoIsbn + counts.skippedNoOnix + (counts.skippedProtected ?? 0)} ({counts.skippedNoIsbn} uten ISBN, {counts.skippedNoOnix} uten ONIX, {counts.skippedProtected ?? 0} beskyttet), {counts.errors} feil
      </p>
      {fields.length > 0 && (
        <div className="border rounded-lg divide-y">
          {fields.map(([field, v]) => (
            <div key={field} className="p-2">
              <div className="flex justify-between">
                <span className="font-medium">{FIELD_LABELS[field] ?? field}</span>
                <span className="text-gray-500">{v.count} bøker</span>
              </div>
              {v.examples.map((e, i) => <p key={i} className="text-xs text-gray-500 truncate">{e}</p>)}
            </div>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <div className="text-xs text-amber-800 space-y-0.5">
          {notes.map(([n, c]) => <p key={n}>{n}: {c}</p>)}
        </div>
      )}
    </div>
  );
}

export function BokOppdatering() {
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [recent, setRecent] = useState<Job[]>([]);
  const [starting, setStarting] = useState<'analyze' | 'update' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [log, setLog] = useState<SyncLogEntry[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resumingRef = useRef(false);

  const loadRecent = () => bookUpdateJobs.getRecent(5).then(setRecent).catch(() => {});

  const poll = (jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const job = await bookUpdateJobs.getStatus(jobId);
        setActiveJob(job);
        if (job.status === 'paused' && !resumingRef.current) {
          resumingRef.current = true;
          bookUpdateJobs.resume(jobId).catch(() => {}).finally(() => setTimeout(() => { resumingRef.current = false; }, 5000));
        }
        if (job.status === 'completed' || job.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setActiveJob(null);
          loadRecent();
          if (job.status === 'completed') toast.success(`${modeOf(job) === 'update' ? 'Oppdatering' : 'Sjekk'} ferdig`);
          else toast.error('Jobben feilet: ' + (job.error_message || 'ukjent feil'));
        }
      } catch { /* prøver igjen */ }
    }, 3000);
  };

  useEffect(() => {
    bookUpdateJobs.getActive().then(job => { if (job) { setActiveJob(job); poll(job.id); } }).catch(() => {});
    loadRecent();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const start = async (mode: 'analyze' | 'update') => {
    if (mode === 'update' && !confirm('Oppdatere bøkene i Shopify etter standarden? Pris, status og handle endres ikke.')) return;
    setStarting(mode);
    try {
      const r = await bookUpdateJobs.start(mode);
      if (r.error) { toast.info(r.error); return; }
      const job = await bookUpdateJobs.getStatus(r.jobId);
      setActiveJob(job);
      poll(r.jobId);
    } catch (e) {
      toast.error('Kunne ikke starte: ' + (e as Error).message);
    } finally {
      setStarting(null);
    }
  };

  const toggleLog = async (jobId: string) => {
    if (expanded === jobId) { setExpanded(null); return; }
    setExpanded(jobId);
    setLog(await syncLog.getByJobId(jobId).catch(() => []));
  };

  const progress = activeJob && activeJob.total_items > 0 ? Math.min(100, Math.round((activeJob.processed / activeJob.total_items) * 100)) : 0;
  const activeCounts = activeJob ? countsOf(activeJob) : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Oppdater eksisterende bøker</CardTitle>
          <CardDescription>
            Går gjennom alle bøker med ISBN og retter bokfelt, kategori, produkttype, SEO-tittel og metabeskrivelse, omslag (alt-tekst og filnavn), beskrivelse og tagger etter standarden. Pris, status, tilgjengelighet og handle endres ikke, og manuelle endringer i SEO og beskrivelse står.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeJob ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin text-blue-600" />
                  {modeOf(activeJob) === 'update' ? 'Oppdaterer' : 'Sjekker'}{activeJob.status === 'paused' ? ' (pauset)' : '…'}
                  {activeJob.current_isbn && <span className="text-xs text-gray-400 font-mono">{activeJob.current_isbn}</span>}
                </span>
                <span className="text-gray-500">{activeJob.processed} / {activeJob.total_items}</span>
              </div>
              <div className="bg-gray-200 rounded-full h-3">
                <div className="bg-blue-600 rounded-full h-3 transition-all duration-500" style={{ width: `${progress}%` }} />
              </div>
              {activeCounts && <FieldSummary counts={activeCounts} />}
              <Button variant="ghost" size="sm" className="text-red-500" onClick={() => bookUpdateJobs.cancel(activeJob.id).then(() => { setActiveJob(null); loadRecent(); })}>
                <X className="size-4 mr-1" /> Avbryt
              </Button>
            </div>
          ) : (
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => start('analyze')} disabled={!!starting}>
                {starting === 'analyze' ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Search className="size-4 mr-2" />}
                Sjekk (endrer ingenting)
              </Button>
              <Button onClick={() => start('update')} disabled={!!starting}>
                {starting === 'update' ? <Loader2 className="size-4 mr-2 animate-spin" /> : <RefreshCw className="size-4 mr-2" />}
                Oppdater Shopify
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {recent.filter(j => j.status === 'completed' || j.status === 'failed').length > 0 && (
        <Card>
          <CardHeader><CardTitle>Siste kjøringer</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {recent.filter(j => j.status === 'completed' || j.status === 'failed').map(job => {
              const counts = countsOf(job);
              return (
                <div key={job.id} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-3">
                    {job.status === 'completed' ? <CheckCircle2 className="size-5 text-green-600" /> : <AlertCircle className="size-5 text-red-600" />}
                    <div className="flex-1 text-sm">
                      <p className="font-medium">{modeOf(job) === 'update' ? 'Oppdatering' : 'Sjekk'} — {job.status === 'completed' ? 'Fullført' : 'Feilet'}</p>
                      <p className="text-xs text-gray-500">{new Date(job.created_at).toLocaleString('nb-NO')}{job.error_message ? ` — ${job.error_message}` : ''}</p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => toggleLog(job.id)}>
                      <FileText className="size-4 mr-1" /> {expanded === job.id ? 'Skjul logg' : 'Vis logg'}
                    </Button>
                  </div>
                  {counts && <FieldSummary counts={counts} />}
                  {expanded === job.id && (
                    <div className="border-t pt-2 max-h-[300px] overflow-y-auto divide-y text-xs">
                      {log.length === 0 ? <p className="text-gray-500 py-2">Ingen loggoppføringer</p> : log.map(e => (
                        <div key={e.id} className="py-1.5">
                          <span className="font-mono text-gray-400 mr-2">{e.isbn}</span>
                          <span className={e.status === 'error' ? 'text-red-700' : 'text-gray-700'}>{e.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
