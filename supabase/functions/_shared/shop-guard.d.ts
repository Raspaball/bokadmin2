// Typer for shop-guard.js (Deno). Se shop-guard.js for regelen.
export declare const SAFE_SHOPS: string[];
export declare const MAX_LIVE_WINDOW_MS: number;
export declare function checkShopAllowed(p: {
  domain?: string | null; confirmed?: string | null; until?: string | null; now?: number;
}): { ok: boolean; live: boolean; reason?: string; expiresAt?: string };
