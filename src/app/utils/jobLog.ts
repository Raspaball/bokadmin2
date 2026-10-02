// src/app/utils/jobLog.ts
// Livstegn og logg per jobb (pakke F del 3.2 og 3.4).
//
// Kanonisk kilde for utfall og årsaker: OUTCOMES / SKIP_REASONS i
// supabase/functions/_shared/job-log.ts (Vite-koden importerer ikke fra supabase/) —
// hold dem like. Livstegnet (jobs.heartbeat_at, last_isbn) settes av triggeren i
// migrasjon 20261002150000_job_log_outcome.sql ved hver oppdatering av jobbraden.
// Brukt av JobHealth.tsx (Oppdatering, Tilgjengelighet, Oppdater eksisterende bøker, Sjangre).

export const SKIP_REASON_LABELS: Record<string, string> = {
  ingen_isbn: "ingen ISBN",
  ikke_bok: "ikke bok",
  ikke_i_bokbasen: "ikke i Bokbasen",
  beskyttet: "beskyttet",
  duplikat: "duplikat",
  egen_pris: "egen pris/tilbud",
  egen_tilgjengelighet: "egen tilgjengelighet",
  paa_lager: "på lager",
  arkivert: "arkivert",
};

export const OUTCOME_LABELS: Record<string, string> = {
  endret: "endret",
  uendret: "uendret",
  hoppet_over: "hoppet over",
  feil: "feil",
};

/** En jobb som ikke har oppdatert raden på så lenge, står stille. */
export const STALLED_AFTER_MS = 5 * 60 * 1000;

export interface JobPulse {
  status: string;
  heartbeat_at?: string | null;
  started_at?: string | null;
  created_at: string;
}

/** Siste livstegn: heartbeat_at, ellers start (før migrasjonen fantes ikke kolonnen). */
export function lastPulse(job: JobPulse): number {
  return Date.parse(job.heartbeat_at ?? job.started_at ?? job.created_at);
}

/** Minutter siden siste livstegn når en aktiv jobb står stille, ellers null. */
export function stalledMinutes(job: JobPulse, now = Date.now()): number | null {
  if (job.status !== "running" && job.status !== "paused" && job.status !== "pending") return null;
  const t = lastPulse(job);
  if (!Number.isFinite(t) || now - t < STALLED_AFTER_MS) return null;
  return Math.floor((now - t) / 60_000);
}

export interface JobLogRow {
  isbn: string | null;
  title: string | null;
  action: string;
  status: string;
  outcome?: string | null;
  reason?: string | null;
  fields?: string[] | null;
  message: string;
  shopify_id: string | null;
  created_at: string;
}

const BOM = String.fromCharCode(0xfeff);
function csvCell(v: string): string {
  return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Semikolonseparert CSV (Excel på norsk) med det som ble hoppet over og feil i én jobb. */
export function jobLogCsv(rows: JobLogRow[]): string {
  const header = ["Utfall", "Årsak", "ISBN", "Handle", "Melding", "Felt", "Shopify-ID", "Tid"];
  const lines = rows.map((r) => [
    OUTCOME_LABELS[r.outcome ?? ""] ?? (r.status === "error" ? "feil" : r.status),
    r.reason ? SKIP_REASON_LABELS[r.reason] ?? r.reason : "",
    r.isbn ?? "", r.title ?? "", r.message, (r.fields ?? []).join(", "), r.shopify_id ?? "",
    new Date(r.created_at).toLocaleString("nb-NO"),
  ].map((c) => csvCell(String(c))).join(";"));
  return BOM + [header.join(";"), ...lines].join("\r\n") + "\r\n";
}

/** «hoppet over: 12 ikke bok, 3 beskyttet; feil: 1» */
export function summarizeProblems(rows: JobLogRow[]): string {
  const skipped: Record<string, number> = {};
  let errors = 0;
  for (const r of rows) {
    if (r.outcome === "feil" || (!r.outcome && r.status === "error")) errors++;
    else if (r.outcome === "hoppet_over") {
      const k = SKIP_REASON_LABELS[r.reason ?? ""] ?? "annet";
      skipped[k] = (skipped[k] ?? 0) + 1;
    }
  }
  const s = Object.entries(skipped).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");
  return [s ? `hoppet over: ${s}` : "", errors ? `feil: ${errors}` : ""].filter(Boolean).join("; ") || "ingen hoppet over eller feil";
}
