// supabase/functions/_shared/availability.ts
// ONIX List 65 (ProductAvailability) → status i Shopify, metafeltet
// bok.tilgjengelighet og om boka skal kunne kjøpes. Én regel for
// tilgjengelighetssjekken, push og CSV-eksporten. Ren TypeScript uten
// Deno-API-er, slik at scripts/*.test.mjs kan teste den.
// Full referanse: https://ns.editeur.org/onix/nb/65
//
// Regel (Eirik 2026-10-02, pakke C): kommende og midlertidig utsolgte bøker
// skal være synlige og kunne kjøpes, ikke utkast (utkast gir 404 og mister
// søketrafikken).
//
//   20–23        ACTIVE    kan kjøpes                 tilgjengelig
//   10, 11, 12   ACTIVE    kan kjøpes (forhåndsbest.)  kommer
//   30–34        ACTIVE    kan kjøpes (vi bestiller)   midlertidig_utsolgt
//   43, 46, 49   ARCHIVED  nei                         utgatt
//   alt annet    DRAFT     nei                         ikke_tilgjengelig
//                (også tom eller ukjent kode)
//
// «Kan kjøpes» gjelder uansett lagerbeholdning: varianter med sporet lager og
// inventoryPolicy DENY får CONTINUE (se needsContinuePolicy). Beholdning,
// sporing og lokasjoner endres ikke.
//
// Frontend har en kopi i src/app/utils/availabilityCodes.ts (Vite-koden
// importerer ikke fra supabase/) — hold dem like.

export type ShopifyStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

export const TILGJENGELIGHET_VALUES = [
  "tilgjengelig",
  "kommer",
  "midlertidig_utsolgt",
  "utgatt",
  "ikke_tilgjengelig",
] as const;

export type Tilgjengelighet = (typeof TILGJENGELIGHET_VALUES)[number];

export interface AvailabilityRule {
  /** ONIX-koden slik den kom inn (tom streng når den mangler) */
  code: string;
  status: ShopifyStatus;
  tilgjengelighet: Tilgjengelighet;
  /** Skal kunne kjøpes uansett lager */
  buyable: boolean;
}

export function availabilityRule(code: string | null | undefined): AvailabilityRule {
  const c = String(code ?? "").trim();
  const num = /^\d{1,2}$/.test(c) ? parseInt(c, 10) : NaN;
  const r = (status: ShopifyStatus, tilgjengelighet: Tilgjengelighet, buyable: boolean): AvailabilityRule =>
    ({ code: c, status, tilgjengelighet, buyable });
  if (num >= 20 && num <= 23) return r("ACTIVE", "tilgjengelig", true);
  if (num >= 10 && num <= 12) return r("ACTIVE", "kommer", true);
  if (num >= 30 && num <= 34) return r("ACTIVE", "midlertidig_utsolgt", true);
  if (num === 43 || num === 46 || num === 49) return r("ARCHIVED", "utgatt", false);
  return r("DRAFT", "ikke_tilgjengelig", false);
}

/** Varianten må få inventoryPolicy CONTINUE for at boka skal kunne kjøpes uansett lager. */
export function needsContinuePolicy(
  rule: AvailabilityRule,
  variant: { inventoryPolicy?: string | null; inventoryItem?: { tracked?: boolean | null } | null } | null | undefined,
): boolean {
  if (!rule.buyable || !variant) return false;
  return variant.inventoryItem?.tracked === true && variant.inventoryPolicy !== "CONTINUE";
}

/** "2026-11-15" → "15.11.2026". Annet kommer uendret tilbake. */
export function formatNorwegianDate(iso: string | null | undefined): string {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso ?? "");
}

/**
 * Kort beskrivelse til loggen:
 *   «Kommer 15.11.2026: ACTIVE, kan forhåndsbestilles»
 *   «Midlertidig utsolgt: ACTIVE, kan bestilles»
 *   «Tilgjengelig: ACTIVE»
 *   «Utgått (kode 43): ARCHIVED»
 *   «Ikke tilgjengelig (kode 40): DRAFT»
 */
export function availabilityDescription(rule: AvailabilityRule, publishingDate?: string | null): string {
  const code = rule.code ? `kode ${rule.code}` : "ingen kode";
  switch (rule.tilgjengelighet) {
    case "kommer":
      return `Kommer${publishingDate ? ` ${formatNorwegianDate(publishingDate)}` : ""}: ${rule.status}, kan forhåndsbestilles`;
    case "midlertidig_utsolgt":
      return `Midlertidig utsolgt: ${rule.status}, kan bestilles`;
    case "tilgjengelig":
      return `Tilgjengelig: ${rule.status}`;
    case "utgatt":
      return `Utgått (${code}): ${rule.status}`;
    default:
      return `Ikke tilgjengelig (${code}): ${rule.status}`;
  }
}

/**
 * metafieldsSet-input for bok.tilgjengelighet og bok.utgivelsesdato.
 * Utgivelsesdatoen tas bare med når den er en hel dato (YYYY-MM-DD).
 */
export function availabilityMetafields(ownerId: string, rule: AvailabilityRule, publishingDate?: string | null) {
  const fields: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [
    { ownerId, namespace: "bok", key: "tilgjengelighet", type: "single_line_text_field", value: rule.tilgjengelighet },
  ];
  if (publishingDate && /^\d{4}-\d{2}-\d{2}$/.test(publishingDate)) {
    fields.push({ ownerId, namespace: "bok", key: "utgivelsesdato", type: "date", value: publishingDate });
  }
  return fields;
}
