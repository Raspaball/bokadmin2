// Typer for handle-migration.js (Deno). Se handle-migration.js for logikken.
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

export interface HandlePlan {
  total: number;
  plan: HandlePlanRow[];
  skipped: { ingenIsbn: number; alleredeRiktig: number; egendefinert: number };
  counts: { planned: number; withFlags: number; blocked: number; missingAuthor: number; ready: number };
}

export declare const SAFE_STORES: string[];
export declare const MIGRATION_PRODUCTS_QUERY: string;
export declare const HANDLE_UPDATE_MUTATION: string;
export declare const FLAG_MISSING_AUTHOR: string;
export declare const FLAG_LONG_HANDLE: string;
export declare const FLAG_DUPLICATE_ISBN: string;
export declare const FLAG_DUPLICATE_IN_PLAN: string;
export declare const FLAG_HANDLE_TAKEN: string;
export declare function isBlockingFlag(flag: string): boolean;
export declare function isBlockedRow(row: { flags: string[] }): boolean;
export declare function isIsbnHandle(handle: string | null | undefined): boolean;
// deno-lint-ignore no-explicit-any
export declare function planHandleMigration(products: any[], options?: { includeCustom?: boolean; limit?: number }): HandlePlan;
export declare function handleUpdateInput(row: { id: string; newHandle: string; isbn: string; setIsbn?: boolean }): {
  id: string;
  handle: string;
  redirectNewHandle: boolean;
  metafields?: Array<{ namespace: string; key: string; value: string }>;
};
