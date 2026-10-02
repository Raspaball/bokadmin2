// supabase/functions/_shared/job-log.ts
// Én rad per produkt per jobb i sync_log (pakke F del 3.1), med utfall og årsak i
// egne kolonner (migrasjon 20261002150000_job_log_outcome.sql), så loggen kan
// telles og eksporteres (src/app/utils/jobLog.ts, CSV med hoppet over og feil).
//
//   outcome   endret | uendret | hoppet_over | feil
//             I sjekkmodus betyr «endret» at jobben ville endret (meldingen sier «Ville endret»).
//   reason    årsak når outcome = hoppet_over (SKIP_REASONS)
//   fields    feltene som ble (eller ville blitt) endret
//
// `status` (success/info/error) settes ut fra utfallet, som før, så eldre visninger virker.
// Ren TypeScript (testes i scripts/job-log.test.mjs).

export const OUTCOMES = ["endret", "uendret", "hoppet_over", "feil"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const SKIP_REASONS = {
  ingen_isbn: "ingen ISBN",
  ikke_bok: "ikke bok",
  ikke_i_bokbasen: "ikke i Bokbasen",
  beskyttet: "beskyttet",
  duplikat: "duplikat",
  egen_pris: "egen pris/tilbud",
  egen_tilgjengelighet: "egen tilgjengelighet",
  paa_lager: "på lager",
  arkivert: "arkivert",
} as const;
export type SkipReason = keyof typeof SKIP_REASONS;

export const NO_ISBN_MESSAGE = "Hoppet over: ingen ISBN";

export type LogBase = {
  isbn?: string | null;
  title?: string | null;
  action: string;
  shopify_id?: string | null;
  job_id: string;
  user_id?: string | null;
};

export type JobLogRow = LogBase & {
  status: "success" | "info" | "error";
  outcome: Outcome;
  reason: SkipReason | null;
  fields: string[] | null;
  message: string;
};

const STATUS: Record<Outcome, JobLogRow["status"]> = { endret: "success", uendret: "info", hoppet_over: "info", feil: "error" };

export function logRow(
  base: LogBase,
  outcome: Outcome,
  message: string,
  opts: { reason?: SkipReason | null; fields?: readonly string[] | null } = {},
): JobLogRow {
  return {
    ...base,
    status: STATUS[outcome],
    outcome,
    reason: outcome === "hoppet_over" ? opts.reason ?? null : null,
    fields: opts.fields?.length ? [...opts.fields] : null,
    message,
  };
}

export const skipRow = (base: LogBase, reason: SkipReason, message: string) => logRow(base, "hoppet_over", message, { reason });
export const errorRow = (base: LogBase, message: string) => logRow(base, "feil", message);
export const unchangedRow = (base: LogBase, message = "Uendret") => logRow(base, "uendret", message);
export const changedRow = (base: LogBase, message: string, fields: readonly string[]) => logRow(base, "endret", message, { fields });
