// src/app/utils/statusReport.ts
// Statusrapporten før live (pakke E del 4): produktene som ville fått ny status
// av tilgjengelighetssjekken. Kommer fra jobs.result.statusChanges
// (availability-check). Brukt av TilgjengelighetTab.tsx (tabell + nedlasting)
// og scripts/statusrapport.mjs (CSV i scripts/out/).
//
// Kanonisk type: StatusChangeRow i supabase/functions/_shared/availability.ts.

export interface StatusChangeRow {
  id: string;
  handle: string;
  title: string;
  isbn: string;
  code: string;
  from: string;
  to: string;
  tilgjengelighet: string;
  /** Egen tilgjengelighet er krysset av: statusen står */
  own: boolean;
}

const STATUS_NB: Record<string, string> = { ACTIVE: 'aktiv', DRAFT: 'utkast', ARCHIVED: 'arkivert' };

/** «ACTIVE» → «aktiv» */
export function statusLabel(status: string): string {
  return STATUS_NB[status] ?? status;
}

/** Lenke til produktet i Shopify admin, eller null uten butikkdomene. */
export function shopifyAdminUrl(shopDomain: string | null | undefined, productGid: string): string | null {
  const id = productGid.split('/').pop();
  return shopDomain && id ? `https://${shopDomain}/admin/products/${id}` : null;
}

/** Sortering: først de som blir utkast/arkivert, så etter tittel. */
export function sortStatusChanges(rows: StatusChangeRow[]): StatusChangeRow[] {
  const rank = (r: StatusChangeRow) => (r.own ? 2 : r.to === 'ACTIVE' ? 1 : 0);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'nb'));
}

const BOM = String.fromCharCode(0xfeff);

function csvCell(v: string): string {
  return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Semikolonseparert CSV (Excel på norsk), med BOM så æøå vises riktig. */
export function statusChangesCsv(rows: StatusChangeRow[], shopDomain?: string | null): string {
  const header = ['Tittel', 'ISBN', 'ONIX-kode', 'Gammel status', 'Ny status (regelen)', 'Tilgjengelighet', 'Egen tilgjengelighet', 'Handle', 'Shopify'];
  const lines = sortStatusChanges(rows).map((r) => [
    r.title, r.isbn, r.code || '(ingen)', statusLabel(r.from), statusLabel(r.to),
    r.tilgjengelighet, r.own ? 'ja (endres ikke)' : 'nei', r.handle, shopifyAdminUrl(shopDomain, r.id) ?? r.id,
  ].map((c) => csvCell(String(c ?? ''))).join(';'));
  return BOM + [header.join(';'), ...lines].join('\r\n') + '\r\n';
}
