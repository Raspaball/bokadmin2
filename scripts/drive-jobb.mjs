#!/usr/bin/env node
// scripts/drive-jobb.mjs — gjenopptar en jobb hver gang den pauser, til den er ferdig eller feiler.
// Brukes for jobber uten pg_cron (tag-cleanup) eller når en jobb skal drives raskere enn pg_cron (1 min).
//   node scripts/drive-jobb.mjs <funksjon> <jobId> [--maks-minutter 90]
// Eksempel: node scripts/drive-jobb.mjs tag-cleanup 39043c8c-...
// Nøkler fra scripts/.env.local (SUPABASE_URL, SUPABASE_ANON_KEY). Gjør ingenting annet enn status og resume.
import "./lib/clients.mjs";
import { fail, sleep } from "./lib/clients.mjs";

const [fn, jobId] = process.argv.slice(2);
const maxMin = Number(process.argv.includes("--maks-minutter") ? process.argv[process.argv.indexOf("--maks-minutter") + 1] : 90);
if (!fn || !jobId) fail("Bruk: node scripts/drive-jobb.mjs <funksjon> <jobId>");
const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
if (!base?.includes("chwpqwblqummlufqdefe")) fail("SUPABASE_URL er ikke Bokadmin 2.0.");
const h = { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" };
const t0 = Date.now();
let last = "";
for (;;) {
  if (Date.now() - t0 > maxMin * 60_000) fail(`Gir opp etter ${maxMin} minutter.`);
  const j = await (await fetch(`${base}/functions/v1/${fn}/status/${jobId}`, { headers: h })).json().catch(() => null);
  if (!j?.status) { await sleep(5000); continue; }
  const line = `${j.status} ${j.processed}/${j.total_items}`;
  if (line !== last) { console.log(`${Math.round((Date.now() - t0) / 1000)} s: ${line}`); last = line; }
  if (j.status === "completed" || j.status === "failed") { console.log(j.status === "failed" ? `FEILET: ${j.error_message}` : "FERDIG"); process.exit(j.status === "failed" ? 2 : 0); }
  const stale = j.status === "running" && j.heartbeat_at && Date.now() - Date.parse(j.heartbeat_at) > 3 * 60_000;
  if (j.status === "paused" || stale) await fetch(`${base}/functions/v1/${fn}/resume/${jobId}`, { method: "POST", headers: h });
  await sleep(4000);
}
