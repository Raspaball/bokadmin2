// Livstegn og logg for en jobb (pakke F del 3.2 og 3.4): varsel når en aktiv jobb
// har stått stille i mer enn 5 minutter, siste ISBN og hvor mange som gjenstår,
// og CSV med alle produkter som ble hoppet over eller feilet.
// Brukt i Oppdatering.tsx, TilgjengelighetTab.tsx, BokOppdatering.tsx og Sjangre.tsx.
import { useEffect, useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { syncLog, type Job } from '../utils/api';
import { jobLogCsv, lastPulse, stalledMinutes, summarizeProblems } from '../utils/jobLog';
import { downloadCsv } from '../utils/download';

/** CSV med det som ble hoppet over og feil i jobben. */
export function JobLogCsvButton({ job, label = 'Hoppet over og feil (CSV)' }: { job: Job; label?: string }) {
  const [loading, setLoading] = useState(false);
  const download = async () => {
    setLoading(true);
    try {
      const rows = await syncLog.getJobProblems(job.id);
      downloadCsv(`logg-${job.type}-${job.created_at.slice(0, 16).replace(/[:T]/g, '-')}.csv`, jobLogCsv(rows));
      toast.success(`${rows.length} rader: ${summarizeProblems(rows)}`);
    } catch (e) {
      toast.error(`Kunne ikke hente loggen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={download} disabled={loading}>
      {loading ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Download className="size-4 mr-1" />}
      {label}
    </Button>
  );
}

/** Livstegn for en aktiv jobb. Oppdaterer seg selv hvert 30. sekund. */
export function JobHealth({ job }: { job: Job }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const stalled = stalledMinutes(job, now);
  const pulse = lastPulse(job);
  const remaining = job.total_items > 0 ? Math.max(0, job.total_items - job.processed) : null;
  const lastIsbn = job.current_isbn ?? job.last_isbn ?? null;
  const ago = Number.isFinite(pulse) ? Math.max(0, Math.round((now - pulse) / 1000)) : null;

  return (
    <div className="space-y-2">
      {stalled !== null && (
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Jobben har stått stille i {stalled} minutter</p>
            <p className="text-xs">
              Siste livstegn {new Date(pulse).toLocaleTimeString('nb-NO')}{lastIsbn ? `, siste ISBN ${lastIsbn}` : ''}.
              Pausede jobber gjenopptas vanligvis innen ett minutt. Sjekk loggene i Supabase, eller avbryt og start på nytt
              (jobben fortsetter der den slapp og gjør ingenting dobbelt).
            </p>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
        <span>
          {remaining !== null && <>Gjenstår {remaining} av {job.total_items}. </>}
          {lastIsbn && <>Siste ISBN <span className="font-mono">{lastIsbn}</span>. </>}
          {ago !== null && <>Sist oppdatert for {ago < 60 ? `${ago} s` : `${Math.floor(ago / 60)} min`} siden.</>}
        </span>
        <JobLogCsvButton job={job} label="Logg (CSV)" />
      </div>
    </div>
  );
}
