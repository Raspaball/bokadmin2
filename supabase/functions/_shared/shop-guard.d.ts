// Typer for shop-guard.js (Deno). Se shop-guard.js for regelen.
export declare const SAFE_SHOPS: string[];
export declare const MAX_LIVE_WINDOW_MS: number;
export declare function checkShopAllowed(p: {
  domain?: string | null; confirmed?: string | null; until?: string | null; now?: number;
}): { ok: boolean; live: boolean; reason?: string; expiresAt?: string };
export declare const READ_ONLY_MUTATIONS: string[];
export declare function liveReadOnly(value?: string | null): boolean;
export declare function graphQLOperations(query: string): { ok: boolean; mutations: string[][]; hasMutation: boolean };
export declare function checkWriteAllowed(p: {
  live: boolean; readOnly: boolean; query: string; allowed?: string[];
}): { ok: boolean; reason?: string; fields?: string[] };
export declare function jobShopMismatch(jobDomain?: string | null, currentDomain?: string | null): string | null;
