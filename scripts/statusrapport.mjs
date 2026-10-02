#!/usr/bin/env node
// scripts/statusrapport.mjs
// Statusrapporten før live (pakke E del 4): kjører tilgjengelighetssjekken i
// sjekkmodus (endrer ingenting) og lagrer alle produkter som ville fått ny
// status som CSV: tittel, ISBN, ONIX-kode, gammel og ny status, og om «Egen
// tilgjengelighet» er krysset av. Samme liste vises på Oppdatering-siden
// (Tilgjengelighet), der den også kan lastes ned.
//
// KJØRING (fra prosjektmappa):
//   node scripts/statusrapport.mjs              # ny sjekk, så CSV
//   node scripts/statusrapport.mjs --job <id>   # CSV fra en ferdig sjekk
//
// Nøkler i scripts/.env.local: SUPABASE_URL og SUPABASE_ANON_KEY (Bokadmin 2.0).
// Utfil: scripts/out/statusendringer-<dato>.csv (git-ignorert).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureOutDir, fail, sleep } from "./lib/clients.mjs";
import { statusChangesCsv, statusLabel } from "../src/app/utils/statusReport.ts";

const BOKADMIN2_REF = "chwpqwblqummlufqdefe";
const url = (process.env.SUPABASE_URL || `https://${BOKADMIN2_REF}.supabase.co`).replace(/\/$/, "");
const key = process.env.SUPABASE_ANON_KEY;
if (!key) fail("Mangler SUPABASE_ANON_KEY (scripts/.env.local).");
if (!url.includes(BOKADMIN2_REF)) fail(`${url} er ikke Bokadmin 2.0. Stopper.`);

const call = async (path, method = "GET", body) => {
  const res = await fetch(`${url}/functions/v1/availability-check/${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : method === "POST" ? "{}" : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok && res.status !== 409) fail(`${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const jobArg = process.argv.indexOf("--job");
let jobId = jobArg > 0 ? process.argv[jobArg + 1] : null;
const t0 = Date.now();
if (!jobId) {
  const started = await call("start", "POST", { mode: "analyze" });
  if (!started?.jobId) fail(`Kunne ikke starte: ${JSON.stringify(started)}`);
  jobId = started.jobId;
  if (started.error) console.log(`${started.error} — venter på den.`);
}
console.log(`Tilgjengelighetssjekk ${jobId}`);

let job;
let lastResume = 0;
for (;;) {
  job = await call(`status/${jobId}`);
  process.stdout.write(`\r  ${Math.round((Date.now() - t0) / 1000)} s: ${job.status} ${job.processed ?? 0}/${job.total_items ?? "?"}    `);
  if (job.status === "completed" || job.status === "failed") break;
  if (job.status === "paused" && Date.now() - lastResume > 20_000) {
    lastResume = Date.now();
    await call(`resume/${jobId}`, "POST");
  }
  await sleep(5000);
}
console.log();
if (job.status !== "completed") fail(`Sjekken feilet: ${job.error_message ?? "ukjent feil"}`);
if ((job.config?.mode ?? "analyze") !== "analyze") console.log("NB: dette var en oppdatering, ikke en sjekk.");

const rows = job.result?.statusChanges ?? [];
const csv = statusChangesCsv(rows, job.result?.shopDomain);
const file = join(ensureOutDir(), `statusendringer-${new Date().toISOString().slice(0, 10)}.csv`);
writeFileSync(file, csv, "utf8");

const byChange = {};
for (const r of rows) {
  const k = `${statusLabel(r.from)} → ${statusLabel(r.to)}${r.own ? " (egen tilgjengelighet, endres ikke)" : ""}`;
  byChange[k] = (byChange[k] ?? 0) + 1;
}
console.log(`${rows.length} produkter ville fått ny status:`);
for (const [k, n] of Object.entries(byChange).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${k}`);
console.log(`Hoppet over: ${job.result?.skippedProtected ?? 0} beskyttet, ${job.result?.skippedArchived ?? 0} arkivert, ${job.result?.skippedDuplicate ?? 0} DUPLIKAT`);
console.log(`CSV: ${file}`);
