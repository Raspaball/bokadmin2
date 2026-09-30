import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Camera, Trash2, ArrowLeft, Loader2, ChevronsUpDown, ChevronUp, ChevronDown, Search, X, Check, Download } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { shopify, books, bokbasen, catalogSnapshots, ShopifyCatalogProduct, CatalogSnapshotMeta, CatalogSnapshot } from '../utils/api';

// ONIX format order (matches FORMAT_OPTIONS in Import.tsx)
const FORMAT_ORDER = ['Paperback', 'Innbundet', 'Heftet', 'Spiralbundet', 'CD-lydbok', 'Strømmet lydbok', 'Lydfil', 'E-bok'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatPrice(price: string): string {
  const n = parseFloat(price);
  if (isNaN(n)) return price;
  return n.toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    ACTIVE: 'bg-green-100 text-green-800',
    DRAFT: 'bg-yellow-100 text-yellow-800',
    ARCHIVED: 'bg-gray-100 text-gray-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status}
    </span>
  );
}

// ── Sort/filter types ─────────────────────────────────────────────────────────

type SortField = 'title' | 'productType' | 'vendor' | 'format' | 'price' | 'status';
type SortDir = 'asc' | 'desc';

interface SortableHeadProps {
  field: SortField;
  label: string;
  current: SortField;
  dir: SortDir;
  onSort: (f: SortField) => void;
  width?: number;
  onResizeStart?: (e: React.MouseEvent) => void;
  className?: string;
}

function SortableHead({ field, label, current, dir, onSort, width, onResizeStart, className }: SortableHeadProps) {
  const active = current === field;
  return (
    <TableHead
      style={width !== undefined ? { width, minWidth: width } : undefined}
      className={`cursor-pointer select-none whitespace-nowrap hover:bg-gray-50 relative overflow-visible ${className ?? ''}`}
      onClick={() => onSort(field)}
    >
      <span className="flex items-center gap-1 pr-2">
        {label}
        {active
          ? dir === 'asc' ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />
          : <ChevronsUpDown className="size-3 text-gray-300" />}
      </span>
      {onResizeStart && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-400 z-10"
          onMouseDown={e => { e.stopPropagation(); onResizeStart(e); }}
        />
      )}
    </TableHead>
  );
}

function ResizableHead({ children, width, onResizeStart, className }: {
  children?: React.ReactNode;
  width?: number;
  onResizeStart?: (e: React.MouseEvent) => void;
  className?: string;
}) {
  return (
    <TableHead
      style={width !== undefined ? { width, minWidth: width } : undefined}
      className={`relative whitespace-nowrap ${className ?? ''}`}
    >
      {children}
      {onResizeStart && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-400 z-10"
          onMouseDown={onResizeStart}
        />
      )}
    </TableHead>
  );
}

// ── Live Catalog Tab ──────────────────────────────────────────────────────────

interface LiveCatalogProps {
  onSnapshotDone: () => void;
  onSwitchToSnapshots: () => void;
}

function LiveCatalog({ onSnapshotDone, onSwitchToSnapshots }: LiveCatalogProps) {
  const [products, setProducts] = useState<ShopifyCatalogProduct[]>([]);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIdx, setPageIdx] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  // Bokbasen format map: isbn → format string
  const [formatMap, setFormatMap] = useState<Record<string, string>>({});

  // Product detail dialog
  const [detailProduct, setDetailProduct] = useState<ShopifyCatalogProduct | null>(null);

  // Total count state
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [countingTotal, setCountingTotal] = useState(false);

  // Snapshot-taking state
  const [takingSnapshot, setTakingSnapshot] = useState(false);
  const [snapshotCount, setSnapshotCount] = useState(0);

  // Sort state
  const [sortField, setSortField] = useState<SortField>('title');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filter state
  const [filterStatus, setFilterStatus] = useState('');
  const [filterVendor, setFilterVendor] = useState('');
  const [filterFormat, setFilterFormat] = useState('');

  // Inline editing state
  const [editingCell, setEditingCell] = useState<{ productId: string; field: 'title' | 'productType' | 'vendor' | 'price' } | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const clickTimerRef2 = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unique values for dropdowns (from current page)
  const vendors = useMemo(
    () => [...new Set(products.map(p => p.vendor).filter(Boolean))].sort(),
    [products]
  );
  const formats = useMemo(
    () => [...new Set(products.map(p => formatMap[p.isbn ?? '']).filter(Boolean))].sort(),
    [products, formatMap]
  );

  // Filtered + sorted display list
  const displayProducts = useMemo(() => {
    let list = products;
    if (filterStatus) list = list.filter(p => p.status === filterStatus);
    if (filterVendor) list = list.filter(p => p.vendor === filterVendor);
    if (filterFormat) list = list.filter(p => formatMap[p.isbn ?? ''] === filterFormat);
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'price') {
        cmp = parseFloat(a.price || '0') - parseFloat(b.price || '0');
      } else if (sortField === 'format') {
        const ai = FORMAT_ORDER.indexOf(formatMap[a.isbn ?? ''] ?? '');
        const bi = FORMAT_ORDER.indexOf(formatMap[b.isbn ?? ''] ?? '');
        cmp = (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      } else {
        const val = (p: ShopifyCatalogProduct) =>
          sortField === 'vendor' ? p.vendor
          : sortField === 'productType' ? p.productType
          : sortField === 'status' ? p.status
          : p.title;
        cmp = (val(a) ?? '').localeCompare(val(b) ?? '', 'nb');
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [products, filterStatus, filterVendor, filterFormat, formatMap, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  // Inline editing handlers
  const handleRowClick = (product: ShopifyCatalogProduct) => {
    if (editingCell) return;
    if (clickTimerRef2.current) clearTimeout(clickTimerRef2.current);
    clickTimerRef2.current = setTimeout(() => setDetailProduct(product), 250);
  };

  const handleCellDoubleClick = (e: React.MouseEvent, product: ShopifyCatalogProduct, field: 'title' | 'productType' | 'vendor' | 'price') => {
    e.stopPropagation();
    if (clickTimerRef2.current) clearTimeout(clickTimerRef2.current);
    setEditingCell({ productId: product.id, field });
    setEditingValue(field === 'price' ? product.price : (product[field] ?? ''));
  };

  const handleConfirmEdit = async () => {
    if (!editingCell) return;
    const product = products.find(p => p.id === editingCell.productId);
    if (!product) return;
    setEditSaving(true);
    try {
      const change: Record<string, string> = { productId: editingCell.productId };
      if (editingCell.field === 'price') {
        change.price = editingValue;
        change.variantId = product.variantId;
      } else {
        change[editingCell.field] = editingValue;
      }
      const results = await shopify.updateCatalogProducts([change as { productId: string; title?: string; productType?: string; vendor?: string; variantId?: string; price?: string }]);
      if (results[0]?.success) {
        setProducts(prev => prev.map(p =>
          p.id === editingCell.productId ? { ...p, [editingCell.field]: editingValue } : p
        ));
        toast.success('Endring lagret i Shopify');
      } else {
        toast.error(`Feilet: ${results[0]?.error || 'Ukjent feil'}`);
      }
    } catch (e) {
      toast.error(`Kunne ikke lagre: ${String(e)}`);
    } finally {
      setEditSaving(false);
      setEditingCell(null);
    }
  };

  const handleCancelEdit = () => {
    setEditingCell(null);
    setEditingValue('');
  };

  const renderEditableCell = (p: ShopifyCatalogProduct, field: 'title' | 'productType' | 'vendor' | 'price', className: string, displayContent?: React.ReactNode) => {
    const isEditing = editingCell?.productId === p.id && editingCell.field === field;
    const inputCls = field === 'price'
      ? 'w-20 text-sm text-right border border-blue-300 rounded px-1 py-0.5 outline-none focus:ring-1 focus:ring-blue-400 tabular-nums'
      : 'w-full text-sm border border-blue-300 rounded px-1 py-0.5 outline-none focus:ring-1 focus:ring-blue-400';
    return (
      <TableCell className={className} onDoubleClick={e => handleCellDoubleClick(e, p, field)}>
        {isEditing ? (
          <div className="flex items-center gap-1">
            <input autoFocus className={inputCls} value={editingValue} onChange={e => setEditingValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleConfirmEdit(); if (e.key === 'Escape') handleCancelEdit(); }} />
            <button onClick={handleConfirmEdit} disabled={editSaving} className="text-green-600 hover:text-green-700 flex-shrink-0">
              {editSaving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            </button>
            <button onClick={handleCancelEdit} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X className="size-4" /></button>
          </div>
        ) : (displayContent ?? <div className="truncate">{p[field]}</div>)}
      </TableCell>
    );
  };

  // Column widths (resizable)
  const [colWidths, setColWidths] = useState<Record<string, number>>({
    img: 52, title: 240, author: 130, vendor: 130, format: 110, collections: 160, price: 90, status: 90,
  });
  const colWidthsRef = useRef<Record<string, number>>(colWidths);
  useEffect(() => { colWidthsRef.current = colWidths; }, [colWidths]);
  const startResize = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = colWidthsRef.current[col];
    const onMove = (ev: MouseEvent) => {
      setColWidths(prev => ({ ...prev, [col]: Math.max(50, startWidth + ev.clientX - startX) }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // Search handler — server-side Shopify search
  const handleSearch = useCallback(async (query: string, after?: string) => {
    if (!query.trim()) return;
    setSearchLoading(true);
    setIsSearchMode(true);
    setSearchQuery(query.trim());
    try {
      const result = await shopify.searchCatalog(query.trim(), after);
      setProducts(result.products);
      setHasNextPage(result.pageInfo.hasNextPage);
      setFetched(true);

      if (result.pageInfo.hasNextPage) {
        setCursors(prev => {
          const newCursors = [...prev];
          if (newCursors.length === pageIdx + 1) {
            newCursors.push(result.pageInfo.endCursor);
          }
          return newCursors;
        });
      }

      // Look up formats from Bokbasen
      const isbns = result.products.map(p => p.isbn).filter((i): i is string => !!i);
      try {
        const fmap = await bokbasen.fetchFormats(isbns);
        setFormatMap(prev => ({ ...prev, ...fmap }));
      } catch { /* best-effort */ }
    } catch (e) {
      toast.error(`Søk feilet: ${String(e)}`);
    } finally {
      setSearchLoading(false);
    }
  }, [pageIdx]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!searchInput.trim()) return;
    setPageIdx(0);
    setCursors([undefined]);
    handleSearch(searchInput);
  };

  // Debounced search-as-you-type
  const handleSearchInputChange = (value: string) => {
    setSearchInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!value.trim()) {
      // Cleared input — go back to full catalog
      if (isSearchMode) {
        setSearchQuery('');
        setIsSearchMode(false);
        setPageIdx(0);
        setCursors([undefined]);
        fetchPage(0, [undefined]);
      }
      return;
    }

    // Wait 400ms after last keystroke before searching
    searchTimerRef.current = setTimeout(() => {
      setPageIdx(0);
      setCursors([undefined]);
      handleSearch(value);
    }, 400);
  };

  const clearSearch = () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    setSearchInput('');
    setSearchQuery('');
    setIsSearchMode(false);
    setPageIdx(0);
    setCursors([undefined]);
    fetchPage(0, [undefined]);
  };

  const fetchTotalCount = useCallback(async () => {
    setCountingTotal(true);
    try {
      const count = await shopify.fetchCount();
      setTotalCount(count);
    } catch (e) {
      toast.error(`Kunne ikke beregne totalt antall: ${String(e)}`);
    } finally {
      setCountingTotal(false);
    }
  }, []);

  const fetchPage = useCallback(async (idx: number, cursorList: (string | undefined)[]) => {
    setLoading(true);
    try {
      if (totalCount === null) fetchTotalCount();
      const after = cursorList[idx];
      const result = await shopify.fetchCatalogPage(after);
      setProducts(result.products);
      setHasNextPage(result.pageInfo.hasNextPage);
      setFetched(true);

      if (result.pageInfo.hasNextPage && cursorList.length === idx + 1) {
        setCursors(prev => [...prev, result.pageInfo.endCursor]);
      }

      // Look up formats from Bokbasen for the ISBNs on this page
      const isbns = result.products.map(p => p.isbn).filter((i): i is string => !!i);
      try {
        const fmap = await bokbasen.fetchFormats(isbns);
        setFormatMap(prev => ({ ...prev, ...fmap }));
      } catch {
        // Format lookup is best-effort, don't block on failure
      }
    } catch (e) {
      toast.error(`Kunne ikke hente katalog: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPage(0, [undefined]);
  }, []);

  const handleFetch = () => {
    fetchPage(0, [undefined]);
    setPageIdx(0);
    setCursors([undefined]);
    setFilterStatus('');
    setFilterVendor('');
    setFilterFormat('');
  };

  const handleNext = () => {
    const nextIdx = pageIdx + 1;
    setPageIdx(nextIdx);
    if (isSearchMode) {
      handleSearch(searchQuery, cursors[nextIdx]);
    } else {
      fetchPage(nextIdx, cursors);
    }
  };

  const handlePrev = () => {
    const prevIdx = pageIdx - 1;
    setPageIdx(prevIdx);
    if (isSearchMode) {
      handleSearch(searchQuery, cursors[prevIdx]);
    } else {
      fetchPage(prevIdx, cursors);
    }
  };

  const handleTakeSnapshot = async () => {
    setTakingSnapshot(true);
    setSnapshotCount(0);
    const all: ShopifyCatalogProduct[] = [];
    let after: string | undefined = undefined;

    try {
      while (true) {
        const result = await shopify.fetchCatalogPage(after);
        all.push(...result.products);
        setSnapshotCount(all.length);

        if (!result.pageInfo.hasNextPage) break;
        after = result.pageInfo.endCursor;
        await new Promise(r => setTimeout(r, 300));
      }

      await catalogSnapshots.save({
        label: null,
        product_count: all.length,
        products: all,
      });

      toast.success(`Arkivert: ${all.length} produkter lagret`);
      onSnapshotDone();
      onSwitchToSnapshots();
    } catch (e) {
      toast.error(`Arkivering feilet: ${String(e)}`);
    } finally {
      setTakingSnapshot(false);
      setSnapshotCount(0);
    }
  };

  const pageNumber = pageIdx + 1;
  const fromItem = pageIdx * 50 + 1;
  const toItem = pageIdx * 50 + products.length;
  const hasFilters = !!(filterStatus || filterVendor || filterFormat);
  const isLoading = loading || searchLoading;

  const selectCls = "text-sm border border-gray-200 rounded-md px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button onClick={handleFetch} disabled={isLoading || takingSnapshot}>
            {loading ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
            {fetched ? 'Oppdater side' : 'Hent katalog'}
          </Button>
          {fetched && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500">
                Side {pageNumber} · {hasFilters ? `${displayProducts.length} / ${products.length}` : `${fromItem}–${toItem}`}
              </span>
              {countingTotal && (
                <span className="text-xs text-blue-600 flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" />
                  Teller totalt...
                </span>
              )}
              {totalCount !== null && !isSearchMode && (
                <span className="text-sm font-medium text-gray-700">
                  · Totalt: {totalCount} bøker
                </span>
              )}
            </div>
          )}
        </div>
        {fetched && (
          <Button variant="outline" onClick={handleTakeSnapshot} disabled={takingSnapshot || isLoading}>
            <Camera className="size-4 mr-2" />
            Arkivér
          </Button>
        )}
      </div>

      {/* Search bar */}
      {fetched && (
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
            <input
              type="text"
              placeholder="Søk på tittel, forfatter, ISBN eller forlag…"
              className="w-full pl-9 pr-9 py-2 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={searchInput}
              onChange={e => handleSearchInputChange(e.target.value)}
            />
            {searchInput && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <Button type="submit" variant="outline" disabled={isLoading || !searchInput.trim()}>
            {searchLoading ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Search className="size-4 mr-2" />}
            Søk
          </Button>
          {isSearchMode && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                Søk: «{searchQuery}» · {products.length} treff
              </Badge>
              <button
                type="button"
                onClick={clearSearch}
                className="text-xs text-blue-600 hover:underline"
              >
                Vis alle
              </button>
            </div>
          )}
        </form>
      )}

      {/* Filter row */}
      {fetched && (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            className={selectCls}
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            <option value="">Alle statuser</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="DRAFT">DRAFT</option>
            <option value="ARCHIVED">ARCHIVED</option>
          </select>

          <select
            className={selectCls}
            value={filterVendor}
            onChange={e => setFilterVendor(e.target.value)}
          >
            <option value="">Alle forlag</option>
            {vendors.map(v => <option key={v} value={v}>{v}</option>)}
          </select>

          <select
            className={selectCls}
            value={filterFormat}
            onChange={e => setFilterFormat(e.target.value)}
          >
            <option value="">Alle formater</option>
            {formats.map(f => <option key={f} value={f}>{f}</option>)}
          </select>

          {hasFilters && (
            <button
              className="text-xs text-blue-600 hover:underline"
              onClick={() => { setFilterStatus(''); setFilterVendor(''); setFilterFormat(''); }}
            >
              Nullstill
            </button>
          )}
        </div>
      )}

      {takingSnapshot && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
          <p className="text-sm text-blue-900 font-medium">Arkiverer hele katalogen...</p>
          <p className="text-sm text-blue-700">Hentet {snapshotCount} produkter</p>
          <Progress value={undefined} className="h-2" />
        </div>
      )}

      {fetched && !loading && displayProducts.length === 0 && (
        <p className="text-sm text-gray-500 py-8 text-center">
          {hasFilters ? 'Ingen produkter matcher filteret.' : 'Ingen produkter funnet.'}
        </p>
      )}

      {displayProducts.length > 0 && (
        <>
          <div className="border rounded-lg overflow-x-auto">
            <Table style={{ tableLayout: 'fixed', width: Object.values(colWidths).reduce((a, b) => a + b, 0) }}>
              <TableHeader>
                <TableRow>
                  <ResizableHead width={colWidths.img} onResizeStart={e => startResize('img', e)} />
                  <SortableHead field="title" label="Tittel" current={sortField} dir={sortDir} onSort={handleSort} width={colWidths.title} onResizeStart={e => startResize('title', e)} />
                  <SortableHead field="productType" label="Forfatter" current={sortField} dir={sortDir} onSort={handleSort} width={colWidths.author} onResizeStart={e => startResize('author', e)} />
                  <SortableHead field="vendor" label="Forlag" current={sortField} dir={sortDir} onSort={handleSort} width={colWidths.vendor} onResizeStart={e => startResize('vendor', e)} />
                  <SortableHead field="format" label="Format" current={sortField} dir={sortDir} onSort={handleSort} width={colWidths.format} onResizeStart={e => startResize('format', e)} />
                  <ResizableHead width={colWidths.collections} onResizeStart={e => startResize('collections', e)}>Kolleksjon</ResizableHead>
                  <SortableHead field="price" label="Pris" current={sortField} dir={sortDir} onSort={handleSort} width={colWidths.price} onResizeStart={e => startResize('price', e)} className="text-right" />
                  <SortableHead field="status" label="Status" current={sortField} dir={sortDir} onSort={handleSort} width={colWidths.status} onResizeStart={e => startResize('status', e)} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayProducts.map(p => (
                  <TableRow
                    key={p.id}
                    className={`hover:bg-blue-50/50 ${editingCell?.productId === p.id ? '' : 'cursor-pointer'}`}
                    onClick={() => handleRowClick(p)}
                  >
                    <TableCell className="p-2">
                      {p.imageUrl
                        ? <img src={p.imageUrl} alt={p.title} className="size-10 object-cover rounded" />
                        : <div className="size-10 bg-gray-100 rounded" />}
                    </TableCell>
                    {renderEditableCell(p, 'title', 'font-medium overflow-hidden')}
                    {renderEditableCell(p, 'productType', 'text-gray-600 overflow-hidden')}
                    {renderEditableCell(p, 'vendor', 'text-gray-600 overflow-hidden')}
                    <TableCell className="text-gray-500 text-sm overflow-hidden"><div className="truncate">{formatMap[p.isbn ?? ''] ?? '—'}</div></TableCell>
                    <TableCell className="text-gray-500 text-sm overflow-hidden"><div className="truncate">{(p.collections ?? []).join(', ') || '—'}</div></TableCell>
                    {renderEditableCell(p, 'price', 'text-right tabular-nums overflow-hidden', <>{formatPrice(p.price)}</>)}
                    <TableCell>{statusBadge(p.status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={handlePrev} disabled={pageIdx === 0 || loading}>
              <ChevronLeft className="size-4 mr-1" /> Forrige side
            </Button>
            <span className="text-sm text-gray-500">Side {pageNumber}</span>
            <Button variant="outline" size="sm" onClick={handleNext} disabled={!hasNextPage || loading}>
              Neste side <ChevronRight className="size-4 ml-1" />
            </Button>
          </div>
        </>
      )}

      {/* Product detail dialog */}
      <Dialog open={!!detailProduct} onOpenChange={open => { if (!open) setDetailProduct(null); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          {detailProduct && (
            <>
              <DialogHeader>
                <DialogTitle className="text-lg leading-snug pr-6">{detailProduct.title}</DialogTitle>
              </DialogHeader>
              <div className="flex gap-5 mt-2">
                {detailProduct.imageUrl && (
                  <img
                    src={detailProduct.imageUrl}
                    alt={detailProduct.title}
                    className="w-32 h-44 object-cover rounded flex-shrink-0"
                  />
                )}
                <div className="space-y-1 text-sm min-w-0">
                  {detailProduct.productType && (
                    <p><span className="text-gray-500">Forfatter:</span> <span className="font-medium">{detailProduct.productType}</span></p>
                  )}
                  {detailProduct.vendor && (
                    <p><span className="text-gray-500">Forlag:</span> <span className="font-medium">{detailProduct.vendor}</span></p>
                  )}
                  {detailProduct.price && (
                    <p><span className="text-gray-500">Pris:</span> <span className="font-medium">{formatPrice(detailProduct.price)} kr</span></p>
                  )}
                  <p><span className="text-gray-500">ISBN:</span> <span className="font-mono text-xs">{detailProduct.isbn ?? '—'}</span></p>
                  <p><span className="text-gray-500">Handle:</span> <span className="font-mono text-xs break-all">{detailProduct.handle}</span></p>
                  <div className="pt-1">{statusBadge(detailProduct.status)}</div>
                </div>
              </div>
              {detailProduct.descriptionHtml && (
                <div
                  className="mt-4 text-sm text-gray-700 leading-relaxed prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: detailProduct.descriptionHtml }}
                />
              )}
              {!detailProduct.descriptionHtml && (
                <p className="mt-4 text-sm text-gray-400 italic">Ingen beskrivelse.</p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── CSV helper ────────────────────────────────────────────────────────────────

function escapeCSV(val: string): string {
  if (!val) return '';
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function downloadSnapshotCSV(snapshot: CatalogSnapshot) {
  const headers = ['Handle', 'Title', 'Type', 'Vendor', 'Year', 'Status', 'Variant Price'];
  const rows = snapshot.products.map(p => [
    p.handle,
    p.title,
    p.productType,
    p.vendor,
    p.createdAt ? new Date(p.createdAt).getFullYear().toString() : '',
    p.status,
    p.price,
  ].map(v => escapeCSV(v ?? '')));
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shopify-backup-${new Date(snapshot.created_at).toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Snapshots Tab ─────────────────────────────────────────────────────────────

interface SnapshotsTabProps {
  refreshSignal: number;
}

function SnapshotsTab({ refreshSignal }: SnapshotsTabProps) {
  const [snapshots, setSnapshots] = useState<CatalogSnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshots(await catalogSnapshots.getAll());
    } catch (e) {
      toast.error(`Kunne ikke laste arkiv: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList, refreshSignal]);

  const handleDownloadCSV = async (id: string) => {
    setDownloadingId(id);
    try {
      const snapshot = await catalogSnapshots.getById(id);
      downloadSnapshotCSV(snapshot);
      toast.success('CSV lastet ned');
    } catch (e) {
      toast.error(`Kunne ikke laste ned: ${String(e)}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await catalogSnapshots.delete(id);
      setSnapshots(prev => prev.filter(s => s.id !== id));
      toast.success('Slettet fra arkiv');
    } catch (e) {
      toast.error(`Kunne ikke slette: ${String(e)}`);
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-gray-500">
        <Loader2 className="size-4 animate-spin" /> Laster arkiv...
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Camera className="size-8 mx-auto mb-3 text-gray-300" />
        <p className="text-sm">Ingen backup-arkiv ennå.</p>
        <p className="text-xs mt-1">Gå til «Katalog» og trykk «Arkivér» for å ta en backup.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">
        Last ned backup-CSV-er for reimport i Shopify. Inneholder tittel, forfatter, forlag og år.
      </p>
      {snapshots.map(s => (
        <div key={s.id} className="border rounded-lg p-4 flex items-center justify-between hover:bg-gray-50 transition-colors">
          <div>
            <p className="text-sm font-medium text-gray-900">
              {new Date(s.created_at).toLocaleString('nb-NO')}
            </p>
            <p className="text-xs text-gray-500">{s.product_count} produkter</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDownloadCSV(s.id)}
              disabled={downloadingId === s.id}
            >
              {downloadingId === s.id
                ? <Loader2 className="size-3 mr-1 animate-spin" />
                : <Download className="size-3 mr-1" />}
              Last ned CSV
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-500 hover:text-red-700 hover:bg-red-50"
              onClick={() => handleDelete(s.id)}
              disabled={deletingId === s.id}
            >
              {deletingId === s.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ShopifyKatalog() {
  const [activeTab, setActiveTab] = useState('live');
  const [snapshotRefresh, setSnapshotRefresh] = useState(0);

  const handleSnapshotDone = () => {
    setSnapshotRefresh(n => n + 1);
  };

  const handleSwitchToSnapshots = () => {
    setActiveTab('snapshots');
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Shopifykatalog</h2>
        <p className="text-sm text-gray-500 mt-1">
          Bla gjennom og rediger katalogen direkte, eller last ned backup-CSV-er fra arkivet.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="live">Katalog</TabsTrigger>
          <TabsTrigger value="snapshots">Arkiv</TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="mt-4">
          <LiveCatalog
            onSnapshotDone={handleSnapshotDone}
            onSwitchToSnapshots={handleSwitchToSnapshots}
          />
        </TabsContent>

        <TabsContent value="snapshots" className="mt-4">
          <SnapshotsTab refreshSignal={snapshotRefresh} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
