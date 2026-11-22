// «Bokbasen ny» (UTKAST 22.11.2026)
// Henter bokdata med listeoppslaget i ONIX v3 (Edge Function bokbasen-ny), ikke med enkeltoppslag.
// Siden skriver ikke til Shopify. «Legg i arbeidslista» lagrer i tabellen `books`, samme liste som
// fanen «Bokbasen» viser. Eksport til butikken gjøres der, som før.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { CheckCircle2, DownloadCloud, Loader2, Square, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { bokbasenNy, books, type BokbasenNyBook, type BokbasenNyStats } from '../utils/api';
import { AVAILABILITY_OPTIONS, availabilityGroup, availabilityLabel } from '../utils/availabilityCodes';

const BOOKMARK_KEY = 'bokbasenNy.bokmerke';
const MAX_SHOWN = 200;

interface Bookmark {
  next: string;
  savedAt: string; // når bokmerket sist ble lagret
  upToDateAt: string | null; // sist Bokbasen svarte «ingen flere endringer»
  startedFrom: string | null; // datoen hentingen startet fra
}

function loadBookmark(): Bookmark | null {
  try {
    const raw = localStorage.getItem(BOOKMARK_KEY);
    const b = raw ? JSON.parse(raw) : null;
    return b && typeof b.next === 'string' ? b : null;
  } catch {
    return null;
  }
}

function saveBookmark(b: Bookmark | null) {
  try {
    if (b) localStorage.setItem(BOOKMARK_KEY, JSON.stringify(b));
    else localStorage.removeItem(BOOKMARK_KEY);
  } catch {
    // uten lagring i nettleseren virker siden fortsatt, men bokmerket huskes ikke
  }
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFromNow = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' }) : 'aldri');

interface Totals { pages: number; products: number; books: number; deleted: number; skipped: number; withoutIsbn: number; failed: number; kB: number; fetchMs: number; parseMs: number }
const NO_TOTALS: Totals = { pages: 0, products: 0, books: 0, deleted: 0, skipped: 0, withoutIsbn: 0, failed: 0, kB: 0, fetchMs: 0, parseMs: 0 };

export function BokbasenNy() {
  const [afterDate, setAfterDate] = useState(daysFromNow(-1));
  const [pagesize, setPagesize] = useState(50);
  const [maxPages, setMaxPages] = useState(20);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [bookmark, setBookmark] = useState<Bookmark | null>(() => loadBookmark());
  const [found, setFound] = useState<Map<string, BokbasenNyBook>>(new Map());
  const [deleted, setDeleted] = useState<string[]>([]);
  const [totals, setTotals] = useState<Totals>(NO_TOTALS);
  const [lastStats, setLastStats] = useState<BokbasenNyStats | null>(null);
  const [finished, setFinished] = useState<null | 'done' | 'paused' | 'stopped' | 'error'>(null);
  const stopRef = useRef(false);

  // Filter
  const [onlyBooks, setOnlyBooks] = useState(true);
  const [groups, setGroups] = useState<Set<string>>(new Set(AVAILABILITY_OPTIONS.filter((o) => o.defaultOn).map((o) => o.key)));
  const [onlyNew, setOnlyNew] = useState(false);
  const [search, setSearch] = useState('');

  // Valg og lagring
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState('');

  useEffect(() => () => { stopRef.current = true; }, []);

  async function run(mode: 'date' | 'bookmark') {
    if (running) return;
    if (mode === 'date' && !afterDate) { toast.error('Velg en dato'); return; }
    if (mode === 'bookmark' && !bookmark) return;
    stopRef.current = false;
    setRunning(true);
    setFinished(null);
    let next: string | null = mode === 'bookmark' ? bookmark!.next : null;
    const startedFrom = mode === 'date' ? afterDate : bookmark?.startedFrom ?? null;
    let pages = 0;
    let size = pagesize;
    try {
      while (pages < maxPages) {
        if (stopRef.current) { setFinished('stopped'); break; }
        setProgress(`Henter bunke ${pages + 1} …`);
        let page;
        try {
          page = await bokbasenNy.hent(next ? { next, pagesize: size } : { after: afterDate, pagesize: size });
        } catch (err) {
          // 413 = svaret er for stort: halver bunken og prøv igjen (Bokbasens råd)
          if (/413/.test((err as Error).message) && size > 10) { size = Math.max(10, Math.floor(size / 2)); continue; }
          throw err;
        }
        pages++;
        setFound((prev) => { const m = new Map(prev); for (const b of page.books) m.set(b.isbn, b); return m; });
        if (page.deleted.length) setDeleted((prev) => [...new Set([...prev, ...page.deleted])]);
        setLastStats(page.stats);
        setTotals((t) => ({
          pages: t.pages + 1, products: t.products + page.stats.products, books: t.books + page.stats.books,
          deleted: t.deleted + page.stats.deleted, skipped: t.skipped + page.stats.skipped,
          withoutIsbn: t.withoutIsbn + page.stats.withoutIsbn, failed: t.failed + page.stats.failed,
          kB: t.kB + page.stats.kB, fetchMs: t.fetchMs + page.stats.fetchMs, parseMs: t.parseMs + page.stats.parseMs,
        }));
        if (page.next) {
          next = page.next;
          const b: Bookmark = { next, savedAt: new Date().toISOString(), upToDateAt: page.done ? new Date().toISOString() : bookmark?.upToDateAt ?? null, startedFrom };
          saveBookmark(b);
          setBookmark(b);
        }
        if (page.done) { setFinished('done'); break; }
      }
      if (pages >= maxPages) setFinished((f) => f ?? 'paused');
    } catch (err) {
      setFinished('error');
      toast.error('Henting feilet: ' + (err as Error).message);
    } finally {
      setRunning(false);
      setProgress('');
    }
  }

  function clearList() {
    setFound(new Map()); setDeleted([]); setTotals(NO_TOTALS); setLastStats(null); setSelected(new Set()); setAdded(new Set()); setFinished(null);
  }

  function forgetBookmark() {
    saveBookmark(null);
    setBookmark(null);
  }

  const all = useMemo(() => [...found.values()], [found]);
  const filtered = useMemo(() => {
    const from = daysFromNow(-90);
    const to = daysFromNow(183);
    const q = search.trim().toLowerCase();
    return all.filter((b) => {
      if (onlyBooks && b.productType && b.productType !== 'Bok') return false;
      const g = availabilityGroup(b.availability);
      if (!g || !groups.has(g)) return false;
      if (onlyNew) {
        const d = b.publishingDate ?? null;
        if (!d || d < from || d > to) return false;
      }
      if (q && !(`${b.title} ${b.author} ${b.isbn} ${b.publisher}`.toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => (b.publishingDate ?? b.year ?? '').localeCompare(a.publishingDate ?? a.year ?? ''));
  }, [all, onlyBooks, groups, onlyNew, search]);
  const shown = filtered.slice(0, MAX_SHOWN);
  const selectedInFilter = filtered.filter((b) => selected.has(b.isbn));

  const toggle = (isbn: string) => setSelected((prev) => { const s = new Set(prev); if (s.has(isbn)) s.delete(isbn); else s.add(isbn); return s; });
  const toggleGroup = (key: string) => setGroups((prev) => { const s = new Set(prev); if (s.has(key)) s.delete(key); else s.add(key); return s; });
  const selectAllFiltered = () => setSelected(new Set(filtered.map((b) => b.isbn)));

  async function addSelected() {
    const list = selectedInFilter.filter((b) => !added.has(b.isbn));
    if (!list.length || saving) return;
    setSaving(true);
    let ok = 0;
    let fail = 0;
    for (const b of list) {
      setSaveProgress(`Lagrer ${ok + fail + 1} av ${list.length} …`);
      try {
        // Samme felter som datouttrekket på fanen «Bokbasen» (Import.tsx), pluss bokgruppekode og varegruppe.
        await books.upsert({
          isbn: b.isbn, title: b.title, author: b.author, authors: b.authors ?? null, publisher: b.publisher,
          year: b.year, format: b.format, price: b.price, description: b.description, image_url: b.imageUrl,
          genre: b.genre, bokgruppe: b.bokgruppe, bokgruppekode: b.bokgruppekode || null, varegruppe: b.varegruppe || null,
          vekt: b.vekt, availability_code: b.availability, availability_status: availabilityLabel(b.availability),
        });
        ok++;
        setAdded((prev) => new Set(prev).add(b.isbn));
      } catch {
        fail++;
      }
    }
    setSaving(false);
    setSaveProgress('');
    if (fail) toast.error(`${ok} lagt i arbeidslista, ${fail} feilet`);
    else toast.success(`${ok} bøker lagt i arbeidslista`);
  }

  const secPerPage = totals.pages ? ((totals.fetchMs + totals.parseMs) / totals.pages / 1000).toFixed(1) : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DownloadCloud className="size-5" /> Bokbasen ny
            <span className="text-xs font-normal rounded bg-amber-100 text-amber-900 px-2 py-0.5">Utkast · testmodus</span>
          </CardTitle>
          <CardDescription>
            Henter alt som er endret i Bokbasen siden en dato, i bunker (listeoppslaget i ONIX v3). Ingen oppslag per ISBN.
            Siden skriver ikke til nettbutikken.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="bn-after">Endret etter</Label>
              <Input id="bn-after" type="date" value={afterDate} max={isoDay(new Date())} onChange={(e) => setAfterDate(e.target.value)} className="w-44" disabled={running} />
            </div>
            <div>
              <Label htmlFor="bn-size">Bøker per bunke</Label>
              <select id="bn-size" value={pagesize} onChange={(e) => setPagesize(Number(e.target.value))} disabled={running} className="block h-9 rounded-md border border-gray-300 bg-white px-2 text-sm">
                {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="bn-max">Stopp etter (bunker)</Label>
              <select id="bn-max" value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} disabled={running} className="block h-9 rounded-md border border-gray-300 bg-white px-2 text-sm">
                {[1, 5, 20, 50, 200].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            {!running ? (
              <Button onClick={() => run('date')}><DownloadCloud className="size-4 mr-2" />Hent fra dato</Button>
            ) : (
              <Button variant="destructive" onClick={() => { stopRef.current = true; }}><Square className="size-4 mr-2" />Stopp</Button>
            )}
            {!running && bookmark && (
              <Button variant="outline" onClick={() => run('bookmark')}>Fortsett fra bokmerket</Button>
            )}
          </div>

          <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 space-y-1">
            {bookmark ? (
              <p>
                <strong>Bokmerke:</strong> lagret {clock(bookmark.savedAt)}
                {bookmark.startedFrom ? `, startet fra ${bookmark.startedFrom}` : ''}. Sist à jour: {clock(bookmark.upToDateAt)}.{' '}
                {!running && <button className="text-blue-600 hover:underline" onClick={forgetBookmark}>Glem bokmerket</button>}
              </p>
            ) : (
              <p><strong>Bokmerke:</strong> ingen ennå. Etter første henting kan du hente bare det som er nytt siden sist.</p>
            )}
            <p className="text-gray-500">Bokmerket ligger bare i denne nettleseren (utkast).</p>
          </div>

          {running && <p className="flex items-center gap-2 text-sm text-gray-700"><Loader2 className="size-4 animate-spin" />{progress}</p>}
          {finished === 'done' && <p className="flex items-center gap-2 text-sm text-green-700"><CheckCircle2 className="size-4" />Ferdig: Bokbasen har ikke flere endringer nå.</p>}
          {finished === 'paused' && <p className="text-sm text-amber-700">Stoppet etter {maxPages} bunker. Det finnes mer: trykk «Fortsett fra bokmerket».</p>}
          {finished === 'stopped' && <p className="text-sm text-amber-700">Stoppet av deg. «Fortsett fra bokmerket» tar opp tråden.</p>}

          {totals.pages > 0 && (
            <div className="text-sm text-gray-800 space-y-1">
              <p>
                <strong>{totals.products}</strong> poster i <strong>{totals.pages}</strong> bunker: {totals.books} bøker tolket, {totals.deleted} slettet i Bokbasen,{' '}
                {totals.skipped} ikke bok / uten tittel{totals.withoutIsbn ? `, ${totals.withoutIsbn} uten ISBN` : ''}{totals.failed ? `, ${totals.failed} kunne ikke tolkes` : ''}.
              </p>
              <p className="text-xs text-gray-500">
                {(totals.kB / 1024).toFixed(1)} MB hentet, {secPerPage} s per bunke (tolking {Math.round(totals.parseMs / totals.pages)} ms).
                {lastStats && ` ONIX ${lastStats.onixRelease ?? '?'}. Siste svar: Next-header ${lastStats.hasNextHeader ? 'ja' : 'nei'}, Link-header ${lastStats.hasLinkHeader ? 'ja' : 'nei'}, typer ${JSON.stringify(lastStats.notificationTypes)}.`}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {all.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Bøker fra Bokbasen ({filtered.length} av {all.length})</CardTitle>
            <CardDescription>Velg bøker og legg dem i arbeidslista. Derfra eksporteres de til butikken på fanen «Bokbasen», som før.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={onlyBooks} onChange={(e) => setOnlyBooks(e.target.checked)} />Bare fysiske bøker</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />Nye utgivelser (90 dager tilbake, 6 måneder fram)</label>
              {AVAILABILITY_OPTIONS.map((o) => (
                <label key={o.key} className="flex items-center gap-1.5"><input type="checkbox" checked={groups.has(o.key)} onChange={() => toggleGroup(o.key)} />{o.label}</label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input placeholder="Søk i tittel, forfatter, ISBN, forlag" value={search} onChange={(e) => setSearch(e.target.value)} className="w-72" />
              <Button variant="outline" size="sm" onClick={selectAllFiltered}>Velg alle {filtered.length}</Button>
              <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>Velg ingen</Button>
              <Button size="sm" onClick={addSelected} disabled={saving || selectedInFilter.length === 0}>
                {saving ? <><Loader2 className="size-4 mr-2 animate-spin" />{saveProgress}</> : `Legg ${selectedInFilter.length} i arbeidslista`}
              </Button>
              <Button variant="ghost" size="sm" onClick={clearList} disabled={running || saving}><Trash2 className="size-4 mr-1" />Tøm visningen</Button>
            </div>

            <div className="overflow-x-auto rounded-md border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-600">
                  <tr>
                    <th className="p-2 w-8"></th>
                    <th className="p-2 w-10"></th>
                    <th className="p-2">Tittel og forfatter</th>
                    <th className="p-2">Format</th>
                    <th className="p-2">Utgitt</th>
                    <th className="p-2 text-right">Pris</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((b) => (
                    <tr key={b.isbn} className="border-t border-gray-100 align-top hover:bg-gray-50">
                      <td className="p-2"><input type="checkbox" aria-label={`Velg ${b.title}`} checked={selected.has(b.isbn)} onChange={() => toggle(b.isbn)} /></td>
                      <td className="p-2">{b.imageUrl ? <img src={b.imageUrl} alt="" loading="lazy" className="h-12 w-8 object-cover rounded-sm bg-gray-100" /> : <div className="h-12 w-8 rounded-sm bg-gray-100" />}</td>
                      <td className="p-2">
                        <div className="font-medium text-gray-900">{b.title}</div>
                        <div className="text-xs text-gray-600">{b.author || 'Uten forfatter'} · {b.publisher} · {b.isbn}{b.bokgruppekode ? ` · bkg ${b.bokgruppekode}` : ''}</div>
                        {added.has(b.isbn) && <div className="text-xs text-green-700">Lagt i arbeidslista</div>}
                      </td>
                      <td className="p-2 whitespace-nowrap">{b.bookFormat || b.format}</td>
                      <td className="p-2 whitespace-nowrap tabular-nums">{b.publishingDate ?? b.year ?? ''}</td>
                      <td className="p-2 whitespace-nowrap text-right tabular-nums">{b.price != null ? `${b.price} kr` : <span className="text-amber-700" title={b.priceReason ?? ''}>mangler</span>}</td>
                      <td className="p-2 whitespace-nowrap">{b.availability} {availabilityLabel(b.availability)}</td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-gray-500">Ingen bøker passer med filteret.</td></tr>}
                </tbody>
              </table>
            </div>
            {filtered.length > MAX_SHOWN && <p className="text-xs text-gray-500">Viser de første {MAX_SHOWN} av {filtered.length}. Bruk søk eller filter for å snevre inn. «Velg alle» velger alle {filtered.length}.</p>}
          </CardContent>
        </Card>
      )}

      {deleted.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Slettet i Bokbasen ({deleted.length})</CardTitle>
            <CardDescription>Bare til informasjon. Ingenting endres i butikken.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-gray-700 break-words">{deleted.slice(0, 300).join(', ')}{deleted.length > 300 ? ' …' : ''}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
