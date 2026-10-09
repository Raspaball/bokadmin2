// src/lib/api.ts
// Drop this into your Figma Make project at src/app/utils/api.ts
//
// Setup:
//   1. In Figma Make → Settings → Environment variables:
//      VITE_SUPABASE_URL = https://xxxx.supabase.co
//      VITE_SUPABASE_ANON_KEY = eyJhbGci...
//   2. Install: npm install @supabase/supabase-js

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseKey);

// ── Types ────────────────────────────────────────────────────────────────────

export interface Book {
  id: string;
  isbn: string;
  title: string;
  author: string;
  authors: string[] | null; // «Fornavn Etternavn» i rekkefølge (null i rader fra før pakke B)
  publisher: string;
  year: string;
  format: string;
  price: number | null;
  description: string;
  image_url: string;
  genre: string;
  bokgruppe: string;
  bokgruppekode: string | null;
  varegruppe: string | null;
  vekt: number | null;
  stock: number;
  shopify_id: string | null;
  shopify_handle: string | null;
  shopify_variant_id: string | null;
  availability_code: string | null;
  availability_status: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Banner {
  id: string;
  title: string;
  subtitle: string;
  cta: string;
  link: string;
  bg_color: string;
  active: boolean;
  sort_order: number;
}

export interface SyncLogEntry {
  id: string;
  isbn: string | null;
  title: string | null;
  action: "push" | "update" | "csv_export" | "sjangre_enrich" | "sjangre_sync" | "bygg_meny" | "availability_check" | "availability_update" | "import_skipped" | "import_failed" | "handle_migrate" | "handle_rollback" | "book_update" | "tag_cleanup" | "tag_cleanup_rollback";
  status: "success" | "error" | "info";
  message: string;
  shopify_id: string | null;
  job_id: string | null;
  /** Utfall per produkt (pakke F del 3.1): endret | uendret | hoppet_over | feil. Eldre rader: null */
  outcome?: string | null;
  /** Årsak når produktet ble hoppet over (se utils/jobLog.ts) */
  reason?: string | null;
  fields?: string[] | null;
  created_at: string;
}

export interface Job {
  id: string;
  type: string;
  status: "pending" | "running" | "completed" | "failed" | "paused";
  total_items: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  current_isbn: string | null;
  /** Livstegn (pakke F del 3.2): settes av en trigger ved hver oppdatering av raden */
  heartbeat_at?: string | null;
  /** Siste ISBN jobben jobbet med (current_isbn tømmes når jobben pauses) */
  last_isbn?: string | null;
  error_message: string | null;
  config: Record<string, unknown>;
  result: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  type: string;
  cron_expr: string;
  config: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

export interface BokbasenSearchResult {
  isbn: string;
  title: string;
  author: string;
  authors?: string[]; // «Fornavn Etternavn» i rekkefølge (extractContributors i _shared/onix.js)
  authorRole?: string | null; // A01, ellers rollen til første bidragsyter
  publisher: string;
  year: string;
  format: string;
  price: number | null;
  priceReason?: string | null; // årsak når price mangler (choosePrice i _shared/price.ts)
  description: string;
  imageUrl: string;
  genre: string;
  bokgruppe: string;
  bokgruppekode: string;
  varegruppe: string;
  vekt: number | null;
  availability: string | null;
  publishingDate?: string | null; // utgivelsesdato YYYY-MM-DD (extractPublishingDate i _shared/onix.js)
}

export interface ShopifyCatalogProduct {
  id: string;
  handle: string;
  // Fra bok.isbn / strekkode / SKU (extractIsbn på serveren). Handle er ikke ISBN.
  isbn: string | null;
  title: string;
  productType: string;
  vendor: string;
  status: string;
  descriptionHtml: string;
  tags: string[];
  createdAt: string;
  price: string;
  compareAtPrice: string | null;
  sku: string;
  barcode: string;
  variantId: string;
  imageUrl: string;
  seoTitle: string;
  seoDescription: string;
  collections: string[];
}

export interface CatalogSnapshotMeta {
  id: string;
  created_at: string;
  label: string | null;
  product_count: number;
}

export interface CatalogSnapshot extends CatalogSnapshotMeta {
  products: ShopifyCatalogProduct[];
}

export interface UserSettings {
  user_id: string;
  shopify_shop_domain: string | null;
  shopify_access_token: string | null;
  shopify_shop_name: string | null;
  bokbasen_client_id: string | null;
  bokbasen_client_secret: string | null;
  bokbasen_subscription: string;
  max_price_change_pct?: number; // sperre mot store prishopp, standard 30 (se _shared/price-guard.ts)
  setup_completed: boolean;
  created_at: string;
  updated_at: string;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export const auth = {
  async signIn(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  },

  async signOut() {
    await supabase.auth.signOut();
  },

  async getSession() {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },

  onAuthStateChange(callback: (user: unknown) => void) {
    return supabase.auth.onAuthStateChange((_event, session) => {
      callback(session?.user ?? null);
    });
  },
};

// ── Books ────────────────────────────────────────────────────────────────────

export const books = {
  async getAll(): Promise<Book[]> {
    const allBooks: Book[] = [];
    const PAGE_SIZE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("books")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      allBooks.push(...(data ?? []));
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return allBooks;
  },

  async getStats(): Promise<{ total: number; withKode: number; withoutKode: number }> {
    const [totalRes, withoutRes] = await Promise.all([
      supabase.from("books").select("*", { count: "exact", head: true }),
      supabase.from("books").select("*", { count: "exact", head: true }).is("bokgruppekode", null),
    ]);
    const total = totalRes.count ?? 0;
    const withoutKode = withoutRes.count ?? 0;
    return { total, withKode: total - withoutKode, withoutKode };
  },

  async getWithoutKode(): Promise<Pick<Book, "id" | "isbn" | "title" | "author" | "publisher">[]> {
    const { data, error } = await supabase
      .from("books")
      .select("id, isbn, title, author, publisher")
      .is("bokgruppekode", null)
      .order("title");
    if (error) throw error;
    return data;
  },

  async getById(id: string): Promise<Book> {
    const { data, error } = await supabase
      .from("books")
      .select("*")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  },

  async upsert(book: Partial<Book>): Promise<Book> {
    const { data, error } = await supabase
      .from("books")
      .upsert({ ...book, updated_at: new Date().toISOString() }, { onConflict: "isbn" })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async update(id: string, updates: Partial<Book>): Promise<Book> {
    const { data, error } = await supabase
      .from("books")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async delete(id: string): Promise<void> {
    const { error } = await supabase.from("books").delete().eq("id", id);
    if (error) throw error;
  },

  async deleteAll(): Promise<void> {
    const { error } = await supabase.from("books").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) throw error;
  },

  async getFormatsByIsbn(isbns: string[]): Promise<Record<string, string>> {
    if (isbns.length === 0) return {};
    const { data, error } = await supabase
      .from("books")
      .select("isbn, format")
      .in("isbn", isbns);
    if (error) throw error;
    const map: Record<string, string> = {};
    for (const row of data ?? []) {
      if (row.format) map[row.isbn] = row.format;
    }
    return map;
  },

  // Subscribe to realtime changes
  subscribe(callback: (books: Book[]) => void) {
    return supabase
      .channel("books")
      .on("postgres_changes", { event: "*", schema: "public", table: "books" }, async () => {
        const all = await books.getAll();
        callback(all);
      })
      .subscribe();
  },
};

// ── Banners ──────────────────────────────────────────────────────────────────

export const banners = {
  async getAll(): Promise<Banner[]> {
    const { data, error } = await supabase
      .from("banners")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data;
  },

  async upsert(banner: Partial<Banner>): Promise<Banner> {
    const { data, error } = await supabase
      .from("banners")
      .upsert(banner)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async delete(id: string): Promise<void> {
    const { error } = await supabase.from("banners").delete().eq("id", id);
    if (error) throw error;
  },
};

// ── Sync log ─────────────────────────────────────────────────────────────────

export const syncLog = {
  async getRecent(limit = 50, actions?: string[]): Promise<SyncLogEntry[]> {
    let query = supabase
      .from("sync_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (actions?.length) query = query.in("action", actions);
    const { data, error } = await query;
    if (error) throw error;
    return data;
  },

  async getByJobId(jobId: string): Promise<SyncLogEntry[]> {
    const { data, error } = await supabase
      .from("sync_log")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },

  /** Alle rader i jobben som ble hoppet over eller feilet (for CSV), 1000 om gangen. */
  async getJobProblems(jobId: string): Promise<SyncLogEntry[]> {
    const all: SyncLogEntry[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("sync_log")
        .select("*")
        .eq("job_id", jobId)
        .or("outcome.in.(hoppet_over,feil),status.eq.error")
        .order("created_at", { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      all.push(...(data ?? []));
      if (!data || data.length < 1000) return all;
    }
  },

  /** Alle rader i jobben der noe ble (eller ville blitt) endret, 1000 om gangen (CSV for taggjobben). */
  async getJobChanges(jobId: string): Promise<SyncLogEntry[]> {
    const all: SyncLogEntry[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("sync_log")
        .select("*")
        .eq("job_id", jobId)
        .eq("outcome", "endret")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      all.push(...(data ?? []));
      if (!data || data.length < 1000) return all;
    }
  },

  async getByActions(actions: SyncLogEntry['action'][], limit = 30): Promise<SyncLogEntry[]> {
    const { data, error } = await supabase
      .from("sync_log")
      .select("*")
      .in("action", actions)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  },

  async add(entry: Omit<SyncLogEntry, "id" | "created_at">): Promise<void> {
    const { error } = await supabase.from("sync_log").insert(entry);
    if (error) throw error;
  },

  async deleteEntry(id: string): Promise<void> {
    const { error } = await supabase.from("sync_log").delete().eq("id", id);
    if (error) throw error;
  },
};

// ── Bokbasen Edge Function calls ─────────────────────────────────────────────

async function callEdgeFunction(path: string, options: RequestInit = {}): Promise<Response> {
  // Pass the user's JWT (not anon key) so Edge Functions can identify the user
  // and look up their per-user credentials from user_settings
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token ?? supabaseKey;

  const res = await fetch(`${supabaseUrl}/functions/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: supabaseKey,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Edge function error: ${res.status}`);
  }

  return res;
}

// ── Butikker (Innstillinger, live-sjekk 1) ───────────────────────────────────
// Client secret sendes bare inn (lagres i Vault på serveren) og kommer aldri tilbake.

export interface ShopProfile {
  id: string; name: string; domain: string; clientId: string;
  secretSaved: boolean; live: boolean; updatedAt: string;
}
export interface ActiveShopInfo {
  domain: string; clientId: string; source: "profile" | "env"; profileId: string | null; profileName: string | null;
  live: boolean; confirmed: string | null; until: string | null; readOnly: boolean;
}
export interface ShopsState {
  profiles: ShopProfile[];
  activeProfileId: string | null;
  liveUntil: string | null;
  readOnlyDb: boolean;
  readOnlyEnv: boolean;
  changedAt: string | null;
  active: ActiveShopInfo | null;
  activeError: string | null;
  activeJobs: { id: string; type: string; status: string }[];
  log: { at: string; action: string; from_domain: string | null; to_domain: string | null; live_until: string | null; ok: boolean; message: string | null }[];
}
export interface ShopTestResult {
  ok: boolean; error?: string; shopName?: string | null; shopDomain?: string | null; primaryDomain?: string | null;
  productsCount?: number | null; collectionsCount?: number | null; scopes?: string[];
}

export const shops = {
  async state(): Promise<ShopsState> {
    return (await callEdgeFunction("shopify/shops")).json();
  },
  async save(p: { id?: string; name: string; domain: string; clientId: string }): Promise<{ ok: boolean; id: string }> {
    return (await callEdgeFunction("shopify/shops/save", { method: "POST", body: JSON.stringify(p) })).json();
  },
  async saveSecret(id: string, secret: string): Promise<void> {
    await callEdgeFunction("shopify/shops/secret", { method: "POST", body: JSON.stringify({ id, secret }) });
  },
  async test(id: string): Promise<ShopTestResult> {
    return (await callEdgeFunction("shopify/shops/test", { method: "POST", body: JSON.stringify({ id }) })).json();
  },
  async switchTo(id: string | null, confirm: string, until: string | null): Promise<void> {
    await callEdgeFunction("shopify/shops/switch", { method: "POST", body: JSON.stringify({ id, confirm, until }) });
  },
  async close(): Promise<void> {
    await callEdgeFunction("shopify/shops/close", { method: "POST", body: "{}" });
  },
};

// ── User Settings ─────────────────────────────────────────────────────────────

export const userSettings = {
  async get(): Promise<UserSettings | null> {
    const { data, error } = await supabase
      .from("user_settings")
      .select("*")
      .single();
    if (error) return null;
    return data;
  },

  async save(settings: Partial<Omit<UserSettings, "user_id" | "created_at" | "updated_at">>): Promise<UserSettings> {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error("Ikke innlogget");

    const { data, error } = await supabase
      .from("user_settings")
      .upsert({ ...settings, user_id: userId }, { onConflict: "user_id" })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async completeSetup(): Promise<void> {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error("Ikke innlogget");

    const { error } = await supabase
      .from("user_settings")
      .upsert({ user_id: userId, setup_completed: true }, { onConflict: "user_id" });
    if (error) throw error;
  },

  // Claim alle legacy-bøker (user_id IS NULL) som tilhører innlogget bruker
  async claimLegacyData(): Promise<void> {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error("Ikke innlogget");

    await supabase
      .from("books")
      .update({ user_id: userId })
      .is("user_id", null);

    await supabase
      .from("sync_log")
      .update({ user_id: userId })
      .is("user_id", null);
  },
};

export const bokbasen = {
  // Search by title, author, or ISBN
  async search(query: string, field: "title" | "author" | "isbn"): Promise<BokbasenSearchResult[]> {
    const params = new URLSearchParams({ q: query, field });
    const res = await callEdgeFunction(`bokbasen/search?${params}`);
    const data = await res.json();
    // Single ISBN lookup returns one object directly; search returns { results: [] }
    if (Array.isArray(data)) return data;
    if (data.results) return data.results;
    if (data.isbn) return [data]; // Single result
    return [];
  },

  // Fetch full metadata for one ISBN
  async fetchIsbn(isbn: string): Promise<BokbasenSearchResult> {
    const res = await callEdgeFunction(`bokbasen/isbn/${isbn}`);
    return res.json();
  },

  // Fetch books changed in a date range
  async fetchDateRange(from: string, to: string): Promise<{ results: BokbasenSearchResult[]; total: number; pages: number; truncated?: boolean }> {
    const params = new URLSearchParams({ from, to });
    const res = await callEdgeFunction(`bokbasen/date-range?${params}`);
    return res.json();
  },

  // Batch ISBN → format lookup from Bokbasen ONIX
  async fetchFormats(isbns: string[]): Promise<Record<string, string>> {
    if (isbns.length === 0) return {};
    const res = await callEdgeFunction("bokbasen/formats", {
      method: "POST",
      body: JSON.stringify({ isbns }),
    });
    const data = await res.json();
    return data.formats ?? {};
  },

  // Enrich all DB books missing bokgruppekode by fetching from Bokbasen
  async enrichDb(): Promise<{ total: number; updated: number; noData: number; failed: number }> {
    const res = await callEdgeFunction("bokbasen/enrich-db", { method: "POST" });
    return res.json();
  },
};

export const shopify = {
  // Push one book to Shopify
  async pushBook(book: BokbasenSearchResult | Book): Promise<{ shopifyId: string; handle: string; variantId?: string; created?: boolean; warning?: string; priceNote?: string; availabilityNote?: string; status?: string; seoNote?: string; descriptionNote?: string; tagNote?: string; protectedNote?: string; skipNote?: string }> {
    const res = await callEdgeFunction("shopify/push", {
      method: "POST",
      body: JSON.stringify({ book }),
    });
    return res.json();
  },

  // Push multiple books to Shopify
  async pushBooks(bookList: (BokbasenSearchResult | Book)[]): Promise<Array<{ isbn: string; success: boolean; shopifyId?: string; handle?: string; error?: string; priceNote?: string; availabilityNote?: string; status?: string; seoNote?: string; descriptionNote?: string; tagNote?: string; protectedNote?: string; skipNote?: string }>> {
    const res = await callEdgeFunction("shopify/push-bulk", {
      method: "POST",
      body: JSON.stringify({ books: bookList }),
    });
    const data = await res.json();
    return data.results;
  },

  // Download Shopify CSV
  // Returnerer antall bøker som ikke kom med fordi handlen tilhører et beskyttet produkt
  async exportCSV(bookList: (BokbasenSearchResult | Book)[]): Promise<{ protectedSkipped: number }> {
    const res = await callEdgeFunction("shopify/export-csv", {
      method: "POST",
      body: JSON.stringify({ books: bookList }),
    });
    const csv = await res.text();
    // Bøker med handle på et beskyttet produkt (tagg gave/lokal/…) er ikke med i fila
    const protectedSkipped = Number(res.headers.get("X-Protected-Skipped") ?? 0);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shopify-products-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    return { protectedSkipped };
  },

  // Bygg megameny i Shopify Navigation
  async buildMenu(menuHandle = "kategorier"): Promise<{ success: boolean; itemsCount?: number }> {
    const res = await callEdgeFunction("shopify/build-menu", {
      method: "POST",
      body: JSON.stringify({ menuHandle }),
    });
    return res.json();
  },

  // Full catalog sync: tag all Shopify products + create Smart Collections
  async syncCollections(): Promise<{
    products: { total: number; updated: number; alreadyTagged: number; noKode: number; tagErrors: number };
    collections: {
      created: number; existing: number; errors: number; total: number;
      details: Array<{ code: string; level: number; title: string; status: string; id?: string; error?: string }>;
    };
  }> {
    const res = await callEdgeFunction("shopify/sync-collections", { method: "POST" });
    return res.json();
  },

  // Analyze collections: read-only scan of tags + collections (no writes)
  async analyzeCollections(): Promise<{
    totalProducts: number;
    alreadyTagged: number;
    needsTagging: number;
    unplaceable: number;
    collections: { existing: number; toCreate: number; total: number };
  }> {
    const res = await callEdgeFunction("shopify/analyze-collections");
    return res.json();
  },

  // Fetch total product count (single efficient query)
  async fetchCount(): Promise<number> {
    const res = await callEdgeFunction("shopify/count");
    const data = await res.json();
    return data.count as number;
  },

  // Fetch one page of the Shopify catalog (default 50 products)
  async fetchCatalogPage(after?: string, first?: number, sortKey?: string, reverse?: boolean): Promise<{
    products: ShopifyCatalogProduct[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
  }> {
    const res = await callEdgeFunction("shopify/catalog", {
      method: "POST",
      body: JSON.stringify({
        after: after ?? null,
        ...(first ? { first } : {}),
        ...(sortKey !== undefined ? { sortKey } : {}),
        ...(reverse !== undefined ? { reverse } : {}),
      }),
    });
    return res.json();
  },

  // Search Shopify catalog by title, author, ISBN or vendor
  async searchCatalog(query: string, after?: string, first?: number): Promise<{
    products: ShopifyCatalogProduct[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
  }> {
    const res = await callEdgeFunction("shopify/catalog/search", {
      method: "POST",
      body: JSON.stringify({ query, after: after ?? null, ...(first ? { first } : {}) }),
    });
    return res.json();
  },

  // Push title / productType / price changes back to Shopify
  async updateCatalogProducts(
    changes: Array<{ productId: string; title?: string; productType?: string; vendor?: string; variantId?: string; price?: string }>
  ): Promise<Array<{ productId: string; success: boolean; error?: string }>> {
    const res = await callEdgeFunction("shopify/catalog/update", {
      method: "POST",
      body: JSON.stringify({ changes }),
    });
    const data = await res.json();
    return data.results;
  },
};

// ── Catalog Snapshots ────────────────────────────────────────────────────────

export const catalogSnapshots = {
  async getAll(): Promise<CatalogSnapshotMeta[]> {
    const { data, error } = await supabase
      .from("shopify_catalog_snapshots")
      .select("id, created_at, label, product_count")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },

  async getById(id: string): Promise<CatalogSnapshot> {
    const { data, error } = await supabase
      .from("shopify_catalog_snapshots")
      .select("*")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  },

  async save(snapshot: Omit<CatalogSnapshot, "id" | "created_at">): Promise<CatalogSnapshotMeta> {
    const { data, error } = await supabase
      .from("shopify_catalog_snapshots")
      .insert({
        label: snapshot.label,
        product_count: snapshot.product_count,
        products: snapshot.products,
      })
      .select("id, created_at, label, product_count")
      .single();
    if (error) throw error;
    return data;
  },

  async delete(id: string): Promise<void> {
    const { error } = await supabase
      .from("shopify_catalog_snapshots")
      .delete()
      .eq("id", id);
    if (error) throw error;
  },
};

// ── Price Update Jobs ───────────────────────────────────────────────────────

// ── Prisendringer som krever godkjenning (sperre mot store prishopp) ───────────

export interface PriceApproval {
  id: string;
  isbn: string;
  title: string | null;
  shopify_product_id: string;
  shopify_variant_id: string;
  old_price: number | null;
  new_price: number;
  change_pct: number | null;
  source: "price-update" | "push";
  status: "pending" | "approved" | "rejected";
  job_id: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
}

export const priceApprovals = {
  async listPending(): Promise<PriceApproval[]> {
    const { data, error } = await supabase
      .from("price_approvals")
      .select("*")
      .eq("status", "pending")
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    return data ?? [];
  },

  async listDecided(limit = 20): Promise<PriceApproval[]> {
    const { data, error } = await supabase
      .from("price_approvals")
      .select("*")
      .neq("status", "pending")
      .order("decided_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },

  // Godkjenn (setter ny pris i Shopify) eller avvis
  async decide(ids: string[], decision: "approve" | "reject"): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const res = await callEdgeFunction("price-update/approvals/decide", {
      method: "POST",
      body: JSON.stringify({ ids, decision }),
    });
    return (await res.json()).results;
  },
};

export const priceJobs = {
  // mode sendes alltid eksplisitt. Uten mode gjør serveren bare en sjekk.
  async start(mode: "analyze" | "update"): Promise<{ jobId: string }> {
    const res = await callEdgeFunction("price-update/start", {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
    return res.json();
  },

  async getStatus(jobId: string): Promise<Job> {
    const res = await callEdgeFunction(`price-update/status/${jobId}`);
    return res.json();
  },

  async getActive(): Promise<Job | null> {
    const res = await callEdgeFunction("price-update/active");
    return res.json();
  },

  async getRecent(limit = 10): Promise<Job[]> {
    const res = await callEdgeFunction(`price-update/recent?limit=${limit}`);
    return res.json();
  },

  async resume(jobId: string): Promise<void> {
    await callEdgeFunction(`price-update/resume/${jobId}`, { method: "POST" });
  },

  async cancel(jobId: string): Promise<void> {
    await callEdgeFunction(`price-update/cancel/${jobId}`, { method: "POST" });
  },
};

// ── Availability Check Jobs ──────────────────────────────────────────────────

export const availabilityJobs = {
  /** bulk (standard): hele katalogen med Shopify Bulk Operations og onix_cache (pakke E del 5) */
  async start(mode: "analyze" | "update" = "analyze", bulk = true): Promise<{ jobId: string }> {
    const res = await callEdgeFunction("availability-check/start", {
      method: "POST",
      body: JSON.stringify({ mode, bulk }),
    });
    return res.json();
  },

  async getStatus(jobId: string): Promise<Job> {
    const res = await callEdgeFunction(`availability-check/status/${jobId}`);
    return res.json();
  },

  async getActive(): Promise<Job | null> {
    const res = await callEdgeFunction("availability-check/active");
    return res.json();
  },

  async getRecent(limit = 10): Promise<Job[]> {
    const res = await callEdgeFunction(`availability-check/recent?limit=${limit}`);
    return res.json();
  },

  async resume(jobId: string): Promise<void> {
    await callEdgeFunction(`availability-check/resume/${jobId}`, { method: "POST" });
  },

  async cancel(jobId: string): Promise<void> {
    await callEdgeFunction(`availability-check/cancel/${jobId}`, { method: "POST" });
  },
};

// ── Oppdater eksisterende bøker (pakke B del 8, Edge Function book-update) ───

export interface BookUpdateCounts {
  changed: number;
  unchanged: number;
  skippedNoIsbn: number;
  skippedNoOnix: number;
  skippedProtected?: number;
  skippedDuplicate?: number;
  errors: number;
  fields: Record<string, { count: number; examples: string[] }>;
  notes: Record<string, number>;
}

export const bookUpdateJobs = {
  // mode sendes alltid eksplisitt; uten mode gjør serveren bare en sjekk
  // bulk: hele katalogen med Shopify Bulk Operations (pakke D del 3)
  async start(mode: "analyze" | "update", isbns?: string[], bulk = false): Promise<{ jobId: string; error?: string }> {
    const res = await callEdgeFunction("book-update/start", {
      method: "POST",
      body: JSON.stringify({ mode, ...(isbns?.length ? { isbns } : {}), ...(bulk ? { bulk: true } : {}) }),
    });
    return res.json();
  },
  async getStatus(jobId: string): Promise<Job> {
    return (await callEdgeFunction(`book-update/status/${jobId}`)).json();
  },
  async getActive(): Promise<Job | null> {
    return (await callEdgeFunction("book-update/active")).json();
  },
  async getRecent(limit = 5): Promise<Job[]> {
    return (await callEdgeFunction(`book-update/recent?limit=${limit}`)).json();
  },
  async resume(jobId: string): Promise<void> {
    await callEdgeFunction(`book-update/resume/${jobId}`, { method: "POST" });
  },
  async cancel(jobId: string): Promise<void> {
    await callEdgeFunction(`book-update/cancel/${jobId}`, { method: "POST" });
  },
};

// ── Rydd tagger (tag_cleanup) ────────────────────────────────────────────────

export interface TagCleanupResult {
  summary?: string;
  mode?: "analyze" | "update";
  counts?: { cleaned: number; tagsRemoved: number; alreadyClean: number; errors: number; skippedNoIsbn: number; skippedProtected: number; skippedDuplicate: number; notInScope: number };
  topTags?: Array<[string, number]>;
  topTagsComplete?: boolean;
  examples?: Array<{ handle: string; fjernes: string[]; beholdes: string[] }>;
  rolledBackAt?: string;
}

export interface TagRollbackResult {
  mode: "analyze" | "update";
  products?: number; alreadyRestored?: number; remaining: number; tagsToRestore?: number;
  restored?: number; errors?: number; timedOut?: boolean; error?: string;
}

export const tagCleanup = {
  /** Sjekk (analyze) er standard. onlyIds = bare disse produktene (til en test). */
  async start(mode: "analyze" | "update" = "analyze", onlyIds?: string[]): Promise<{ jobId: string; status: string }> {
    const res = await callEdgeFunction("tag-cleanup/start", { method: "POST", body: JSON.stringify({ mode, ...(onlyIds?.length ? { onlyIds } : {}) }) });
    return res.json();
  },
  async getStatus(jobId: string): Promise<Job> {
    const res = await callEdgeFunction(`tag-cleanup/status/${jobId}`);
    return res.json();
  },
  async getActive(): Promise<Job | null> {
    const res = await callEdgeFunction("tag-cleanup/active");
    return res.json();
  },
  async getRecent(limit = 5): Promise<Job[]> {
    const res = await callEdgeFunction(`tag-cleanup/recent?limit=${limit}`);
    return res.json();
  },
  async resume(jobId: string): Promise<void> {
    await callEdgeFunction(`tag-cleanup/resume/${jobId}`, { method: "POST" });
  },
  async cancel(jobId: string): Promise<void> {
    await callEdgeFunction(`tag-cleanup/cancel/${jobId}`, { method: "POST" });
  },
  /** Legger de fjernede taggene tilbake. Sjekk først (standard); kall igjen mens timedOut er true. */
  async rollback(jobId: string, mode: "analyze" | "update" = "analyze", productIds?: string[]): Promise<TagRollbackResult> {
    const res = await callEdgeFunction("tag-cleanup/rollback", { method: "POST", body: JSON.stringify({ jobId, mode, ...(productIds?.length ? { productIds } : {}) }) });
    return res.json();
  },
};

// ── Sjangre Sync Jobs ────────────────────────────────────────────────────────

export interface SjangreSyncAnalyzeResult {
  totalBooks: number;
  booksWithKode: number;
  booksWithoutKode: number;
  totalShopifyProducts: number;
  collections: { existing: number; toCreate: number; total: number };
}

export interface SjangreSyncJobResult {
  products: { total: number; tagged: number; already_tagged: number; no_product: number; errors: number; skipped_protected?: number; skipped_duplicate?: number };
  collections: { created: number; existing: number; renamed?: number; errors: number; total: number; toCreate?: number; toRename?: number; details: Array<{ code: string; status: string; error?: string; from?: string; to?: string }> };
  /** Bulk-jobben (pakke E del 5): sammendrag med tider */
  summary?: string;
}

export const sjangreSync = {
  async analyze(): Promise<SjangreSyncAnalyzeResult> {
    const res = await callEdgeFunction("sjangre-sync/analyze");
    return res.json();
  },

  /** Bulk-jobb: koder fra Bokbasen, bkg-tagger og samlinger. Sjekk (analyze) er standard. */
  async start(mode: "analyze" | "update" = "analyze"): Promise<{ jobId: string; status: string }> {
    const res = await callEdgeFunction("sjangre-sync/start", { method: "POST", body: JSON.stringify({ mode, bulk: true }) });
    return res.json();
  },

  async getStatus(jobId: string): Promise<Job> {
    const res = await callEdgeFunction(`sjangre-sync/status/${jobId}`);
    return res.json();
  },

  async getActive(): Promise<Job | null> {
    const res = await callEdgeFunction("sjangre-sync/active");
    return res.json();
  },

  async resume(jobId: string): Promise<void> {
    await callEdgeFunction(`sjangre-sync/resume/${jobId}`, { method: "POST" });
  },

  async catalogStats(): Promise<{ byKode: Record<string, number>; total: number; withKode: number; withoutKode: number }> {
    const res = await callEdgeFunction("sjangre-sync/catalog-bkg-stats");
    return res.json();
  },

  async deleteEmptyCollections(): Promise<{ checked: number; deleted: number; errors: number }> {
    const res = await callEdgeFunction("sjangre-sync/delete-empty-collections", { method: "POST" });
    return res.json();
  },
};

export interface ShopifyEnrichJobResult {
  found_kode: number;
  already_cached: number;
  no_data: number;
  errors: number;
  total: number;
}

export const shopifyEnrich = {
  async start(): Promise<{ jobId: string; status: string }> {
    const res = await callEdgeFunction("sjangre-sync/enrich-start", { method: "POST" });
    return res.json();
  },

  async getStatus(jobId: string): Promise<Job> {
    const res = await callEdgeFunction(`sjangre-sync/status/${jobId}`);
    return res.json();
  },

  async getActive(): Promise<Job | null> {
    const res = await callEdgeFunction("sjangre-sync/enrich-active");
    return res.json();
  },

  async resume(jobId: string): Promise<void> {
    await callEdgeFunction(`sjangre-sync/enrich-resume/${jobId}`, { method: "POST" });
  },
};

// ── Scheduled Tasks ─────────────────────────────────────────────────────────

export const scheduledTasks = {
  async getAll(): Promise<ScheduledTask[]> {
    const { data, error } = await supabase
      .from("scheduled_tasks")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },

  async create(task: Partial<ScheduledTask>): Promise<ScheduledTask> {
    const { data, error } = await supabase
      .from("scheduled_tasks")
      .insert(task)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async update(id: string, updates: Partial<ScheduledTask>): Promise<ScheduledTask> {
    const { data, error } = await supabase
      .from("scheduled_tasks")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async delete(id: string): Promise<void> {
    const { error } = await supabase.from("scheduled_tasks").delete().eq("id", id);
    if (error) throw error;
  },
};

// ── Feeds (Shopify Manual Collections) ──────────────────────────────────────

export const feeds = {
  async list(): Promise<Array<{ id: string; title: string; handle: string; sortOrder: string; productsCount: number; image: string | null; productImages: string[] }>> {
    const res = await callEdgeFunction("shopify/feeds/list");
    return res.json();
  },

  async get(collectionId: string): Promise<{ collection: Record<string, unknown>; products: Array<Record<string, unknown>> }> {
    const res = await callEdgeFunction("shopify/feeds/get", {
      method: "POST",
      body: JSON.stringify({ collectionId }),
    });
    return res.json();
  },

  async create(title: string): Promise<{ id: string; title: string; handle: string }> {
    const res = await callEdgeFunction("shopify/feeds/create", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    return res.json();
  },

  async delete(collectionId: string): Promise<void> {
    await callEdgeFunction("shopify/feeds/delete", {
      method: "POST",
      body: JSON.stringify({ collectionId }),
    });
  },

  async addProducts(collectionId: string, productIds: string[]): Promise<void> {
    await callEdgeFunction("shopify/feeds/add-products", {
      method: "POST",
      body: JSON.stringify({ collectionId, productIds }),
    });
  },

  async removeProducts(collectionId: string, productIds: string[]): Promise<void> {
    await callEdgeFunction("shopify/feeds/remove-products", {
      method: "POST",
      body: JSON.stringify({ collectionId, productIds }),
    });
  },

  async update(collectionId: string, updates: { sortOrder?: string }): Promise<void> {
    await callEdgeFunction("shopify/feeds/update", {
      method: "POST",
      body: JSON.stringify({ collectionId, ...updates }),
    });
  },

  async reorderProducts(collectionId: string, moves: Array<{ id: string; newPosition: string }>): Promise<void> {
    await callEdgeFunction("shopify/feeds/reorder", {
      method: "POST",
      body: JSON.stringify({ collectionId, moves }),
    });
  },
};

// ── Handles (migrering ISBN-handle → tittel-forfatter-ISBN) ──────────────────
// Planen lages på serveren av supabase/functions/_shared/handle-migration.js.

export interface HandlePlanRow {
  id: string;
  status: string;
  title: string;
  author: string;
  isbn: string;
  oldHandle: string;
  newHandle: string;
  flags: string[];
  setIsbn: boolean;
}

export interface HandleAnalyzeResult {
  shopDomain: string;
  allowed: boolean;
  total: number;
  plan: HandlePlanRow[];
  skipped: { ingenIsbn: number; alleredeRiktig: number; egendefinert: number; beskyttet?: number };
  counts: { planned: number; withFlags: number; blocked: number; missingAuthor: number; ready: number };
}

export interface HandleJob extends Omit<Job, "status"> {
  status: Job["status"] | "finalizing";
  bulkStatus?: string;
}

export interface HandleVerifyResult {
  jobId: string;
  total: number;
  checked: number;
  ok: number;
  storefront: string | null;
  results: Array<{
    oldHandle: string;
    newHandle: string;
    target: string | null;
    ok: boolean;
    http: { status: number; location: string | null } | null;
  }>;
}

export interface HandleProtectedKept {
  id: string; title: string; isbn: string; handle: string; oldHandle: string; tag: string;
}

export interface HandleRollbackResult {
  jobId: string;
  total: number;
  restored: number;
  failed: number;
  /** Beskyttet (tagg gave/lokal/…): handle og videresending røres ikke */
  skippedProtected?: number;
  /** Beskyttede produkter som beholdt ny handle: kjøringen er da «delvis angret» */
  protectedKept?: HandleProtectedKept[];
  rollbackStatus?: "full" | "partial";
  remaining: number;
  timedOut: boolean;
  errors: string[];
}

// Merknader som stopper en rad (samme regel som isBlockingFlag i handle-migration.js)
export const isBlockingHandleFlag = (flag: string) => flag.startsWith("DUPLIKAT") || flag === "handle finnes allerede";

export const handles = {
  async status(jobId?: string): Promise<{ shopDomain: string; shopName: string | null; allowed: boolean; job: HandleJob | null }> {
    const res = await callEdgeFunction(jobId ? `shopify/handles/status/${jobId}` : "shopify/handles/status");
    return res.json();
  },

  async analyze(): Promise<HandleAnalyzeResult> {
    const res = await callEdgeFunction("shopify/handles/analyze", { method: "POST" });
    return res.json();
  },

  async migrate(productIds: string[], skipFlagged: boolean): Promise<{ jobId: string; total: number; skippedBlocked: number }> {
    const res = await callEdgeFunction("shopify/handles/migrate", {
      method: "POST",
      body: JSON.stringify({ productIds, skipFlagged }),
    });
    return res.json();
  },

  async verify(jobId?: string): Promise<HandleVerifyResult> {
    const res = await callEdgeFunction(`shopify/handles/verify${jobId ? `?jobId=${jobId}` : ""}`);
    return res.json();
  },

  // Én puls (maks ~40 s). Kall igjen så lenge timedOut er true.
  async rollback(jobId?: string): Promise<HandleRollbackResult> {
    const res = await callEdgeFunction("shopify/handles/rollback", {
      method: "POST",
      body: JSON.stringify(jobId ? { jobId } : {}),
    });
    return res.json();
  },
};

// ── Jobs (all types) ─────────────────────────────────────────────────────────

const JOB_TYPE_LABELS: Record<string, string> = {
  price_update: "Prisoppdatering",
  availability_check: "Tilgjengelighetssjekk",
  sjangre_sync: "Sjangre-sync",
  tag_cleanup: "Rydd tagger",
  shopify_enrich: "Shopify-berikelse",
  handle_migration: "Handle-migrering",
};

export const jobTypeLabel = (type: string) => JOB_TYPE_LABELS[type] ?? type;

export const jobs = {
  async getActive(): Promise<Job[]> {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .in("status", ["running", "paused", "pending"])
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  },

  async cancelOne(jobId: string): Promise<void> {
    const { error } = await supabase
      .from("jobs")
      .update({
        status: "failed",
        error_message: "Avbrutt av bruker",
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .in("status", ["running", "paused", "pending"]);
    if (error) throw error;
  },

  async cancelAll(): Promise<number> {
    const { data: active, error: selectError } = await supabase
      .from("jobs")
      .select("id")
      .in("status", ["running", "paused", "pending"]);
    if (selectError) throw selectError;
    if (!active?.length) return 0;
    const { error } = await supabase
      .from("jobs")
      .update({
        status: "failed",
        error_message: "Avbrutt av bruker",
        completed_at: new Date().toISOString(),
      })
      .in("status", ["running", "paused", "pending"]);
    if (error) throw error;
    return active.length;
  },
};

// ── Default export (namespace object) ───────────────────────────────────────

const api = {
  auth,
  books,
  banners,
  syncLog,
  userSettings,
  bokbasen,
  shopify,
  catalogSnapshots,
  priceJobs,
  availabilityJobs,
  sjangreSync,
  tagCleanup,
  shopifyEnrich,
  scheduledTasks,
  feeds,
  handles,
  jobs,
};

export default api;
