import { useState, useEffect, useRef } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Upload, Loader2, CheckCircle2, AlertCircle, ShoppingBag, XCircle, Trash2, Calendar } from 'lucide-react';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { bokbasen, books, shopify, syncLog, type Book, type SyncLogEntry } from '../utils/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { toast } from 'sonner';
import { BokbasenOppslag } from './BokbasenOppslag';
import { AVAILABILITY_OPTIONS, availabilityGroup, availabilityLabel } from '../utils/availabilityCodes';
export { availabilityLabel };

interface ImportedBook extends Book {
  pushing?: boolean;
  pushed?: boolean;
  pushError?: string;
}

const FORMAT_OPTIONS = [
  { code: 'BA', label: 'Paperback', defaultOn: true },
  { code: 'BB', label: 'Innbundet', defaultOn: true },
  { code: 'BC', label: 'Heftet', defaultOn: true },
  { code: 'BD', label: 'Spiralbundet', defaultOn: true },
  { code: 'AB', label: 'CD-lydbok', defaultOn: false },
  { code: 'AI', label: 'Strømmet lydbok', defaultOn: false },
  { code: 'DA', label: 'Lydfil', defaultOn: false },
  { code: 'EB', label: 'E-bok', defaultOn: false },
];

// ── Import result log UI ──────────────────────────────────────────────────────

type ImportEntry = { isbn: string; title: string; reason?: string };
type ImportResult = {
  total: number;
  succeeded: number;
  failed: ImportEntry[];
  skippedFormat: ImportEntry[];
  skippedAvailability: ImportEntry[];
  cancelled: boolean;
};

function ImportResultLog({
  result,
  expanded,
  setExpanded,
}: {
  result: ImportResult;
  expanded: string | null;
  setExpanded: (key: string | null) => void;
}) {
  const toggle = (key: string) => setExpanded(expanded === key ? null : key);

  const ExpandableSection = ({
    sectionKey,
    count,
    label,
    items,
    colorClass,
  }: {
    sectionKey: string;
    count: number;
    label: string;
    items: ImportEntry[];
    colorClass: string;
  }) => (
    <div>
      <button
        className={`flex items-center gap-2 text-sm w-full text-left ${colorClass}`}
        onClick={() => toggle(sectionKey)}
      >
        <AlertCircle className="size-3.5 flex-shrink-0" />
        <span>{count} {label}</span>
        <span className="ml-auto text-xs opacity-60">{expanded === sectionKey ? '▲' : '▼'}</span>
      </button>
      {expanded === sectionKey && (
        <div className="mt-1.5 ml-5 max-h-40 overflow-y-auto space-y-0.5 text-xs">
          {items.map((item, i) => (
            <div key={i} className="flex gap-2 min-w-0">
              <span className="font-mono flex-shrink-0 opacity-70">{item.isbn}</span>
              {item.title !== item.isbn && (
                <span className="truncate opacity-80">{item.title}</span>
              )}
              {item.reason && (
                <span className="flex-shrink-0 opacity-50 ml-auto">· {item.reason}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const hasIssues = result.failed.length > 0 || result.skippedFormat.length > 0 || result.skippedAvailability.length > 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2 text-sm">
      <p className="font-medium text-gray-700">
        {result.cancelled ? 'Import avbrutt' : 'Import fullført'}
        {' — '}
        <span className="font-normal text-gray-500">{result.total} ISBN lest fra CSV</span>
      </p>
      {result.succeeded > 0 && (
        <div className="flex items-center gap-2 text-green-700">
          <CheckCircle2 className="size-3.5 flex-shrink-0" />
          <span>{result.succeeded} bøker importert</span>
        </div>
      )}
      {hasIssues && (
        <div className="border-t border-gray-200 pt-2 space-y-1.5">
          {result.failed.length > 0 && (
            <ExpandableSection
              sectionKey="failed"
              count={result.failed.length}
              label="feilet (metadata ikke funnet i Bokbasen)"
              items={result.failed}
              colorClass="text-red-600"
            />
          )}
          {result.skippedFormat.length > 0 && (
            <ExpandableSection
              sectionKey="format"
              count={result.skippedFormat.length}
              label="hoppet over (format ikke i filter)"
              items={result.skippedFormat}
              colorClass="text-amber-600"
            />
          )}
          {result.skippedAvailability.length > 0 && (
            <ExpandableSection
              sectionKey="availability"
              count={result.skippedAvailability.length}
              label="hoppet over (tilgjengelighet ikke i filter)"
              items={result.skippedAvailability}
              colorClass="text-amber-600"
            />
          )}
        </div>
      )}
    </div>
  );
}

// Loggmelding for push: handle, prisnotat (pakke A2) og tilgjengelighet (pakke C),
// f.eks. «Pushet til Shopify som avkledd-…. Kommer 15.11.2026: ACTIVE, kan forhåndsbestilles»
function pushLogMessage(r: { handle?: string; priceNote?: string; availabilityNote?: string }): string {
  return [`Pushet til Shopify som ${r.handle}`, r.priceNote, r.availabilityNote].filter(Boolean).join('. ');
}

export function Import() {
  const [addedBooks, setAddedBooks] = useState<ImportedBook[]>([]);
  // Push-logg for bøker som ble utkast eller fikk prisen stående fordi pris mangler
  const [missingPriceLog, setMissingPriceLog] = useState<SyncLogEntry[]>([]);
  const loadMissingPriceLog = () => {
    syncLog.getByActions(['push'], 200)
      .then(entries => setMissingPriceLog(entries.filter(e => /mangler pris|Pris ikke endret/.test(e.message ?? ''))))
      .catch(() => {});
  };
  useEffect(() => { loadMissingPriceLog(); }, []);
  const [isLoadingBooks, setIsLoadingBooks] = useState(false);
  const [selectedFormats, setSelectedFormats] = useState<Set<string>>(
    new Set(FORMAT_OPTIONS.filter(f => f.defaultOn).map(f => f.label))
  );
  const [selectedAvailability, setSelectedAvailability] = useState<Set<string>>(
    new Set(AVAILABILITY_OPTIONS.filter(a => a.defaultOn).map(a => a.key))
  );

  // CSV batch import state
  const [csvIsbns, setCsvIsbns] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0 });
  const cancelRef = useRef(false);

  // Load books from DB on mount
  useEffect(() => {
    loadBooks();
  }, []);

  const loadBooks = async () => {
    setIsLoadingBooks(true);
    try {
      const data = await books.getAll();
      setAddedBooks(data.map(b => ({ ...b })));
    } catch (error) {
      toast.error('Kunne ikke laste bøker: ' + (error as Error).message);
    } finally {
      setIsLoadingBooks(false);
    }
  };

  const handleBookAdded = (book: Book) => {
    setAddedBooks(prev => {
      const exists = prev.find(b => b.isbn === book.isbn);
      if (exists) {
        return prev.map(b => b.isbn === book.isbn ? { ...book } : b);
      }
      return [{ ...book }, ...prev];
    });
  };

  // CSV file upload → parse ISBNs → batch fetch from Bokbasen → save to DB
  const handleCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const lines = text.split(/[\n;]+/).map(s => s.trim()).filter(Boolean);

    // Detect Excel scientific notation (e.g. "9,7882E+12" or "9.7882E+12")
    const hasScientific = lines.some(s => /\d[,.]?\d+[eE][+\-]?\d+/.test(s));
    if (hasScientific) {
      toast.error(
        'Excel har konvertert ISBN til vitenskapelig notasjon (f.eks. 9,7882E+12) og mistet presisjon. ' +
        'Formater ISBN-kolonnen som Tekst i Excel og eksporter CSV på nytt.',
        { duration: 8000 }
      );
      return;
    }

    const isbns = lines
      .flatMap(s => s.split(','))
      .map(s => s.trim().replace(/[^0-9Xx]/g, ''))
      .filter(s => s.length >= 10);

    if (isbns.length === 0) {
      toast.error('Ingen gyldige ISBN funnet i filen');
      return;
    }

    setCsvIsbns(isbns);
    toast.info(`${isbns.length} ISBN funnet i filen — klikk "Start import" for å hente metadata`);
    // Reset file input
    e.target.value = '';
  };

  const handleStartCsvImport = async () => {
    if (csvIsbns.length === 0) return;
    cancelRef.current = false;
    setIsImporting(true);
    setImportProgress({ done: 0, total: csvIsbns.length });
    setCsvResult(null);
    setCsvExpanded(null);

    const importJobId = crypto.randomUUID();
    const total = csvIsbns.length;
    const failed: ImportEntry[] = [];
    const skippedFormatList: ImportEntry[] = [];
    const skippedAvailabilityList: ImportEntry[] = [];
    let successCount = 0;

    for (const isbn of csvIsbns) {
      if (cancelRef.current) break;
      try {
        const metadata = await bokbasen.fetchIsbn(isbn);
        if (cancelRef.current) break;
        // Enforce format policy — skip books with non-allowed formats
        if (metadata.format && !selectedFormats.has(metadata.format)) {
          const reason = `Format ${metadata.format} ikke i filter`;
          skippedFormatList.push({ isbn: metadata.isbn, title: metadata.title || isbn, reason });
          syncLog.add({ isbn: metadata.isbn, title: metadata.title, action: 'import_skipped', status: 'info', message: reason, shopify_id: null, job_id: importJobId }).catch(() => {});
          setImportProgress(prev => ({ ...prev, done: prev.done + 1 }));
          continue;
        }
        // Enforce availability policy — skip unavailable books
        if (!isAvailabilityAllowed(metadata.availability)) {
          const reason = `Tilgjengelighet ${metadata.availability} (${availabilityLabel(metadata.availability)}) ikke i filter`;
          skippedAvailabilityList.push({ isbn: metadata.isbn, title: metadata.title || isbn, reason });
          syncLog.add({ isbn: metadata.isbn, title: metadata.title, action: 'import_skipped', status: 'info', message: reason, shopify_id: null, job_id: importJobId }).catch(() => {});
          setImportProgress(prev => ({ ...prev, done: prev.done + 1 }));
          continue;
        }
        const saved = await books.upsert({
          isbn: metadata.isbn,
          title: metadata.title,
          author: metadata.author,
          authors: metadata.authors ?? null,
          publisher: metadata.publisher,
          year: metadata.year,
          format: metadata.format,
          price: metadata.price,
          description: metadata.description,
          image_url: metadata.imageUrl,
          genre: metadata.genre,
          bokgruppe: metadata.bokgruppe,
          bokgruppekode: metadata.bokgruppekode || null,
          varegruppe: metadata.varegruppe || null,
          vekt: metadata.vekt,
          availability_code: metadata.availability,
          availability_status: availabilityLabel(metadata.availability),
        });
        handleBookAdded(saved);
        successCount++;
      } catch {
        failed.push({ isbn, title: isbn });
        syncLog.add({ isbn, title: null, action: 'import_failed', status: 'error', message: 'Bokbasen-oppslag feilet', shopify_id: null, job_id: importJobId }).catch(() => {});
      }
      setImportProgress(prev => ({ ...prev, done: prev.done + 1 }));
    }

    const wasCancelled = cancelRef.current;
    setCsvResult({ total, succeeded: successCount, failed, skippedFormat: skippedFormatList, skippedAvailability: skippedAvailabilityList, cancelled: wasCancelled });
    setCsvIsbns([]);
    setIsImporting(false);
  };

  const handleCancelImport = () => {
    cancelRef.current = true;
  };

  // Clear staging list from DB
  const handleClearList = async () => {
    if (addedBooks.length === 0) return;
    if (!confirm(`Er du sikker på at du vil tømme listen? ${addedBooks.length} bøker fjernes fra arbeidslisten. (Shopify-butikken påvirkes ikke.)`)) return;
    try {
      await books.deleteAll();
      setAddedBooks([]);
      toast.success('Listen er tømt');
    } catch (error) {
      toast.error('Kunne ikke tømme listen: ' + (error as Error).message);
    }
  };

  // Batch push all unpushed books to Shopify
  const [isBatchPushing, setIsBatchPushing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0 });
  const cancelBatchRef = useRef(false);

  const handleBatchPushToShopify = async () => {
    const toPush = addedBooks.filter(b => !b.shopify_id && !b.pushed);
    if (toPush.length === 0) {
      toast.info('Ingen bøker å eksportere');
      return;
    }
    cancelBatchRef.current = false;
    setIsBatchPushing(true);
    setBatchProgress({ done: 0, total: toPush.length });

    let successCount = 0;
    let failCount = 0;
    let priceNoteCount = 0;

    for (let i = 0; i < toPush.length; i += 10) {
      if (cancelBatchRef.current) break;

      const chunk = toPush.slice(i, i + 10);

      setAddedBooks(prev => prev.map(b =>
        chunk.find(c => c.id === b.id) ? { ...b, pushing: true } : b
      ));

      let results: Array<{ isbn: string; success: boolean; shopifyId?: string; handle?: string; error?: string; priceNote?: string; availabilityNote?: string }>;
      try {
        results = await shopify.pushBooks(chunk);
      } catch (e) {
        results = chunk.map(c => ({ isbn: c.isbn, success: false, error: (e as Error).message }));
      }

      for (const res of results) {
        const book = chunk.find(c => c.isbn === res.isbn);
        if (!book) continue;

        if (res.success && res.shopifyId) {
          await books.update(book.id, {
            shopify_id: res.shopifyId,
            shopify_handle: res.handle,
            synced_at: new Date().toISOString(),
          });
          await syncLog.add({
            isbn: book.isbn,
            title: book.title,
            action: 'push',
            status: res.priceNote ? 'info' : 'success',
            message: pushLogMessage(res),
            shopify_id: res.shopifyId,
            job_id: null,
          });
          setAddedBooks(prev => prev.map(b =>
            b.id === book.id ? { ...b, pushing: false, pushed: true, shopify_id: res.shopifyId, shopify_handle: res.handle } : b
          ));
          successCount++;
          if (res.priceNote) priceNoteCount++;
        } else {
          await syncLog.add({
            isbn: book.isbn,
            title: book.title,
            action: 'push',
            status: 'error',
            message: res.error || 'Ukjent feil',
            shopify_id: null,
            job_id: null,
          });
          setAddedBooks(prev => prev.map(b =>
            b.id === book.id ? { ...b, pushing: false, pushError: res.error || 'Ukjent feil' } : b
          ));
          failCount++;
        }
      }

      setBatchProgress(prev => ({ ...prev, done: Math.min(prev.done + chunk.length, prev.total) }));
    }

    const wasCancelled = cancelBatchRef.current;
    if (successCount > 0) toast.success(`${successCount} bøker eksportert til Shopify${wasCancelled ? ' (avbrutt)' : ''}`);
    if (failCount > 0) toast.error(`${failCount} bøker feilet`);
    if (priceNoteCount > 0) toast.warning(`${priceNoteCount} bøker mangler pris — se «Mangler pris»`);
    if (wasCancelled) toast.info('Eksport avbrutt');
    setIsBatchPushing(false);
    loadMissingPriceLog();
  };

  const handleCancelBatchPush = () => {
    cancelBatchRef.current = true;
  };

  // Push single book to Shopify
  const handlePushToShopify = async (bookId: string) => {
    setAddedBooks(prev => prev.map(b =>
      b.id === bookId ? { ...b, pushing: true } : b
    ));

    const book = addedBooks.find(b => b.id === bookId);
    if (!book) return;

    try {
      const result = await shopify.pushBook(book);
      await books.update(book.id, {
        shopify_id: result.shopifyId,
        shopify_handle: result.handle,
        shopify_variant_id: result.variantId || null,
        synced_at: new Date().toISOString(),
      });
      await syncLog.add({
        isbn: book.isbn,
        title: book.title,
        action: 'push',
        status: result.priceNote ? 'info' : 'success',
        message: pushLogMessage(result),
        shopify_id: result.shopifyId,
        job_id: null,
      });
      setAddedBooks(prev => prev.map(b =>
        b.id === bookId ? { ...b, pushing: false, pushed: true, shopify_id: result.shopifyId, shopify_handle: result.handle } : b
      ));
      toast.success(`"${book.title}" pushet til Shopify`);
      if (result.warning) toast.warning(result.warning);
      if (result.priceNote) { toast.warning(result.priceNote); loadMissingPriceLog(); }
    } catch (error) {
      await syncLog.add({
        isbn: book.isbn,
        title: book.title,
        action: 'push',
        status: 'error',
        message: (error as Error).message,
        shopify_id: null,
        job_id: null,
      });
      setAddedBooks(prev => prev.map(b =>
        b.id === bookId ? { ...b, pushing: false, pushError: (error as Error).message } : b
      ));
      toast.error('Shopify-push feilet: ' + (error as Error).message);
    }
  };

  const toggleFormat = (label: string) => {
    setSelectedFormats(prev => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  const toggleAvailability = (key: string) => {
    setSelectedAvailability(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Check if an availability code is allowed by the current filter
  const isAvailabilityAllowed = (code: string | null | undefined): boolean => {
    const group = availabilityGroup(code);
    if (!group) return true; // Unknown codes pass through (no data to filter on)
    return selectedAvailability.has(group);
  };

  // Import result state (shown after each import batch)
  const [csvResult, setCsvResult] = useState<ImportResult | null>(null);
  const [csvExpanded, setCsvExpanded] = useState<string | null>(null);
  const [dateResult, setDateResult] = useState<ImportResult | null>(null);
  const [dateExpanded, setDateExpanded] = useState<string | null>(null);

  // Date-range extraction state
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [isDateFetching, setIsDateFetching] = useState(false);
  const [dateProgress, setDateProgress] = useState('');
  const [dateTruncated, setDateTruncated] = useState(false);
  const cancelDateRef = useRef(false);

  const handleDateRangeFetch = async () => {
    if (!dateFrom || !dateTo) {
      toast.error('Velg både fra- og til-dato');
      return;
    }
    cancelDateRef.current = false;
    setIsDateFetching(true);
    setDateProgress('Henter bøker fra Bokbasen...');
    setDateTruncated(false);
    setDateResult(null);
    setDateExpanded(null);

    const dateJobId = crypto.randomUUID();
    const skippedFormatList: ImportEntry[] = [];
    const skippedAvailabilityList: ImportEntry[] = [];

    try {
      const data = await bokbasen.fetchDateRange(dateFrom, dateTo);
      if (data.truncated) setDateTruncated(true);
      if (cancelDateRef.current) return;

      let added = 0;

      for (const metadata of data.results) {
        if (cancelDateRef.current) break;
        // Enforce format policy
        if (metadata.format && !selectedFormats.has(metadata.format)) {
          const reason = `Format ${metadata.format} ikke i filter`;
          skippedFormatList.push({ isbn: metadata.isbn, title: metadata.title || metadata.isbn, reason });
          syncLog.add({ isbn: metadata.isbn, title: metadata.title, action: 'import_skipped', status: 'info', message: reason, shopify_id: null, job_id: dateJobId }).catch(() => {});
          continue;
        }
        // Enforce availability policy
        if (!isAvailabilityAllowed(metadata.availability)) {
          const reason = `Tilgjengelighet ${metadata.availability} (${availabilityLabel(metadata.availability)}) ikke i filter`;
          skippedAvailabilityList.push({ isbn: metadata.isbn, title: metadata.title || metadata.isbn, reason });
          syncLog.add({ isbn: metadata.isbn, title: metadata.title, action: 'import_skipped', status: 'info', message: reason, shopify_id: null, job_id: dateJobId }).catch(() => {});
          continue;
        }
        try {
          const saved = await books.upsert({
            isbn: metadata.isbn,
            title: metadata.title,
            author: metadata.author,
            authors: metadata.authors ?? null,
            publisher: metadata.publisher,
            year: metadata.year,
            format: metadata.format,
            price: metadata.price,
            description: metadata.description,
            image_url: metadata.imageUrl,
            genre: metadata.genre,
            bokgruppe: metadata.bokgruppe,
            vekt: metadata.vekt,
            availability_code: metadata.availability,
            availability_status: availabilityLabel(metadata.availability),
          });
          handleBookAdded(saved);
          added++;
          setDateProgress(`Lagrer... ${added} av ${data.results.length}`);
        } catch {
          // Skip individual save failures
        }
      }

      setDateResult({
        total: data.results.length,
        succeeded: added,
        failed: [],
        skippedFormat: skippedFormatList,
        skippedAvailability: skippedAvailabilityList,
        cancelled: cancelDateRef.current,
      });
      if (added === 0 && skippedFormatList.length === 0 && skippedAvailabilityList.length === 0) {
        toast.info('Ingen bøker funnet i perioden');
      } else {
        toast.success(`${added} bøker lagt til`);
      }
    } catch (error) {
      toast.error('Datoutrekk feilet: ' + (error as Error).message);
    } finally {
      setIsDateFetching(false);
      setDateProgress('');
    }
  };

  const [descriptionBook, setDescriptionBook] = useState<ImportedBook | null>(null);

  const unpushedBooks = addedBooks.filter(b => !b.shopify_id && !b.pushed);
  // Bøker uten godkjent pris (0 eller lavere regnes som manglende). Push setter aldri pris 0.
  const booksMissingPrice = addedBooks.filter(b => !(Number(b.price) > 0));

  return (
    <div className="space-y-6">
      {/* ISBN Lookup */}
      <Card>
        <CardHeader>
          <CardTitle>Bokbasen-oppslag</CardTitle>
          <CardDescription>Slå opp en bok med ISBN og legg den til i arbeidslisten</CardDescription>
        </CardHeader>
        <CardContent>
          <BokbasenOppslag
            onBookAdded={handleBookAdded}
            allowedFormats={selectedFormats}
            isAvailabilityAllowed={isAvailabilityAllowed}
          />
        </CardContent>
      </Card>

      {/* Added Books */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Arbeidsliste</CardTitle>
              <CardDescription>
                {addedBooks.length} bøker i arbeidslisten
                {unpushedBooks.length > 0 && ` · ${unpushedBooks.length} ikke eksportert til Shopify`}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {unpushedBooks.length > 0 && !isBatchPushing && (
                <Button size="sm" onClick={handleBatchPushToShopify}>
                  <ShoppingBag className="size-3 mr-1" />
                  Eksporter alle til Shopify
                </Button>
              )}
              {isBatchPushing && (
                <Button size="sm" variant="destructive" onClick={handleCancelBatchPush}>
                  <XCircle className="size-3 mr-1" />
                  Stopp eksport
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={handleClearList} disabled={addedBooks.length === 0 || isBatchPushing}>
                <Trash2 className="size-3 mr-1" />
                Tøm liste
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isBatchPushing && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin text-blue-600" />
                <p className="text-sm text-blue-800">
                  Eksporterer til Shopify... {batchProgress.done} / {batchProgress.total}
                </p>
              </div>
              <div className="mt-2 bg-blue-200 rounded-full h-2">
                <div
                  className="bg-blue-600 rounded-full h-2 transition-all"
                  style={{ width: `${(batchProgress.done / batchProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {addedBooks.length === 0 && !isLoadingBooks && (
            <p className="text-sm text-gray-500 text-center py-6">
              Ingen bøker ennå. Bruk ISBN-oppslag ovenfor eller CSV-import nedenfor.
            </p>
          )}

          {addedBooks.length > 0 && (
            <div className="border rounded-lg divide-y max-h-[500px] overflow-y-auto">
              {addedBooks.map((book) => (
                <div key={book.id} className="p-3 hover:bg-gray-50">
                  <div className="flex items-center gap-3">
                    {book.image_url && (
                      <img
                        src={book.image_url}
                        alt={book.title}
                        className="w-10 h-14 object-cover rounded flex-shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <button
                        className="text-sm font-medium truncate block text-left hover:underline hover:text-blue-700 w-full"
                        onClick={() => setDescriptionBook(book)}
                        title="Vis beskrivelse"
                      >
                        {book.title}
                      </button>
                      <p className="text-xs text-gray-600">{book.author}</p>
                      <p className="text-xs text-gray-400 font-mono">{book.isbn}</p>
                      {!(Number(book.price) > 0) && (
                        <span className="inline-flex items-center text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5 mt-1">
                          <AlertCircle className="size-3 mr-1" />
                          Mangler pris: blir utkast i Shopify
                        </span>
                      )}
                    </div>
                    <div className="flex-shrink-0">
                      {book.shopify_id || book.pushed ? (
                        <span className="inline-flex items-center text-xs bg-green-100 text-green-800 rounded px-2 py-1">
                          <CheckCircle2 className="size-3 mr-1" />
                          I Shopify
                        </span>
                      ) : book.pushing ? (
                        <Loader2 className="size-4 animate-spin text-blue-500" />
                      ) : book.pushError ? (
                        <span className="inline-flex items-center text-xs bg-red-100 text-red-800 rounded px-2 py-1">
                          <AlertCircle className="size-3 mr-1" />
                          Feilet
                        </span>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => handlePushToShopify(book.id)}>
                          <ShoppingBag className="size-3 mr-1" />
                          Eksporter til Shopify
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Mangler pris */}
      {(booksMissingPrice.length > 0 || missingPriceLog.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="size-5 text-amber-600" />
              Mangler pris
            </CardTitle>
            <CardDescription>
              Bøker uten godkjent pris fra Bokbasen. Nye bøker opprettes som utkast uten pris, og eksisterende bøker beholder prisen i Shopify.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {booksMissingPrice.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">I arbeidslisten ({booksMissingPrice.length})</p>
                <div className="border rounded-lg divide-y max-h-[240px] overflow-y-auto">
                  {booksMissingPrice.map(b => (
                    <div key={b.id} className="p-2 text-sm flex justify-between gap-2">
                      <span className="truncate">{b.title}</span>
                      <span className="text-xs text-gray-400 font-mono">{b.isbn}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {missingPriceLog.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Fra push-loggen ({missingPriceLog.length})</p>
                <div className="border rounded-lg divide-y max-h-[240px] overflow-y-auto">
                  {missingPriceLog.map(e => (
                    <div key={e.id} className="p-2 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="truncate">{e.title ?? e.isbn}</span>
                        <span className="text-xs text-gray-400">{new Date(e.created_at).toLocaleString('nb-NO')}</span>
                      </div>
                      <p className="text-xs text-amber-800">{(e.message ?? '').replace(/^Pushet til Shopify som \S+\. /, '')}</p>
                      <p className="text-xs text-gray-400 font-mono">{e.isbn}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Format Filter */}
      <Card>
        <CardHeader>
          <CardTitle>Formatfilter</CardTitle>
          <CardDescription>Kun avhukede formater kan legges til i arbeidslisten</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {FORMAT_OPTIONS.map(opt => (
              <label key={opt.code} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedFormats.has(opt.label)}
                  onChange={() => toggleFormat(opt.label)}
                  className="rounded border-gray-300"
                />
                <span className={selectedFormats.has(opt.label) ? 'text-gray-900' : 'text-gray-400'}>
                  {opt.label}
                </span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Availability Filter */}
      <Card>
        <CardHeader>
          <CardTitle>Tilgjengelighetsfilter</CardTitle>
          <CardDescription>Kun avhukede tilgjengelighetsstatus kan legges til i arbeidslisten</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {AVAILABILITY_OPTIONS.map(opt => (
              <label key={opt.key} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedAvailability.has(opt.key)}
                  onChange={() => toggleAvailability(opt.key)}
                  className="rounded border-gray-300"
                />
                <span className={selectedAvailability.has(opt.key) ? 'text-gray-900' : 'text-gray-400'}>
                  {opt.label}
                  <span className="text-xs text-gray-400 ml-1">({opt.codes.join(', ')})</span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Kodene refererer til ONIX List 65 (ProductAvailability). Filteret er foreløpig mock — videreutvikling kommer.
          </p>
        </CardContent>
      </Card>

      {/* Date-range Bokbasen extraction */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="size-5" />
            Datoutrekk fra Bokbasen
          </CardTitle>
          <CardDescription>Hent bøker endret/opprettet i Bokbasen fra og med en gitt dato. Format- og tilgjengelighetsfilter gjelder.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4 items-end flex-wrap">
            <div className="space-y-1">
              <Label htmlFor="date-from">Fra dato</Label>
              <Input
                id="date-from"
                type="date"
                className="w-44"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                disabled={isDateFetching}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="date-to">
                Til dato
                <span className="ml-1 text-xs text-amber-600 font-normal">(veiledende)</span>
              </Label>
              <Input
                id="date-to"
                type="date"
                className="w-44"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                disabled={isDateFetching}
              />
            </div>
            {!isDateFetching ? (
              <Button onClick={handleDateRangeFetch} disabled={!dateFrom || !dateTo}>
                <Calendar className="size-4 mr-2" />
                Hent bøker
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => { cancelDateRef.current = true; }}>
                <XCircle className="size-4 mr-2" />
                Stopp
              </Button>
            )}
          </div>
          <p className="text-xs text-gray-400">
            Henter bøker etter utgivelsesdato i valgt periode.
          </p>
          {isDateFetching && dateProgress && (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg p-3">
              <Loader2 className="size-4 animate-spin text-blue-600" />
              <p className="text-sm text-blue-800">{dateProgress}</p>
            </div>
          )}
          {dateTruncated && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              <AlertCircle className="size-4 flex-shrink-0 mt-0.5" />
              <span>
                Resultatet er begrenset til 5 000 bøker. Det kan finnes flere bøker i perioden.
                Prøv et kortere datointervall for å hente alle.
              </span>
            </div>
          )}
          {!isDateFetching && dateResult && (
            <ImportResultLog result={dateResult} expanded={dateExpanded} setExpanded={setDateExpanded} />
          )}
        </CardContent>
      </Card>

      {/* CSV Upload */}
      <Card>
        <CardHeader>
          <CardTitle>CSV-import</CardTitle>
          <CardDescription>Last opp en CSV-fil med ISBN-numre for batch-import</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
            <Upload className="size-10 mx-auto text-gray-400 mb-3" />
            <p className="text-sm text-gray-600 mb-2">CSV-fil med ISBN-numre (ett per linje eller kommaseparert)</p>
            <input
              type="file"
              accept=".csv,.txt"
              className="hidden"
              id="csv-upload"
              onChange={handleCsvUpload}
            />
            <Button variant="outline" onClick={() => document.getElementById('csv-upload')?.click()}>
              <Upload className="size-4 mr-2" />
              Velg fil
            </Button>
          </div>

          {csvIsbns.length > 0 && !isImporting && (
            <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm text-blue-800">{csvIsbns.length} ISBN klar for import</p>
              <Button size="sm" onClick={handleStartCsvImport}>Start import</Button>
            </div>
          )}

          {isImporting && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin text-blue-600" />
                  <p className="text-sm text-blue-800">
                    Importerer... {importProgress.done} / {importProgress.total}
                  </p>
                </div>
                <Button size="sm" variant="destructive" onClick={handleCancelImport}>
                  <XCircle className="size-3 mr-1" />
                  Stopp
                </Button>
              </div>
              <div className="mt-2 bg-blue-200 rounded-full h-2">
                <div
                  className="bg-blue-600 rounded-full h-2 transition-all"
                  style={{ width: `${(importProgress.done / importProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
          {!isImporting && csvResult && (
            <ImportResultLog result={csvResult} expanded={csvExpanded} setExpanded={setCsvExpanded} />
          )}
        </CardContent>
      </Card>
      {/* Description popup */}
      <Dialog open={!!descriptionBook} onOpenChange={(open) => { if (!open) setDescriptionBook(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="pr-6">{descriptionBook?.title}</DialogTitle>
          </DialogHeader>
          <div className="flex gap-4">
            {descriptionBook?.image_url && (
              <img
                src={descriptionBook.image_url}
                alt={descriptionBook.title}
                className="w-20 h-28 object-cover rounded flex-shrink-0"
              />
            )}
            <div className="space-y-1 text-sm min-w-0">
              {descriptionBook?.author && <p className="text-gray-700">{descriptionBook.author}</p>}
              {descriptionBook?.publisher && <p className="text-xs text-gray-500">{descriptionBook.publisher}{descriptionBook.year ? ` · ${descriptionBook.year}` : ''}</p>}
              {descriptionBook?.isbn && <p className="text-xs text-gray-400 font-mono">{descriptionBook.isbn}</p>}
            </div>
          </div>
          <div className="mt-2 text-sm text-gray-700 leading-relaxed max-h-64 overflow-y-auto whitespace-pre-wrap">
            {descriptionBook?.description || <span className="text-gray-400 italic">Ingen beskrivelse tilgjengelig</span>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
