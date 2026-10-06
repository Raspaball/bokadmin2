// ONIX List 65 — ProductAvailability
// Frontend-kopi av regelen i supabase/functions/_shared/availability.ts
// (Vite-koden importerer ikke fra supabase/). Hold dem like.
// Full referanse: https://ns.editeur.org/onix/nb/65
//
// Regel (pakke C, 2026-10-02): kommende (10–12) og midlertidig utsolgte (30–34)
// bøker er ACTIVE og kan kjøpes, med bok.tilgjengelighet = kommer /
// midlertidig_utsolgt. 41, 43, 46, 47, 48, 49 → ARCHIVED. Alt annet → DRAFT.

export type ShopifyStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

// ── UI groups (importfilteret) ───────────────────────────────────────────────
// Hver gruppe gir én status i Shopify.

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
    label: "Kommer (forhåndsbestilling)",
    shopifyStatus: "ACTIVE" as ShopifyStatus,
    codes: ["10", "11", "12"],
    defaultOn: true,
  },
  {
    key: "temporary",
    label: "Midlertidig utsolgt",
    shopifyStatus: "ACTIVE" as ShopifyStatus,
    codes: ["30", "31", "32", "33", "34"],
    defaultOn: true,
  },
  {
    key: "not_available",
    label: "Ikke tilgjengelig",
    shopifyStatus: "DRAFT" as ShopifyStatus,
    // 01 = vil ikke utkomme, 09 = ikke utkommet (ingen dato), 40, 42, 44, 45, 50–52
    codes: ["01", "09", "40", "42", "44", "45", "50", "51", "52"],
    defaultOn: false,
  },
  {
    key: "permanent",
    label: "Utgått",
    shopifyStatus: "ARCHIVED" as ShopifyStatus,
    // 41 = erstattet, 43 = ikke lenger distribuert, 46 = trukket fra salg, 47/48 = ute av salg, 49 = tilbakekalt
    codes: ["41", "43", "46", "47", "48", "49"],
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

/** ONIX List 65-kode → status i Shopify. Kopi av availabilityRule() i _shared/availability.ts. */
export function mapAvailabilityToShopifyStatus(code: string | null | undefined): ShopifyStatus {
  const c = String(code ?? "").trim();
  const num = /^\d{1,2}$/.test(c) ? parseInt(c, 10) : NaN;
  if (num >= 20 && num <= 23) return "ACTIVE";
  if (num >= 10 && num <= 12) return "ACTIVE";
  if (num >= 30 && num <= 34) return "ACTIVE";
  if ([41, 43, 46, 47, 48, 49].includes(num)) return "ARCHIVED";
  return "DRAFT";
}
