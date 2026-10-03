// supabase/functions/_shared/bulk-retry.ts
// Forbigående feil på enkeltlinjer i en bulk-mutasjon (pakke G del 4c). Funnet i
// tilgjengelighetsjobben ed219b4f (2026-10-03): én linje feilet med «This product is
// currently being modified. Please try again later.», fordi bokdata-jobben samtidig
// oppdaterte det samme produktet. Slike linjer sendes på nytt i en egen, liten
// bulk-operasjon (høyst MAX_LINE_RETRIES ganger) før de logges som feil.
// Ren TypeScript (testes i scripts/).

export const MAX_LINE_RETRIES = 2;

/** Shopify ber om å prøve igjen senere: produktet endres av noe annet akkurat nå, eller tjenesten er opptatt. */
export function isTransientLineError(message: string | null | undefined): boolean {
  return /currently being modified|try again later|please try again|temporarily unavailable|internal server error|timed? ?out/i.test(String(message ?? ""));
}

export interface RetryableOp<R> { jsonl: string; refs: R[]; retry?: number }

/**
 * Fordeler de mislykkede linjene: de som kan prøves på nytt (forbigående feil og ikke brukt opp
 * forsøkene) og de som skal logges som feil. `failed` er linjenummer (fra 0) med feilmelding.
 */
export function splitRetries<R>(op: RetryableOp<R>, failed: ReadonlyMap<number, string>): {
  retry: RetryableOp<R> | null;
  errors: Array<{ line: number; ref: R; error: string }>;
} {
  const lines = op.jsonl.split("\n");
  const attempt = op.retry ?? 0;
  const retryIdx: number[] = [];
  const errors: Array<{ line: number; ref: R; error: string }> = [];
  op.refs.forEach((ref, line) => {
    const error = failed.get(line);
    if (error === undefined) return;
    if (attempt < MAX_LINE_RETRIES && isTransientLineError(error)) retryIdx.push(line);
    else errors.push({ line, ref, error });
  });
  return {
    retry: retryIdx.length ? { jsonl: retryIdx.map((i) => lines[i]).join("\n"), refs: retryIdx.map((i) => op.refs[i]), retry: attempt + 1 } : null,
    errors,
  };
}
