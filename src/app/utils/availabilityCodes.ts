// ONIX List 65 — ProductAvailability
// Canonical source for all availability code logic in Bokadmin.
// The edge function (availability-check/index.ts) has its own copy of the
// mapping functions (Deno can't import from src/), but must stay in sync.

export type ShopifyStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

// ── UI groups ────────────────────────────────────────────────────────────────
// Each group maps to exactly one Shopify status.

export const AVAILABILITY_OPTIONS = [
  {
    key: "available",
    label: "Tilgjengelig",
    shopifyStatus: "ACTIVE" as ShopifyStatus,
    codes: ["20", "21", "22", "23"],
    defaultOn: true,
  },
  {
    key: "coming",
    label: "Kommer / Ikke utgitt",
    shopifyStatus: "DRAFT" as ShopifyStatus,
    codes: ["01", "09", "10", "11", "12"],
    defaultOn: false,
  },
  {
    key: "temporary",
    label: "Midlertidig utilgjengelig",
    shopifyStatus: "DRAFT" as ShopifyStatus,
    // 44 = Apply direct (kan bestilles direkte fra forlaget — ikke permanent)
    // 45 = Not sold separately (selges kun i sett — ikke permanent)
    // 50 = Not sold as set
    codes: ["30", "31", "32", "33", "34", "40", "41", "42", "44", "45", "47", "48", "50", "51", "52"],
    defaultOn: false,
  },
  {
    key: "permanent",
    label: "Permanent utilgjengelig",
    shopifyStatus: "ARCHIVED" as ShopifyStatus,
    // 43 = No longer supplied by supplier
    // 46 = Withdrawn from sale
    // 49 = Recalled
    codes: ["43", "46", "49"],
    defaultOn: false,
  },
  {
    key: "unknown",
    label: "Ukjent / Se detaljer",
    shopifyStatus: "DRAFT" as ShopifyStatus,
    codes: ["97", "98", "99"],
    defaultOn: false,
  },
] as const;

export type AvailabilityKey = (typeof AVAILABILITY_OPTIONS)[number]["key"];

// ── Helpers ──────────────────────────────────────────────────────────────────

export function availabilityGroup(code: string | null | undefined): AvailabilityKey | null {
  if (!code) return null;
  for (const opt of AVAILABILITY_OPTIONS) {
    if ((opt.codes as readonly string[]).includes(code)) return opt.key;
  }
  return null;
}

export function availabilityLabel(code: string | null | undefined): string {
  if (!code) return "Ukjent";
  const group = AVAILABILITY_OPTIONS.find(o => (o.codes as readonly string[]).includes(code));
  return group ? group.label : `Kode ${code}`;
}

/** Maps an ONIX List 65 code to a Shopify product status.
 *  Mirror of mapAvailabilityToShopifyStatus() in availability-check/index.ts — keep in sync.
 *  ARCHIVED = truly permanent: 43 (no longer supplied), 46 (withdrawn), 49 (recalled).
 *  44 (apply direct) and 45 (not sold separately) are NOT permanent → DRAFT. */
export function mapAvailabilityToShopifyStatus(code: string | null | undefined): ShopifyStatus {
  const num = parseInt(code ?? "", 10);
  if (isNaN(num)) return "DRAFT";
  if (num >= 20 && num <= 23) return "ACTIVE";
  if (num === 43 || num === 46 || num === 49) return "ARCHIVED";
  return "DRAFT";
}
