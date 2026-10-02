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
 * `withTilgjengelighet: false` (egen tilgjengelighet) gir bare datoen.
 */
export function availabilityMetafields(
  ownerId: string,
  rule: AvailabilityRule,
  publishingDate?: string | null,
  withTilgjengelighet = true,
) {
  const fields: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [];
  if (withTilgjengelighet) {
    fields.push({ ownerId, namespace: "bok", key: "tilgjengelighet", type: "single_line_text_field", value: rule.tilgjengelighet });
  }
  if (publishingDate && /^\d{4}-\d{2}-\d{2}$/.test(publishingDate)) {
    fields.push({ ownerId, namespace: "bok", key: "utgivelsesdato", type: "date", value: publishingDate });
  }
  return fields;
}

// ── Egen tilgjengelighet og arkiverte produkter (pakke E del 2 og 3) ─────────
//
// bok.egen_tilgjengelighet = true («Egen tilgjengelighet (Bokadmin endrer ikke
// status)»): butikken styrer selv om boka er synlig og kan kjøpes, f.eks.
// engelske bøker som har kode 40 i Bokbasen, men kjøpes fra andre leverandører.
// Tilgjengelighetsjobben og push endrer da ikke status, inventoryPolicy eller
// bok.tilgjengelighet. Alt annet (også bok.utgivelsesdato) oppdateres som før.
// Definisjonen lages med scripts/egen-tilgjengelighet-definisjon.mjs.
//
// Arkiverte produkter (ARCHIVED) endres aldri av tilgjengelighetsjobben.

/** GraphQL-felt på produktet */
export const EGEN_TILGJENGELIGHET_FIELD =
  `egenTilgjengelighet: metafield(namespace: "bok", key: "egen_tilgjengelighet") { value }`;

export const OWN_AVAILABILITY_MESSAGE = "Hoppet over: egen tilgjengelighet";
export const ARCHIVED_MESSAGE = "Hoppet over: arkivert";

/** Er bok.egen_tilgjengelighet krysset av? Godtar `"true"`, `true` eller `{ value }`. */
export function ownAvailability(value: unknown): boolean {
  const v = value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value;
  return v === true || String(v).trim().toLowerCase() === "true";
}

export interface AvailabilityChanges {
  status?: { from: string; to: string };
  tilgjengelighet?: { from: string | null; to: string };
  utgivelsesdato?: { from: string | null; to: string };
  /** inventoryPolicy DENY → CONTINUE (sporet lager), slik at boka kan kjøpes uansett lager */
  continuePolicy?: boolean;
}

/** Det tilgjengelighetsjobben trenger å vite om produktet i Shopify. */
export interface AvailabilityProduct {
  status: string;
  tilgjengelighet?: { value: string } | null;
  utgivelsesdato?: { value: string } | null;
  egenTilgjengelighet?: { value: string } | null;
  variant?: { inventoryPolicy?: string | null; inventoryItem?: { tracked?: boolean | null } | null } | null;
}

export interface AvailabilityPlan {
  /** Det som skal endres (tomt objekt = ingenting) */
  changes: AvailabilityChanges;
  /** Egen tilgjengelighet: det regelen ville endret, men som står (tomt = ingenting holdt tilbake) */
  heldBack: AvailabilityChanges;
  ownAvailability: boolean;
}

/** Hoppes produktet helt over? Sjekkes før ONIX hentes. */
export function availabilitySkip(product: { status?: string | null }): "arkivert" | null {
  return product.status === "ARCHIVED" ? "arkivert" : null;
}

/**
 * Hva som må endres for å følge regelen. Med egen tilgjengelighet flyttes
 * status, bok.tilgjengelighet og inventoryPolicy til `heldBack`; bare
 * utgivelsesdatoen endres. Arkiverte produkter: se availabilitySkip.
 */
export function planAvailability(product: AvailabilityProduct, rule: AvailabilityRule, date: string | null): AvailabilityPlan {
  const all: AvailabilityChanges = {};
  if (product.status !== rule.status) all.status = { from: product.status || "ukjent", to: rule.status };
  const currentTilg = product.tilgjengelighet?.value ?? null;
  if (currentTilg !== rule.tilgjengelighet) all.tilgjengelighet = { from: currentTilg, to: rule.tilgjengelighet };
  const currentDate = product.utgivelsesdato?.value ?? null;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && currentDate !== date) all.utgivelsesdato = { from: currentDate, to: date };
  if (needsContinuePolicy(rule, product.variant)) all.continuePolicy = true;

  const own = ownAvailability(product.egenTilgjengelighet);
  if (!own) return { changes: all, heldBack: {}, ownAvailability: false };
  const { utgivelsesdato, ...heldBack } = all;
  return { changes: utgivelsesdato ? { utgivelsesdato } : {}, heldBack, ownAvailability: true };
}

/** «status DRAFT → ACTIVE, tilgjengelighet → kommer, utgivelsesdato → 2026-11-15, salg uten lager» */
export function describeAvailabilityChanges(c: AvailabilityChanges): string {
  const parts: string[] = [];
  if (c.status) parts.push(`status ${c.status.from} → ${c.status.to}`);
  if (c.tilgjengelighet) parts.push(`tilgjengelighet ${c.tilgjengelighet.from ?? "mangler"} → ${c.tilgjengelighet.to}`);
  if (c.utgivelsesdato) parts.push(`utgivelsesdato ${c.utgivelsesdato.from ?? "mangler"} → ${c.utgivelsesdato.to}`);
  if (c.continuePolicy) parts.push("salg uten lager (inventoryPolicy CONTINUE)");
  return parts.join(", ");
}

/**
 * Loggteksten for én bok, eller null når ingenting endres eller holdes tilbake.
 *   «Ville endret: Kommer 15.11.2026: ACTIVE, kan forhåndsbestilles (status DRAFT → ACTIVE)»
 *   «Hoppet over: egen tilgjengelighet (regelen: Ikke tilgjengelig (kode 40): DRAFT; ville endret status ACTIVE → DRAFT)»
 *   «Endret: utgivelsesdato … → …. Hoppet over: egen tilgjengelighet (…)»
 */
export function availabilityLogMessage(
  plan: AvailabilityPlan,
  rule: AvailabilityRule,
  date: string | null,
  verb: "Ville endret" | "Endret",
): string | null {
  const parts: string[] = [];
  if (Object.keys(plan.changes).length) {
    const changed = describeAvailabilityChanges(plan.changes);
    parts.push(plan.ownAvailability ? `${verb}: ${changed}` : `${verb}: ${availabilityDescription(rule, date)} (${changed})`);
  }
  if (Object.keys(plan.heldBack).length) {
    parts.push(`${OWN_AVAILABILITY_MESSAGE} (regelen: ${availabilityDescription(rule, date)}; ville endret ${describeAvailabilityChanges(plan.heldBack)})`);
  }
  return parts.length ? parts.join(". ") : null;
}
