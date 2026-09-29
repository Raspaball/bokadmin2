import React, { useState, useEffect, useCallback, useRef } from "react";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import {
  Plus, Trash2, GripVertical, Search, ArrowLeft,
  Loader2, ImageIcon, ChevronLeft, ChevronRight, X,
} from "lucide-react";
import { toast } from "sonner";
import api, { ShopifyCatalogProduct } from "../utils/api";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "./ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "./ui/select";

// ── Types ────────────────────────────────────────────────────────────────────

interface FeedCollection {
  id: string;
  title: string;
  handle: string;
  sortOrder: string;
  productsCount: number;
  image: string | null;
  productImages: string[];
}

interface FeedProduct {
  id: string;
  title: string;
  handle: string;
  author: string;
  vendor: string;
  status: string;
  image: string | null;
  price: string;
  createdAt: string;
}

type SortOption = "MANUAL" | "ALPHA_ASC" | "ALPHA_DESC" | "CREATED" | "CREATED_DESC" | "PRICE_ASC" | "PRICE_DESC";

type CatalogSortKey = "CREATED_AT_DESC" | "CREATED_AT_ASC" | "TITLE_ASC" | "TITLE_DESC" | "VENDOR_ASC";

const CATALOG_SORT_OPTIONS: Record<CatalogSortKey, { label: string; sortKey: string; reverse: boolean }> = {
  CREATED_AT_DESC: { label: "Nyeste importert",  sortKey: "CREATED_AT", reverse: true  },
  CREATED_AT_ASC:  { label: "Eldste importert",   sortKey: "CREATED_AT", reverse: false },
  TITLE_ASC:       { label: "Tittel A–Å",          sortKey: "TITLE",      reverse: false },
  TITLE_DESC:      { label: "Tittel Å–A",          sortKey: "TITLE",      reverse: true  },
  VENDOR_ASC:      { label: "Forlag A–Å",          sortKey: "VENDOR",     reverse: false },
};

const SORT_LABELS: Record<SortOption, string> = {
  MANUAL: "Manuelt (dra og slipp)",
  ALPHA_ASC: "Tittel A–Å",
  ALPHA_DESC: "Tittel Å–A",
  CREATED_DESC: "Nyeste først",
  CREATED: "Eldste først",
  PRICE_ASC: "Pris lav–høy",
  PRICE_DESC: "Pris høy–lav",
};

const ITEM_TYPE = "FEED_PRODUCT";

// ── Draggable row component ──────────────────────────────────────────────────

interface DraggableRowProps {
  product: FeedProduct;
  index: number;
  moveRow: (from: number, to: number) => void;
  onRemove: (product: FeedProduct) => void;
  isManual: boolean;
  onDropEnd: () => void;
}

function DraggableRow({ product, index, moveRow, onRemove, isManual, onDropEnd }: DraggableRowProps) {
  const ref = useRef<HTMLTableRowElement>(null);

  const [{ isDragging }, drag, preview] = useDrag({
    type: ITEM_TYPE,
    item: { index },
    canDrag: isManual,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    end: () => onDropEnd(),
  });

  const [{ isOver }, drop] = useDrop({
    accept: ITEM_TYPE,
    drop: (item: { index: number }) => {
      if (item.index !== index) {
        moveRow(item.index, index);
      }
    },
    collect: (monitor) => ({ isOver: monitor.isOver() }),
  });

  preview(drop(ref));

  return (
    <tr
      ref={ref}
      className={`border-t border-border hover:bg-muted/50 transition ${isDragging ? "opacity-30" : ""} ${isOver ? "bg-accent/10" : ""}`}
    >
      {isManual && (
        <td className="p-3 w-8">
          <span ref={(el) => { drag(el); }} className="cursor-grab active:cursor-grabbing inline-flex">
            <GripVertical className="w-4 h-4 text-muted-foreground" />
          </span>
        </td>
      )}
      <td className="p-3 w-14">
        {product.image ? (
          <img src={product.image} alt="" className="w-10 h-14 object-cover rounded" />
        ) : (
          <div className="w-10 h-14 bg-muted rounded flex items-center justify-center">
            <ImageIcon className="w-4 h-4 text-muted-foreground" />
          </div>
        )}
      </td>
      <td className="p-3 font-medium">{product.title}</td>
      <td className="p-3 text-muted-foreground">{product.author}</td>
      <td className="p-3 text-muted-foreground">{product.vendor}</td>
      <td className="p-3 text-right tabular-nums">{parseFloat(product.price).toFixed(0)} kr</td>
      <td className="p-3 w-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => onRemove(product)}
          title="Fjern fra feed"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </td>
    </tr>
  );
}

// ── Feed mosaic thumbnail ─────────────────────────────────────────────────────

function FeedMosaic({ images }: { images: string[] }) {
  if (images.length === 0) {
    return (
      <div className="h-32 bg-muted flex items-center justify-center">
        <ImageIcon className="w-10 h-10 text-muted-foreground" />
      </div>
    );
  }
  if (images.length === 1) {
    return (
      <div className="h-32 overflow-hidden">
        <img src={images[0]} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }
  if (images.length === 2) {
    return (
      <div className="h-32 grid grid-cols-2 gap-px bg-border">
        {images.map((url, i) => (
          <div key={i} className="overflow-hidden bg-muted">
            <img src={url} alt="" className="w-full h-full object-cover" />
          </div>
        ))}
      </div>
    );
  }
  // 3 or 4 images: 2×2 grid
  const slots = [images[0], images[1], images[2], images[3] ?? null];
  return (
    <div className="h-32 grid grid-cols-2 grid-rows-2 gap-px bg-border">
      {slots.map((url, i) => (
        <div key={i} className="overflow-hidden bg-muted">
          {url && <img src={url} alt="" className="w-full h-full object-cover" />}
        </div>
      ))}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function Feeder() {
  const [feeds, setFeeds] = useState<FeedCollection[]>([]);
  const [selectedFeed, setSelectedFeed] = useState<FeedCollection | null>(null);
  const [products, setProducts] = useState<FeedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newFeedTitle, setNewFeedTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [sortOrder, setSortOrder] = useState<SortOption>("MANUAL");

  // ── Catalog browser state ──────────────────────────────────────────────────
  const CATALOG_PAGE_SIZE = 10;
  const [catalogProducts, setCatalogProducts] = useState<ShopifyCatalogProduct[]>([]);
  const [catalogCursors, setCatalogCursors] = useState<(string | undefined)[]>([undefined]);
  const [catalogPageIdx, setCatalogPageIdx] = useState(0);
  const [catalogHasNext, setCatalogHasNext] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogFetched, setCatalogFetched] = useState(false);
  const [catalogSearchInput, setCatalogSearchInput] = useState("");
  const [catalogSearchQuery, setCatalogSearchQuery] = useState("");
  const [isCatalogSearch, setIsCatalogSearch] = useState(false);
  const [addingProductId, setAddingProductId] = useState<string | null>(null);
  const [catalogSort, setCatalogSort] = useState<CatalogSortKey>("CREATED_AT_DESC");
  const catalogSortRef = useRef<CatalogSortKey>("CREATED_AT_DESC");
  const catalogSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Auto-load catalog when entering a feed ────────────────────────────────

  useEffect(() => {
    if (!selectedFeed) return;
    setCatalogFetched(false);
    setCatalogProducts([]);
    setCatalogCursors([undefined]);
    setCatalogPageIdx(0);
    setCatalogHasNext(false);
    setCatalogSearchInput("");
    setCatalogSearchQuery("");
    setIsCatalogSearch(false);
    fetchCatalogPage(0, [undefined]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFeed?.id]);

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadFeeds = useCallback(async () => {
    setLoading(true);
    try {
      const collections = await api.feeds.list();
      setFeeds(collections.filter((c: any) => !c.handle?.startsWith('bkg-')));
    } catch (e: any) {
      toast.error(e.message || "Kunne ikke laste feeder");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFeeds(); }, [loadFeeds]);

  const loadFeedProducts = useCallback(async (feed: FeedCollection) => {
    setLoadingProducts(true);
    try {
      const res = await api.feeds.get(feed.id);
      setProducts((res.products || []) as unknown as FeedProduct[]);
      setSortOrder((res.collection?.sortOrder as SortOption) || "MANUAL");
      setSelectedFeed({ ...feed, ...res.collection });
    } catch (e: any) {
      toast.error(e.message || "Kunne ikke laste produkter");
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  // ── CRUD handlers ──────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!newFeedTitle.trim()) return;
    setCreating(true);
    try {
      await api.feeds.create(newFeedTitle.trim());
      toast.success(`Feed «${newFeedTitle.trim()}» opprettet`);
      setNewFeedTitle("");
      setCreateOpen(false);
      await loadFeeds();
    } catch (e: any) {
      toast.error(e.message || "Kunne ikke opprette feed");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (feed: FeedCollection) => {
    if (!confirm(`Slett «${feed.title}»? Dette kan ikke angres.`)) return;
    try {
      await api.feeds.delete(feed.id);
      toast.success(`Feed «${feed.title}» slettet`);
      if (selectedFeed?.id === feed.id) { setSelectedFeed(null); setProducts([]); }
      await loadFeeds();
    } catch (e: any) {
      toast.error(e.message || "Kunne ikke slette feed");
    }
  };

  // ── Catalog browser functions ───────────────────────────────────────────────

  const fetchCatalogPage = useCallback(async (idx: number, cursorList: (string | undefined)[], searchQ?: string) => {
    setCatalogLoading(true);
    try {
      const after = cursorList[idx];
      let result: { products: ShopifyCatalogProduct[]; pageInfo: { hasNextPage: boolean; endCursor: string } };

      if (searchQ) {
        result = await api.shopify.searchCatalog(searchQ, after, CATALOG_PAGE_SIZE);
      } else {
        const { sortKey, reverse } = CATALOG_SORT_OPTIONS[catalogSortRef.current];
        result = await api.shopify.fetchCatalogPage(after, CATALOG_PAGE_SIZE, sortKey, reverse);
      }

      setCatalogProducts(result.products);
      setCatalogHasNext(result.pageInfo.hasNextPage);
      setCatalogFetched(true);

      if (result.pageInfo.hasNextPage && cursorList.length === idx + 1) {
        setCatalogCursors(prev => [...prev, result.pageInfo.endCursor]);
      }
    } catch (e: any) {
      toast.error(e.message || "Kunne ikke laste katalog");
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const handleCatalogSearchInput = useCallback((value: string) => {
    setCatalogSearchInput(value);
    if (catalogSearchTimer.current) clearTimeout(catalogSearchTimer.current);

    if (!value.trim()) {
      if (isCatalogSearch) {
        setCatalogSearchQuery("");
        setIsCatalogSearch(false);
        setCatalogPageIdx(0);
        setCatalogCursors([undefined]);
        fetchCatalogPage(0, [undefined]);
      }
      return;
    }

    catalogSearchTimer.current = setTimeout(() => {
      setCatalogSearchQuery(value.trim());
      setIsCatalogSearch(true);
      setCatalogPageIdx(0);
      setCatalogCursors([undefined]);
      fetchCatalogPage(0, [undefined], value.trim());
    }, 400);
  }, [isCatalogSearch, fetchCatalogPage]);

  const clearCatalogSearch = useCallback(() => {
    if (catalogSearchTimer.current) clearTimeout(catalogSearchTimer.current);
    setCatalogSearchInput("");
    setCatalogSearchQuery("");
    setIsCatalogSearch(false);
    setCatalogPageIdx(0);
    setCatalogCursors([undefined]);
    fetchCatalogPage(0, [undefined]);
  }, [fetchCatalogPage]);

  const handleCatalogSortChange = useCallback((newSort: CatalogSortKey) => {
    catalogSortRef.current = newSort;
    setCatalogSort(newSort);
    setCatalogPageIdx(0);
    setCatalogCursors([undefined]);
    fetchCatalogPage(0, [undefined]);
  }, [fetchCatalogPage]);

  const catalogNext = () => {
    const nextIdx = catalogPageIdx + 1;
    setCatalogPageIdx(nextIdx);
    fetchCatalogPage(nextIdx, catalogCursors, isCatalogSearch ? catalogSearchQuery : undefined);
  };

  const catalogPrev = () => {
    const prevIdx = catalogPageIdx - 1;
    setCatalogPageIdx(prevIdx);
    fetchCatalogPage(prevIdx, catalogCursors, isCatalogSearch ? catalogSearchQuery : undefined);
  };

  const handleAddFromCatalog = async (product: ShopifyCatalogProduct) => {
    if (!selectedFeed) return;
    setAddingProductId(product.id);
    try {
      await api.feeds.addProducts(selectedFeed.id, [product.id]);
      const asFeed: FeedProduct = {
        id: product.id,
        title: product.title,
        handle: product.handle,
        author: product.productType || "",
        vendor: product.vendor || "",
        status: product.status,
        image: product.imageUrl || null,
        price: product.price || "0.00",
        createdAt: product.createdAt || "",
      };
      setProducts(prev => [...prev, asFeed]);
      setSelectedFeed(prev => prev ? { ...prev, productsCount: prev.productsCount + 1 } : null);
      setFeeds(prev => prev.map(f => f.id === selectedFeed!.id ? { ...f, productsCount: f.productsCount + 1 } : f));
      toast.success(`«${product.title}» lagt til`);
    } catch (e: any) {
      toast.error(e.message || "Kunne ikke legge til produkt");
    } finally {
      setAddingProductId(null);
    }
  };

  // ── Add / remove products ──────────────────────────────────────────────────

  const handleRemoveProduct = async (product: FeedProduct) => {
    if (!selectedFeed) return;
    try {
      await api.feeds.removeProducts(selectedFeed.id, [product.id]);
      setProducts(prev => prev.filter(p => p.id !== product.id));
      setSelectedFeed(prev => prev ? { ...prev, productsCount: prev.productsCount - 1 } : null);
      setFeeds(prev => prev.map(f => f.id === selectedFeed.id ? { ...f, productsCount: f.productsCount - 1 } : f));
      toast.success(`«${product.title}» fjernet`);
    } catch (e: any) {
      toast.error(e.message || "Kunne ikke fjerne produkt");
    }
  };

  // ── Sort ───────────────────────────────────────────────────────────────────

  const handleSortChange = async (newSort: string) => {
    if (!selectedFeed) return;
    setSortOrder(newSort as SortOption);
    try {
      await api.feeds.update(selectedFeed.id, { sortOrder: newSort });
      await loadFeedProducts(selectedFeed);
    } catch (e: any) {
      toast.error(e.message || "Kunne ikke endre sortering");
    }
  };

  // ── Drag & drop reorder ────────────────────────────────────────────────────

  const moveRow = useCallback((from: number, to: number) => {
    setProducts(prev => {
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }, []);

  const handleDropEnd = useCallback(async () => {
    if (!selectedFeed || sortOrder !== "MANUAL") return;
    try {
      const moves = products.map((p, i) => ({ id: p.id, newPosition: String(i) }));
      await api.feeds.reorderProducts(selectedFeed.id, moves);
    } catch (e: any) {
      toast.error(e.message || "Kunne ikke endre rekkefølge");
      await loadFeedProducts(selectedFeed);
    }
  }, [selectedFeed, products, sortOrder, loadFeedProducts]);

  // ── Loading state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="ml-3 text-muted-foreground">Laster feeder fra Shopify…</span>
      </div>
    );
  }

  // ── Feed detail view ───────────────────────────────────────────────────────

  if (selectedFeed) {
    return (
      <DndProvider backend={HTML5Backend}>
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSelectedFeed(null);
                setProducts([]);
              }}
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div className="flex-1">
              <h2 className="text-lg font-semibold">{selectedFeed.title}</h2>
              <p className="text-sm text-muted-foreground">{products.length} produkter</p>
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-[240px]">
              <Select value={sortOrder} onValueChange={handleSortChange}>
                <SelectTrigger>
                  <span>{SORT_LABELS[sortOrder]}</span>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SORT_LABELS) as SortOption[]).map(key => (
                    <SelectItem key={key} value={key}>{SORT_LABELS[key]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Product table */}
          {loadingProducts ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : products.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <ImageIcon className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm font-medium">Ingen produkter i denne feeden ennå</p>
                <p className="text-xs text-muted-foreground mt-1">Bla i katalogen under for å legge til bøker</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead>
                      <tr className="bg-muted/50 text-xs text-muted-foreground uppercase tracking-wider">
                        {sortOrder === "MANUAL" && <th className="p-3 w-8" />}
                        <th className="p-3 w-14" />
                        <th className="p-3">Tittel</th>
                        <th className="p-3">Forfatter</th>
                        <th className="p-3">Forlag</th>
                        <th className="p-3 text-right">Pris</th>
                        <th className="p-3 w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((product, index) => (
                        <DraggableRow
                          key={product.id}
                          product={product}
                          index={index}
                          moveRow={moveRow}
                          onRemove={handleRemoveProduct}
                          isManual={sortOrder === "MANUAL"}
                          onDropEnd={handleDropEnd}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Catalog browser ────────────────────────────────────────────── */}
          <div className="pt-2 border-t border-border space-y-4">
            <div>
              <h3 className="text-sm font-semibold">Legg til bøker fra katalogen</h3>
              <p className="text-xs text-muted-foreground">Bla gjennom Shopify-katalogen – 10 bøker av gangen</p>
            </div>

            {/* Search + sort bar */}
            {catalogFetched && (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[200px] max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={catalogSearchInput}
                    onChange={e => handleCatalogSearchInput(e.target.value)}
                    placeholder="Søk på tittel, forfatter, ISBN eller forlag…"
                    className="pl-9 pr-9"
                  />
                  {catalogSearchInput && (
                    <button
                      type="button"
                      onClick={clearCatalogSearch}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <Select
                  value={catalogSort}
                  onValueChange={(v) => handleCatalogSortChange(v as CatalogSortKey)}
                  disabled={catalogLoading || isCatalogSearch}
                >
                  <SelectTrigger className="w-[190px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CATALOG_SORT_OPTIONS) as CatalogSortKey[]).map(key => (
                      <SelectItem key={key} value={key}>
                        {CATALOG_SORT_OPTIONS[key].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {isCatalogSearch && (
                  <span className="text-xs text-muted-foreground">
                    Søk: «{catalogSearchQuery}» · {catalogProducts.length} treff
                  </span>
                )}
              </div>
            )}

            {/* Catalog table */}
            {catalogLoading && !catalogFetched && (
              <div className="flex items-center justify-center h-24">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
                <span className="ml-2 text-sm text-muted-foreground">Henter katalog…</span>
              </div>
            )}

            {catalogFetched && catalogProducts.length === 0 && !catalogLoading && (
              <p className="text-sm text-muted-foreground text-center py-6">
                {isCatalogSearch ? "Ingen treff på søket." : "Ingen produkter funnet."}
              </p>
            )}

            {catalogFetched && catalogProducts.length > 0 && (() => {
              const existingIds = new Set(products.map(p => p.id));
              return (
                <>
                  <Card>
                    <CardContent className="p-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left">
                          <thead>
                            <tr className="bg-muted/50 text-xs text-muted-foreground uppercase tracking-wider">
                              <th className="p-3 w-14" />
                              <th className="p-3">Tittel</th>
                              <th className="p-3">Forfatter</th>
                              <th className="p-3">Forlag</th>
                              <th className="p-3 text-right">Pris</th>
                              <th className="p-3 w-28 text-center" />
                            </tr>
                          </thead>
                          <tbody>
                            {catalogProducts.map(p => {
                              const alreadyInFeed = existingIds.has(p.id);
                              const isAdding = addingProductId === p.id;
                              return (
                                <tr key={p.id} className={`border-t border-border hover:bg-muted/50 transition ${alreadyInFeed ? "opacity-50" : ""}`}>
                                  <td className="p-3 w-14">
                                    {p.imageUrl ? (
                                      <img src={p.imageUrl} alt="" className="w-10 h-14 object-cover rounded" />
                                    ) : (
                                      <div className="w-10 h-14 bg-muted rounded flex items-center justify-center">
                                        <ImageIcon className="w-4 h-4 text-muted-foreground" />
                                      </div>
                                    )}
                                  </td>
                                  <td className="p-3 font-medium">{p.title}</td>
                                  <td className="p-3 text-muted-foreground">{p.productType}</td>
                                  <td className="p-3 text-muted-foreground">{p.vendor}</td>
                                  <td className="p-3 text-right tabular-nums">{parseFloat(p.price || "0").toFixed(0)} kr</td>
                                  <td className="p-3 text-center">
                                    {alreadyInFeed ? (
                                      <span className="text-xs text-muted-foreground">I samlingen</span>
                                    ) : (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={isAdding}
                                        onClick={() => handleAddFromCatalog(p)}
                                      >
                                        {isAdding ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
                                        Legg til
                                      </Button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Pagination */}
                  <div className="flex items-center justify-between">
                    <Button variant="outline" size="sm" onClick={catalogPrev} disabled={catalogPageIdx === 0 || catalogLoading}>
                      <ChevronLeft className="w-4 h-4 mr-1" /> Forrige
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      Side {catalogPageIdx + 1}
                      {catalogLoading && <Loader2 className="w-3 h-3 animate-spin inline ml-2" />}
                    </span>
                    <Button variant="outline" size="sm" onClick={catalogNext} disabled={!catalogHasNext || catalogLoading}>
                      Neste <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </DndProvider>
    );
  }

  // ── Feed list view ─────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Feeder</h2>
          <p className="text-sm text-muted-foreground">Administrer manuelle samlinger i Shopify</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="w-4 h-4 mr-1" /> Ny feed</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Opprett ny feed</DialogTitle>
              <DialogDescription>
                Feeden opprettes som en manuell samling (collection) i Shopify.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 pt-2">
              <div className="space-y-1.5">
                <Label htmlFor="feed-title">Navn</Label>
                <Input
                  id="feed-title"
                  value={newFeedTitle}
                  onChange={e => setNewFeedTitle(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleCreate()}
                  placeholder="F.eks. Anbefalinger, Nyheter, Forhåndssalg"
                  autoFocus
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => { setCreateOpen(false); setNewFeedTitle(""); }}>
                  Avbryt
                </Button>
                <Button onClick={handleCreate} disabled={creating || !newFeedTitle.trim()}>
                  {creating ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Oppretter…</> : "Opprett"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {feeds.length === 0 ? (
        <Card>
          <CardContent className="text-center py-16">
            <ImageIcon className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="font-medium">Ingen feeder funnet i Shopify</p>
            <p className="text-sm text-muted-foreground mt-1">Klikk «Ny feed» for å opprette en samling</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {feeds.map(feed => (
            <Card
              key={feed.id}
              className="overflow-hidden hover:border-primary/40 transition cursor-pointer group"
              onClick={() => loadFeedProducts(feed)}
            >
              <FeedMosaic images={feed.productImages ?? []} />
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium group-hover:text-primary transition">{feed.title}</p>
                  <p className="text-xs text-muted-foreground">{feed.productsCount} produkter</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive opacity-0 group-hover:opacity-100 transition hover:bg-destructive/10"
                  onClick={e => { e.stopPropagation(); handleDelete(feed); }}
                  title="Slett feed"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
