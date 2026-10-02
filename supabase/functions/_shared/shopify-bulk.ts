// supabase/functions/_shared/shopify-bulk.ts
// Shopify Bulk Operations (2026-07) via shopifyGraphQL(): staged upload av JSONL,
// bulkOperationRunMutation, bulkOperationRunQuery, status, og strømming av
// resultatfiler linje for linje. Brukes av handle-migreringen (shopify) og
// bulk-modus i book-update. Definer ikke slike kall lokalt i en funksjon.

import { shopifyGraphQL } from "./shopify.ts";

export const BULK_ACTIVE = ["CREATED", "RUNNING", "CANCELING"];

export interface BulkOperation {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: string | number | null;
  url: string | null;
  partialDataUrl: string | null;
}

/** Laster opp JSONL og starter bulkOperationRunMutation. Returnerer operasjons-ID. */
export async function startBulkMutation(mutation: string, jsonl: string, filename = "bulk.jsonl"): Promise<string> {
  const staged = await shopifyGraphQL(
    `mutation ($filename: String!) { stagedUploadsCreate(input: [{ resource: BULK_MUTATION_VARIABLES, filename: $filename, mimeType: "text/jsonl", httpMethod: POST }]) { stagedTargets { url parameters { name value } } userErrors { field message } } }`,
    { filename },
  );
  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error(`Opplasting feilet: ${JSON.stringify(staged.data?.stagedUploadsCreate?.userErrors)}`);

  const form = new FormData();
  for (const p of target.parameters as { name: string; value: string }[]) form.append(p.name, p.value);
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), filename);
  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) throw new Error(`Opplasting til Shopify feilet (HTTP ${up.status}).`);
  const key = (target.parameters as { name: string; value: string }[]).find((p) => p.name === "key")?.value;

  const run = await shopifyGraphQL(
    `mutation ($mutation: String!, $path: String!) { bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) { bulkOperation { id status } userErrors { field message } } }`,
    { mutation, path: key },
  );
  const op = run.data?.bulkOperationRunMutation?.bulkOperation;
  if (!op?.id) {
    const errs = run.data?.bulkOperationRunMutation?.userErrors ?? [];
    throw new Error(`Bulk-jobben startet ikke: ${errs.map((e: { message: string }) => e.message).join("; ") || "ukjent feil"}`);
  }
  return op.id;
}

/** Starter bulkOperationRunQuery. Returnerer operasjons-ID. */
export async function startBulkQuery(query: string): Promise<string> {
  const r = await shopifyGraphQL(
    `mutation ($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { id status } userErrors { field message } } }`,
    { query },
  );
  const op = r.data?.bulkOperationRunQuery?.bulkOperation;
  if (!op?.id) {
    const errs = r.data?.bulkOperationRunQuery?.userErrors ?? [];
    throw new Error(`Bulk-spørringen startet ikke: ${errs.map((e: { message: string }) => e.message).join("; ") || "ukjent feil"}`);
  }
  return op.id;
}

export async function getBulkOperation(id: string): Promise<BulkOperation | null> {
  const r = await shopifyGraphQL(
    `query ($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode objectCount url partialDataUrl } } }`,
    { id },
  );
  return r.data?.node ?? null;
}

/** Venter på operasjonen til `deadline` (ms). Returnerer den (ev. fortsatt aktiv). */
export async function waitForBulkOperation(id: string, deadline: number, intervalMs = 2000): Promise<BulkOperation | null> {
  for (;;) {
    const op = await getBulkOperation(id);
    if (!op || !BULK_ACTIVE.includes(op.status) || Date.now() + intervalMs > deadline) return op;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Leser en JSONL-fil fra Shopify linje for linje uten å holde hele fila i minnet. */
export async function streamJsonlLines(url: string, onLine: (line: string) => void): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Kunne ikke hente bulk-resultat (HTTP ${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value;
    let i: number;
    while ((i = rest.indexOf("\n")) >= 0) {
      onLine(rest.slice(0, i));
      rest = rest.slice(i + 1);
    }
  }
  if (rest.trim()) onLine(rest);
}

/** Hele resultatfila som tekst (resultater fra mutasjoner er små). */
export async function fetchBulkText(url: string | null): Promise<string> {
  if (!url) return "";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kunne ikke hente bulk-resultat (HTTP ${res.status})`);
  return await res.text();
}
