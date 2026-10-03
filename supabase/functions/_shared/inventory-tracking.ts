// supabase/functions/_shared/inventory-tracking.ts
// Lagersporing (pakke G del 2). Nettbokhandelen fører ikke lagerstatus: bestillinger
// går til en sentralleverandør som sender direkte til kunden, og det er ingen vits i å
// synke nettbutikken med den fysiske bokhandelen. Derfor skal INGEN bok ha «Spor
// beholdning» på (Shopify: inventoryItem.tracked). Uten sporing kan en bok alltid
// kjøpes uansett inventoryPolicy, så CONTINUE trengs ikke for sporede bøker som slås av.
//
// Policyen ligger fast i koden (ingen innstilling). Ren TypeScript (testes i scripts/).

/** Bøker spores aldri. */
export const TRACK_INVENTORY = false;

/**
 * Beholdning går foran Bokbasen (pakke F del 2.1: «aldri utkast/arkivert når boka har
 * lager»). Gjelder ikke lenger: butikken fører ikke lager, så Bokbasen avgjør alene.
 */
export const STOCK_BEFORE_BOKBASEN = false;

/** Varianten har sporing på, og skal ha den av. */
export function needsUntrack(variant: { inventoryItem?: { tracked?: boolean | null } | null } | null | undefined): boolean {
  return !TRACK_INVENTORY && variant?.inventoryItem?.tracked === true;
}

/** Beholdningen jobben tar hensyn til: alltid 0 så lenge butikken ikke fører lager. */
export function effectiveStock(totalInventory: number | null | undefined): number {
  return STOCK_BEFORE_BOKBASEN ? Number(totalInventory ?? 0) : 0;
}

/** Feltet i ProductVariantsBulkInput som slår av sporing (productVariantsBulkUpdate). */
export const UNTRACK_VARIANT_FIELDS = Object.freeze({ inventoryItem: { tracked: false } });
