import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Tags, ChevronDown, ChevronRight, Loader2, CheckCircle2, AlertCircle, RefreshCw, Menu, FileText } from 'lucide-react';
import { Input } from './ui/input';
import { shopify, sjangreSync, shopifyEnrich, syncLog, type SjangreSyncJobResult, type ShopifyEnrichJobResult, type SyncLogEntry } from '../utils/api';
import { toast } from 'sonner';

// ── Forleggerforeningen bokgruppekode lookup ──────────────────────────────────
// Komplett mapping basert på offisiell tosifret/tresifret bokgruppeinndeling.
// Kode = x.y.z uten punktum, f.eks. 2.1.3 → '213'
const BOKGRUPPE_LABELS: Record<string, string> = {
  // ── Bokgruppe 1: Skolebøker ────────────────────────────────────────────────
  '110': 'Grunnskolen',
  '120': 'Videregående skole',

  // ── Bokgruppe 2: Fagbøker og lærebøker ────────────────────────────────────
  // 2.1 Lærebøker for høyere utdanning
  '210': 'Lærebøker høyere utdanning – diverse',
  '211': 'Jus',
  '212': 'Økonomi, administrasjon, markedsføring',
  '213': 'Helse og sosialfag',
  '214': 'Samfunnsvitenskapelige fag',
  '215': 'Pedagogikk',
  '216': 'Språk og estetiske fag',
  '217': 'Religion, historie, litteraturvitenskap, filosofi',
  '218': 'Tekniske fag',
  '219': 'Naturvitenskapelige fag',
  // 2.2 Fagbøker for profesjonsmarkedet
  '220': 'Fagbøker profesjonsmarkedet – diverse',
  '221': 'Jus (profesjon)',
  '222': 'Økonomi, administrasjon, markedsføring (profesjon)',
  '223': 'Helse og sosialfag (profesjon)',
  '224': 'Samfunnsvitenskapelige fag (profesjon)',
  '225': 'Pedagogikk (profesjon)',
  '226': 'Språk og estetiske fag (profesjon)',
  '227': 'Religion, historie, litteraturvitenskap, filosofi (profesjon)',
  '228': 'Tekniske fag (profesjon)',
  '229': 'Naturvitenskapelige fag (profesjon)',

  // ── Bokgruppe 3: Sakprosa ─────────────────────────────────────────────────
  // 3.1 Norsk sakprosa for voksne
  '310': 'Norsk sakprosa for voksne – diverse',
  '311': 'Kultur, religion, kunst',
  '312': 'Samfunn, historie',
  '313': 'Kropp og sinn',
  '314': 'Natur, friluftsliv, sport',
  '315': 'Reise og geografi',
  '316': 'Mat og drikke',
  '317': 'Hobby',
  '318': 'Teknikk og populærvitenskap',
  '319': 'Memoarer, biografier',
  // 3.2 Oversatt sakprosa for voksne
  '320': 'Oversatt sakprosa for voksne – diverse',
  '321': 'Kultur, religion, kunst (oversatt)',
  '322': 'Samfunn, historie (oversatt)',
  '323': 'Kropp og sinn (oversatt)',
  '324': 'Natur, friluftsliv, sport (oversatt)',
  '325': 'Reise og geografi (oversatt)',
  '326': 'Mat og drikke (oversatt)',
  '327': 'Hobby (oversatt)',
  '328': 'Teknikk, populærvitenskap (oversatt)',
  '329': 'Memoarer, biografier (oversatt)',
  // 3.3 Norsk sakprosa for barn
  '330': 'Norsk sakprosa for barn – diverse',
  '331': 'Billedbøker (norsk sakprosa)',
  '332': 'Barn (norsk sakprosa)',
  '333': 'Junior (norsk sakprosa)',
  '334': 'Ungdom (norsk sakprosa)',
  // 3.4 Oversatt sakprosa for barn
  '340': 'Oversatt sakprosa for barn – diverse',
  '341': 'Billedbøker (oversatt sakprosa)',
  '342': 'Barn (oversatt sakprosa)',
  '343': 'Junior (oversatt sakprosa)',
  '344': 'Ungdom (oversatt sakprosa)',

  // ── Bokgruppe 4: Skjønnlitteratur ────────────────────────────────────────
  // 4.1 Norsk skjønnlitteratur for voksne
  '410': 'Norsk skjønnlitteratur for voksne – diverse',
  '411': 'Romaner',
  '412': 'Noveller',
  '413': 'Lyrikk',
  '414': 'Skuespill',
  '415': 'Essays',
  '416': 'Antologier',
  '417': 'Krim/spenning',
  '418': 'Klassisk litteratur',
  '419': 'Sang- og visebøker',
  // 4.2 Oversatt skjønnlitteratur for voksne
  '420': 'Oversatt skjønnlitteratur for voksne – diverse',
  '421': 'Romaner (oversatt)',
  '422': 'Noveller (oversatt)',
  '423': 'Lyrikk (oversatt)',
  '424': 'Skuespill (oversatt)',
  '425': 'Essays (oversatt)',
  '426': 'Antologier (oversatt)',
  '427': 'Krim/spenning (oversatt)',
  '428': 'Klassisk litteratur (oversatt)',
  '429': 'Sang- og visebøker (oversatt)',
  // 4.3 Norsk skjønnlitteratur for barn
  '430': 'Norsk skjønnlitteratur for barn – diverse',
  '431': 'Billedbøker',
  '432': 'Romaner barn',
  '433': 'Romaner junior',
  '434': 'Romaner ungdom',
  '435': 'Antologier (barn)',
  '436': 'Klassisk litteratur (barn)',
  '437': 'Sang, viser, dikt (barn)',
  '438': 'Noveller (barn)',
  // 4.4 Oversatt skjønnlitteratur for barn
  '440': 'Oversatt skjønnlitteratur for barn – diverse',
  '441': 'Billedbøker (oversatt)',
  '442': 'Romaner barn (oversatt)',
  '443': 'Romaner junior (oversatt)',
  '444': 'Romaner ungdom (oversatt)',
  '445': 'Antologier (barn, oversatt)',
  '446': 'Klassisk litteratur (barn, oversatt)',
  '447': 'Sang, viser, dikt (barn, oversatt)',
  '448': 'Noveller (barn, oversatt)',

  // ── Bokgruppe 5: Billigbøker ──────────────────────────────────────────────
  '500': 'Billigbøker – diverse',
  '501': 'Billigbok – norsk sakprosa for voksne',
  '502': 'Billigbok – norsk skjønnlitteratur for voksne',
  '503': 'Billigbok – oversatt sakprosa for voksne',
  '504': 'Billigbok – oversatt skjønnlitteratur for voksne',
  '505': 'Billigbok – norsk sakprosa for barn og ungdom',
  '506': 'Billigbok – norsk skjønnlitteratur for barn og ungdom',
  '507': 'Billigbok – oversatt sakprosa for barn og ungdom',
  '508': 'Billigbok – oversatt skjønnlitteratur for barn og ungdom',

  // ── Bokgruppe 6: Verk ─────────────────────────────────────────────────────
  '600': 'Verk – diverse',
  '601': 'Skjønnlitterære verk for voksne',
  '602': 'Sakprosaverk for voksne',
  '603': 'Skjønnlitterære verk for barn og unge',
  '604': 'Sakprosaverk for barn og unge',
  '605': 'Leksikale verk for voksne',
  '606': 'Leksikale verk for barn og unge',

  // ── Bokgruppe 7: Kommisjonsbøker, lover, forskningsrapporter ─────────────
  '700': 'Kommisjonsbøker – diverse',
  '701': 'Tidsskrifter',
  '702': 'Grunnskolen/videregående skole',
  '703': 'Lærebøker for høyere utdanning (komm.)',
  '704': 'Lærebøker til voksenopplæring',
  '705': 'Fagbøker for profesjonsmarkedet (komm.)',
  '706': 'Skjønnlitteratur/sakprosa for voksne (komm.)',
  '707': 'Skjønnlitteratur/sakprosa for barn (komm.)',
  '708': 'Lover, forskrifter og forskningsrapporter',
  '709': 'Sammensatte bokprodukter',

  // ── Bokgruppe 8: Lydbøker og elektroniske innholdsprodukter ──────────────
  // 8.0 Digitale læremidler og andre digitale produkter
  '800': 'Digitale læremidler – diverse',
  '801': 'Digitale læremidler – grunnskolen',
  '802': 'Digitale læremidler – videregående skole',
  '803': 'Digitale læremidler – høyere utdanning',
  '804': 'Digitale læremidler – voksenopplæring',
  '805': 'Digitale læremidler – profesjonsmarkedet',
  '806': 'Digitale læremidler – sakprosa, voksne',
  '807': 'Digitale læremidler – sakprosa, barn og unge',
  '808': 'Digitale læremidler – skjønnlitteratur, barn og unge',
  '809': 'Digitale læremidler – lover og forskningsrapporter',
  // 8.1 Lydbøker allmennmarkedet fysisk format
  '810': 'Lydbok (fysisk) – diverse',
  '811': 'Lydbok (fysisk) – norsk sakprosa for voksne',
  '812': 'Lydbok (fysisk) – norsk skjønnlitteratur for voksne',
  '813': 'Lydbok (fysisk) – oversatt sakprosa for voksne',
  '814': 'Lydbok (fysisk) – oversatt skjønnlitteratur for voksne',
  '815': 'Lydbok (fysisk) – norsk sakprosa for barn og ungdom',
  '816': 'Lydbok (fysisk) – norsk skjønnlitteratur for barn og ungdom',
  '817': 'Lydbok (fysisk) – oversatt sakprosa for barn og ungdom',
  '818': 'Lydbok (fysisk) – oversatt skjønnlitteratur for barn og ungdom',
  // 8.2 Lydbøker undervisnings- og profesjonsmarkedet
  '820': 'Lydbok undervisning/profesjon – diverse',
  '821': 'Lydbok undervisning – grunnskolen',
  '822': 'Lydbok undervisning – videregående skole',
  '823': 'Lydbok undervisning – høyere utdanning',
  '824': 'Lydbok undervisning – voksenopplæring',
  '825': 'Lydbok – faglitteratur for profesjonsmarkedet',
  // 8.3 Annet
  '830': 'Annet – diverse',
  '831': 'Kart',
  '832': 'Kalendere, dagbøker, almanakker',
  '833': 'Lover, forskrifter og forskningsrapporter (annet)',
  '834': 'Leker, puslespill, dukker, tegne- og malemateriell, tekstiler',
  '835': 'Butikkmateriell',
  '836': 'Kontorartikler og kortevarer',
  '837': 'Vitnemål, skoleadministrativt materiell',
  '838': 'Sammensatte produkter (CD/bok, fonogram/bok o.l.)',
  // 8.4 Kart
  '840': 'Kart',
  // 8.5 E-bøker allmennmarkedet
  '850': 'E-bok allmennmarkedet – diverse',
  '851': 'E-bok – norsk sakprosa for voksne',
  '852': 'E-bok – norsk skjønnlitteratur for voksne',
  '853': 'E-bok – oversatt sakprosa for voksne',
  '854': 'E-bok – oversatt skjønnlitteratur for voksne',
  '855': 'E-bok – norsk sakprosa for barn og ungdom',
  '856': 'E-bok – norsk skjønnlitteratur for barn og ungdom',
  '857': 'E-bok – oversatt sakprosa for barn og ungdom',
  '858': 'E-bok – oversatt skjønnlitteratur for barn og ungdom',
  // 8.8 Lydbøker allmennmarkedet lydfil
  '880': 'Lydbok (lydfil) – diverse',
  '881': 'Lydbok (lydfil) – norsk sakprosa for voksne',
  '882': 'Lydbok (lydfil) – norsk skjønnlitteratur for voksne',
  '883': 'Lydbok (lydfil) – oversatt sakprosa for voksne',
  '884': 'Lydbok (lydfil) – oversatt skjønnlitteratur for voksne',
  '885': 'Lydbok (lydfil) – norsk sakprosa for barn og ungdom',
  '886': 'Lydbok (lydfil) – norsk skjønnlitteratur for barn og ungdom',
  '887': 'Lydbok (lydfil) – oversatt sakprosa for barn og ungdom',
  '888': 'Lydbok (lydfil) – oversatt skjønnlitteratur for barn og ungdom',
  // 8.9 E-bøker undervisnings- og profesjonsmarkedet
  '890': 'E-bok undervisning/profesjon – diverse',
  '891': 'E-bok undervisning – grunnskolen',
  '892': 'E-bok undervisning – videregående skole',
  '893': 'E-bok undervisning – høyere utdanning',
  '894': 'E-bok undervisning – voksenopplæring',
  '895': 'E-bok – faglitteratur for profesjonsmarkedet',

  // ── Bokgruppe 9: Annen litteratur ─────────────────────────────────────────
  '910': 'Norske serieromaner',
  '920': 'Oversatte underholdningsromaner',
  '930': 'Sakprosa på originalspråket – diverse',
  '931': 'Sakprosa på originalspråket, voksen',
  '932': 'Ordbøker og undervisningsmateriell på originalspråket',
  '933': 'Reise og geografi på originalspråket',
  '934': 'Sakprosa på originalspråket, barn og ungdom',
  '940': 'Skjønnlitteratur på originalspråket – diverse',
  '941': 'Skjønnlitteratur på originalspråket, voksen',
  '942': 'Krim og spenning på originalspråket, voksen',
  '943': 'Fantasy/SF på originalspråket, voksen',
  '944': 'Skjønnlitteratur på originalspråket, barn og ungdom',
};

const HOVEDKATEGORI: Record<string, string> = {
  '1': 'Skolebøker',
  '2': 'Fagbøker og lærebøker',
  '3': 'Sakprosa',
  '4': 'Skjønnlitteratur',
  '5': 'Billigbøker',
  '6': 'Verk',
  '7': 'Kommisjonsbøker, lover, forskning',
  '8': 'E-bok og lydbok',
  '9': 'Annen litteratur',
  '0': 'Diverse / annet',
};

function bokgruppeLabel(kode: string | null | undefined): string {
  if (!kode) return 'Ukjent';
  return BOKGRUPPE_LABELS[kode] ?? `Kode ${kode}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface KategoriGroup {
  hoved: string;
  koder: { kode: string; label: string; count: number }[];
}

type SyncResult = SjangreSyncJobResult;
type EnrichResult = ShopifyEnrichJobResult;
type PipelinePhase = 'idle' | 'enriching' | 'syncing' | 'cleaning' | 'done' | 'error';

interface PipelineResult {
  enrich?: EnrichResult;
  sync?: SyncResult;
  deletedCollections?: number;
}

export function Sjangre() {
  const [bkgCounts, setBkgCounts] = useState<Record<string, number>>({});
  const [catalogTotal, setCatalogTotal] = useState<{ total: number; withKode: number; withoutKode: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedHoved, setExpandedHoved] = useState<Set<string>>(new Set());

  // Unified pipeline state
  const [phase, setPhase] = useState<PipelinePhase>('idle');
  const [progress, setProgress] = useState(0);
  const [phaseLabel, setPhaseLabel] = useState('');
  const [enrichJobId, setEnrichJobId] = useState<string | null>(null);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  const resultRef = useRef<PipelineResult>({});

  // Menu state
  const [isBuildingMenu, setIsBuildingMenu] = useState(false);
  const [menuHandle, setMenuHandle] = useState('main-menu');
  const [buildMenuResult, setBuildMenuResult] = useState<{ success: boolean; itemsCount?: number } | null>(null);

  // Log panel
  const [showLog, setShowLog] = useState(false);
  const [logEntries, setLogEntries] = useState<SyncLogEntry[]>([]);
  const [isLoadingLog, setIsLoadingLog] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const enrichPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const stopEnrichPoll = useCallback(() => {
    if (enrichPollRef.current) { clearInterval(enrichPollRef.current); enrichPollRef.current = null; }
  }, []);

  const loadCatalogStats = useCallback(() => {
    setIsLoading(true);
    sjangreSync.catalogStats()
      .then(data => {
        setBkgCounts(data.byKode);
        setCatalogTotal({ total: data.total, withKode: data.withKode, withoutKode: data.withoutKode });
      })
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => { loadCatalogStats(); }, [loadCatalogStats]);

  // Resume active jobs on mount
  useEffect(() => {
    shopifyEnrich.getActive().then(job => {
      if (job && (job.status === 'running' || job.status === 'paused')) {
        setPhase('enriching');
        setEnrichJobId(job.id);
      } else {
        sjangreSync.getActive().then(syncJob => {
          if (syncJob && (syncJob.status === 'running' || syncJob.status === 'paused')) {
            setPhase('syncing');
            setSyncJobId(syncJob.id);
          }
        }).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  // Poll sync job
  useEffect(() => {
    if (!syncJobId) return;
    stopPoll();

    const poll = async () => {
      try {
        const job = await sjangreSync.getStatus(syncJobId);
        const rawPct = job.total_items ? Math.min(46, Math.round((job.processed / job.total_items) * 46)) : 0;
        setProgress(job.status === 'completed' ? 96 : 50 + rawPct);
        setPhaseLabel(
          job.config?.phase === 'collections'
            ? 'Fase 2/2: Oppretter Smart Collections…'
            : `Fase 2/2: Tagger produkter i Shopify… ${job.processed ?? 0} / ${job.total_items ?? '?'}`
        );

        if (job.status === 'paused') {
          await sjangreSync.resume(syncJobId);
        } else if (job.status === 'completed') {
          stopPoll();
          setSyncJobId(null);
          const r = job.result as unknown as SyncResult;
          resultRef.current = { ...resultRef.current, sync: r };
          syncLog.add({
            isbn: null, title: 'Synk sjangre til Shopify',
            action: 'sjangre_sync', status: 'success',
            message: `${r?.products?.tagged ?? 0} tagget, ${r?.products?.already_tagged ?? 0} hadde tags, ${r?.products?.skipped_protected ?? 0} beskyttet, ${r?.collections?.created ?? 0} kolleksjoner opprettet`,
            shopify_id: null, job_id: syncJobId,
          }).catch(console.error);

          // Delete empty collections
          setPhase('cleaning');
          setProgress(97);
          setPhaseLabel('Sletter tomme samlinger…');
          try {
            const { deleted } = await sjangreSync.deleteEmptyCollections();
            resultRef.current = { ...resultRef.current, deletedCollections: deleted };
            if (deleted > 0) toast.success(`${deleted} tomme samlinger slettet`);
          } catch (e) {
            console.error('Sletting av tomme samlinger feilet:', e);
          }

          setPipelineResult({ ...resultRef.current });
          toast.success(`${r?.products?.tagged ?? 0} produkter tagget, ${r?.collections?.created ?? 0} kolleksjoner opprettet`);
          setProgress(100);
          setPhase('done');
          setPhaseLabel('Ferdig!');
          loadCatalogStats();
        } else if (job.status === 'failed') {
          stopPoll();
          setSyncJobId(null);
          setPhase('error');
          toast.error('Synk feilet: ' + job.error_message);
          syncLog.add({
            isbn: null, title: 'Synk sjangre til Shopify',
            action: 'sjangre_sync', status: 'error',
            message: job.error_message ?? 'Ukjent feil',
            shopify_id: null, job_id: syncJobId,
          }).catch(console.error);
        }
      } catch (e) {
        console.error('Poll error:', e);
      }
    };

    poll();
    pollRef.current = setInterval(poll, 3000);
    return stopPoll;
  }, [syncJobId, stopPoll, loadCatalogStats]);

  // Poll enrich job
  useEffect(() => {
    if (!enrichJobId) return;
    stopEnrichPoll();

    const poll = async () => {
      try {
        const job = await shopifyEnrich.getStatus(enrichJobId);
        const pct = job.total_items ? Math.min(48, Math.round((job.processed / job.total_items) * 48)) : 0;
        setProgress(job.status === 'completed' ? 50 : pct);
        setPhaseLabel(`Fase 1/2: Slår opp i Bokbasen… ${job.processed ?? 0} / ${job.total_items ?? '?'}`);

        if (job.status === 'paused') {
          await shopifyEnrich.resume(enrichJobId);
        } else if (job.status === 'completed') {
          stopEnrichPoll();
          setEnrichJobId(null);
          const r = job.result as unknown as EnrichResult;
          resultRef.current = { enrich: r };
          syncLog.add({
            isbn: null, title: 'Hent bokgruppekoder fra Bokbasen',
            action: 'sjangre_enrich', status: 'success',
            message: `${r?.found_kode ?? 0} nye koder, ${r?.already_cached ?? 0} allerede cachet, ${r?.no_data ?? 0} uten kode, ${r?.errors ?? 0} feil`,
            shopify_id: null, job_id: enrichJobId,
          }).catch(console.error);

          // Auto-start sync phase
          setPhase('syncing');
          setProgress(50);
          setPhaseLabel('Fase 2/2: Starter synk…');
          try {
            const { jobId } = await sjangreSync.start();
            setSyncJobId(jobId);
          } catch (e) {
            setPhase('error');
            toast.error('Feil ved start av synk: ' + (e as Error).message);
          }
        } else if (job.status === 'failed') {
          stopEnrichPoll();
          setEnrichJobId(null);
          setPhase('error');
          toast.error('Henting feilet: ' + job.error_message);
          syncLog.add({
            isbn: null, title: 'Hent bokgruppekoder fra Bokbasen',
            action: 'sjangre_enrich', status: 'error',
            message: job.error_message ?? 'Ukjent feil',
            shopify_id: null, job_id: enrichJobId,
          }).catch(console.error);
        }
      } catch (e) {
        console.error('Enrich poll error:', e);
      }
    };

    poll();
    enrichPollRef.current = setInterval(poll, 3000);
    return stopEnrichPoll;
  }, [enrichJobId, stopEnrichPoll]);

  const handleRunPipeline = async () => {
    setPipelineResult(null);
    resultRef.current = {};
    setPhase('enriching');
    setProgress(0);
    setPhaseLabel('Fase 1/2: Starter henting fra Bokbasen…');
    try {
      const { jobId } = await shopifyEnrich.start();
      setEnrichJobId(jobId);
    } catch (e) {
      setPhase('error');
      toast.error('Feil ved start: ' + (e as Error).message);
    }
  };

  const handleBuildMenu = async () => {
    setIsBuildingMenu(true);
    setBuildMenuResult(null);
    try {
      const result = await shopify.buildMenu(menuHandle);
      setBuildMenuResult(result);
      toast.success(`Megameny bygget! ${result.itemsCount ?? 0} toppnivå-elementer i Shopify`);
      syncLog.add({
        isbn: null, title: `Bygg megameny: ${menuHandle}`,
        action: 'bygg_meny', status: 'success',
        message: `${result.itemsCount ?? 0} toppnivå-elementer i Shopify`,
        shopify_id: null, job_id: null,
      }).catch(console.error);
    } catch (e) {
      toast.error('Feil ved bygging av meny: ' + (e as Error).message);
      syncLog.add({
        isbn: null, title: `Bygg megameny: ${menuHandle}`,
        action: 'bygg_meny', status: 'error',
        message: (e as Error).message,
        shopify_id: null, job_id: null,
      }).catch(console.error);
    } finally {
      setIsBuildingMenu(false);
    }
  };

  const handleToggleLog = async () => {
    if (showLog) { setShowLog(false); return; }
    setShowLog(true);
    setIsLoadingLog(true);
    try {
      const entries = await syncLog.getByActions(['sjangre_enrich', 'sjangre_sync', 'bygg_meny']);
      setLogEntries(entries);
    } catch (e) {
      toast.error('Kunne ikke hente logg');
    } finally {
      setIsLoadingLog(false);
    }
  };

  const isRunning = phase === 'enriching' || phase === 'syncing' || phase === 'cleaning';

  // Build hierarchy from Shopify catalog bkg-counts
  const hierarchy = Object.entries(bkgCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce<Record<string, KategoriGroup>>((acc, [kode, count]) => {
      const hoved = HOVEDKATEGORI[kode[0]] ?? 'Ukjent';
      if (!acc[hoved]) acc[hoved] = { hoved, koder: [] };
      acc[hoved].koder.push({ kode, label: bokgruppeLabel(kode), count });
      return acc;
    }, {});

  const toggleHoved = (hoved: string) => {
    setExpandedHoved(prev => {
      const next = new Set(prev);
      next.has(hoved) ? next.delete(hoved) : next.add(hoved);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="flex items-center gap-2">
              <Tags className="size-5" />
              Bokgruppeklassifisering
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={handleRunPipeline}
                disabled={isRunning || isLoading}
                size="sm"
              >
                {isRunning
                  ? <><Loader2 className="size-4 mr-2 animate-spin" />Kjører…</>
                  : <><RefreshCw className="size-4 mr-2" />Kjør sjangre-synk</>
                }
              </Button>
              <Button
                onClick={handleToggleLog}
                size="sm"
                variant="outline"
              >
                <FileText className="size-4 mr-2" />
                {showLog ? 'Skjul logg' : 'Vis logg'}
              </Button>
              <div className="flex items-center gap-1">
                <Input
                  value={menuHandle}
                  onChange={e => setMenuHandle(e.target.value)}
                  placeholder="meny-handle"
                  className="h-8 w-32 text-xs"
                  disabled={isBuildingMenu}
                />
                <Button
                  onClick={handleBuildMenu}
                  disabled={isBuildingMenu || !menuHandle || isRunning}
                  size="sm"
                  variant="outline"
                >
                  {isBuildingMenu
                    ? <><Loader2 className="size-4 mr-2 animate-spin" />Bygger…</>
                    : <><Menu className="size-4 mr-2" />Bygg meny</>
                  }
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Unified progress bar */}
          {isRunning && (
            <div className="mb-5 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-gray-600">
                  <Loader2 className="size-3 animate-spin text-blue-500" />
                  {phaseLabel || 'Kjører…'}
                </span>
                <span className="font-mono text-gray-400 tabular-nums">{progress}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500 ease-linear"
                  style={{ width: `${progress}%`, background: '#3b82f6' }}
                />
              </div>
            </div>
          )}

          {/* Log panel */}
          {showLog && (
            <div className="mb-5 border rounded-md overflow-hidden">
              <div className="px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-600 uppercase tracking-wide">
                Siste sjangre-aktivitet (30 oppføringer)
              </div>
              {isLoadingLog ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-gray-500">
                  <Loader2 className="size-3.5 animate-spin" />Laster logg…
                </div>
              ) : logEntries.length === 0 ? (
                <p className="px-4 py-3 text-sm text-gray-400">Ingen loggoppføringer funnet.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto divide-y text-xs">
                  {logEntries.map(entry => (
                    <div key={entry.id} className="flex items-start gap-3 px-4 py-2">
                      <span className={`mt-0.5 shrink-0 inline-flex items-center rounded px-1.5 py-0.5 font-medium ${
                        entry.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {entry.status === 'success' ? '✓' : '✗'}
                      </span>
                      <span className={`mt-0.5 shrink-0 inline-flex rounded px-1.5 py-0.5 font-mono ${
                        entry.action === 'sjangre_enrich' ? 'bg-blue-50 text-blue-600'
                        : entry.action === 'sjangre_sync' ? 'bg-purple-50 text-purple-600'
                        : 'bg-gray-100 text-gray-500'
                      }`}>
                        {entry.action === 'sjangre_enrich' ? 'enrich'
                          : entry.action === 'sjangre_sync' ? 'synk'
                          : 'meny'}
                      </span>
                      <span className="flex-1 text-gray-600 leading-relaxed">{entry.message}</span>
                      <span className="shrink-0 text-gray-300 tabular-nums">
                        {new Date(entry.created_at).toLocaleString('nb-NO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {isLoading ? (
            <p className="text-sm text-gray-500 text-center py-6">Laster sjangre fra Shopify…</p>
          ) : (
            <>
              {/* Catalog summary */}
              <div className="flex flex-wrap gap-6 mb-4 text-sm items-center">
                <div>
                  <span className="font-medium">{catalogTotal?.total ?? 0}</span>
                  <span className="text-gray-500 ml-1">produkter i Shopify</span>
                </div>
                <div>
                  <span className="font-medium text-green-600">{catalogTotal?.withKode ?? 0}</span>
                  <span className="text-gray-500 ml-1">med bokgruppekode</span>
                </div>
                {(catalogTotal?.withoutKode ?? 0) > 0 && (
                  <span className="text-amber-600 font-medium">
                    {catalogTotal?.withoutKode} uten kode
                  </span>
                )}
              </div>

              {/* Pipeline result */}
              {pipelineResult && (
                <div className="mb-4 p-3 rounded-md border bg-gray-50 text-sm space-y-2">
                  {pipelineResult.enrich && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide w-full">Bokbasen-oppslag</span>
                      <span className="flex items-center gap-1 text-blue-700">
                        <CheckCircle2 className="size-3.5" />{pipelineResult.enrich.found_kode} av {pipelineResult.enrich.total} fikk kode
                      </span>
                      {pipelineResult.enrich.already_cached > 0 && (
                        <span className="text-gray-500">{pipelineResult.enrich.already_cached} allerede cachet</span>
                      )}
                      {pipelineResult.enrich.no_data > 0 && (
                        <span className="text-gray-500">{pipelineResult.enrich.no_data} ikke i Bokbasen</span>
                      )}
                      {pipelineResult.enrich.errors > 0 && (
                        <span className="flex items-center gap-1 text-red-500">
                          <AlertCircle className="size-3.5" />{pipelineResult.enrich.errors} feil
                        </span>
                      )}
                    </div>
                  )}
                  {pipelineResult.sync && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide w-full">Shopify-synk</span>
                      <span className="text-gray-700">{pipelineResult.sync.products.total} behandlet</span>
                      {pipelineResult.sync.products.tagged > 0 && (
                        <span className="flex items-center gap-1 text-green-600">
                          <CheckCircle2 className="size-3.5" />{pipelineResult.sync.products.tagged} tagget nå
                        </span>
                      )}
                      <span className="text-gray-400">{pipelineResult.sync.products.already_tagged} hadde tags</span>
                      <span className="text-gray-400">{pipelineResult.sync.products.skipped_protected ?? 0} beskyttet</span>
                      {pipelineResult.sync.collections.created > 0 && (
                        <span className="flex items-center gap-1 text-green-600">
                          <CheckCircle2 className="size-3.5" />{pipelineResult.sync.collections.created} samlinger opprettet
                        </span>
                      )}
                      {(pipelineResult.sync.collections.renamed ?? 0) > 0 && (
                        <span className="flex items-center gap-1 text-green-600">
                          <CheckCircle2 className="size-3.5" />{pipelineResult.sync.collections.renamed} samlinger fikk riktig navn
                        </span>
                      )}
                      {(pipelineResult.deletedCollections ?? 0) > 0 && (
                        <span className="text-amber-600">{pipelineResult.deletedCollections} tomme samlinger slettet</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Tree */}
              <div className="space-y-1">
                {Object.values(hierarchy)
                  .sort((a, b) => a.hoved.localeCompare(b.hoved, 'nb'))
                  .map(({ hoved, koder }) => {
                    const totalI = koder.reduce((s, k) => s + k.count, 0);
                    const isOpen = expandedHoved.has(hoved);
                    return (
                      <div key={hoved} className="border rounded-md overflow-hidden">
                        <button
                          onClick={() => toggleHoved(hoved)}
                          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left"
                        >
                          <div className="flex items-center gap-2 font-medium text-sm">
                            {isOpen ? <ChevronDown className="size-4 text-gray-400" /> : <ChevronRight className="size-4 text-gray-400" />}
                            {hoved}
                          </div>
                          <span className="text-xs text-gray-500 bg-white border rounded-full px-2 py-0.5">
                            {totalI} bøker
                          </span>
                        </button>
                        {isOpen && (
                          <div className="divide-y">
                            {koder.map(({ kode, label, count }) => (
                              <div key={kode} className="flex items-center justify-between px-6 py-2.5 text-sm">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                                    {kode}
                                  </span>
                                  <span className="text-gray-700">{label}</span>
                                </div>
                                <span className="text-xs text-gray-400">{count}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
