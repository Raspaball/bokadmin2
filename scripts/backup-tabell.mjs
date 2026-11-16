// scripts/backup-tabell.mjs — kopi av tabeller i Supabase 2.0 til en mappe utenfor repoet.
// Bare lesing. Trinn 0 i «Bokbasen ny» (16.11.2026).
//
// Nøkler fra scripts/.env.local (git-ignorert): SUPABASE_URL og SUPABASE_SERVICE_ROLE_KEY
// (service role eller en «secret key» sb_secret_…; anon-nøkkelen ser ikke alle radene).
//
//   node scripts/backup-tabell.mjs --out C:\Bokadmin-backup\2026-11-16 sync_log jobs books ...
//   node scripts/backup-tabell.mjs --out <mappe> --verify sync_log      (kontroll av en kopi)
//
// Hver tabell blir <tabell>.jsonl.gz: én rad per linje (JSON), lest side for side i fast
// rekkefølge (sync_log: created_at, id; ellers primærnøkkelen) med nøkkelbasert blaing,
// så ingen rad hoppes over eller kommer to ganger.

import { createGzip, createGunzip } from "node:zlib";
import { createWriteStream, createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fail } from "./lib/clients.mjs"; // laster scripts/.env.local

const PROJECT_REF = "chwpqwblqummlufqdefe"; // Bokadmin 2.0 — aldri den gamle
const PAGE = 1000;
const NEVER = new Set(["user_settings", "shop_profiles", "onix_cache"]); // hemmeligheter / kan hentes på nytt
const ORDER = { sync_log: ["created_at", "id"], bokgruppe_cache: ["isbn"] }; // ellers ["id"]

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
if (outIdx < 0 || !args[outIdx + 1]) fail("Mangler --out <mappe>.");
const outDir = resolve(args[outIdx + 1]);
const verify = args.includes("--verify");
const tables = args.filter((a, i) => !a.startsWith("--") && i !== outIdx + 1);
if (!tables.length) fail("Oppgi minst én tabell.");

const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
if (!url || !key) fail("Mangler SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY i scripts/.env.local.");
if (!url.includes(PROJECT_REF)) fail(`SUPABASE_URL peker ikke på Bokadmin 2.0 (${PROJECT_REF}). Stopper.`);
if (/bokadmin 2\.0/i.test(outDir)) fail("Kopien skal ligge utenfor repoet (C:\\Bokadmin-backup\\…).");
for (const t of tables) if (NEVER.has(t)) fail(`${t} kopieres ikke (hemmeligheter eller cache).`);

const headers = { apikey: key, Accept: "application/json" };
if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;

async function rest(path, extra = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers: { ...headers, ...extra } });
    if (res.ok) return res;
    const body = await res.text();
    if (attempt < 4 && (res.status >= 500 || res.status === 429)) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    fail(`HTTP ${res.status} for ${path.split("?")[0]}: ${body.slice(0, 300)}`);
  }
}

async function countRows(table) {
  const res = await rest(`${table}?select=*&limit=1`, { Prefer: "count=exact" });
  return Number((res.headers.get("content-range") || "").split("/")[1]);
}

const q = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Filter for «etter siste rad» med nøkkelbasert blaing over én eller to kolonner. */
function afterFilter(cols, last) {
  if (!last) return "";
  if (cols.length === 1) return `&${cols[0]}=gt.${encodeURIComponent(last[cols[0]])}`;
  const [a, b] = cols;
  const or = `(${a}.gt.${q(last[a])},and(${a}.eq.${q(last[a])},${b}.gt.${q(last[b])}))`;
  return `&or=${encodeURIComponent(or)}`;
}

async function* readTable(table) {
  const cols = ORDER[table] || ["id"];
  const order = cols.map((c) => `${c}.asc`).join(",");
  let last = null;
  for (;;) {
    const res = await rest(`${table}?select=*&order=${order}&limit=${PAGE}${afterFilter(cols, last)}`);
    const rows = await res.json();
    for (const r of rows) yield r;
    if (rows.length < PAGE) return;
    last = rows[rows.length - 1];
  }
}

async function backup(table) {
  const before = await countRows(table);
  const file = join(outDir, `${table}.jsonl.gz`);
  let n = 0;
  async function* lines() {
    for await (const r of readTable(table)) {
      n++;
      if (n % 20000 === 0) process.stdout.write(`  ${table}: ${n}/${before}\n`);
      yield JSON.stringify(r) + "\n";
    }
  }
  await pipeline(Readable.from(lines()), createGzip(), createWriteStream(file));
  const after = await countRows(table);
  const size = statSync(file).size;
  console.log(`${table}: ${n} rader skrevet (i basen før ${before}, etter ${after}), ${(size / 1e6).toFixed(1)} MB`);
  if (n !== before || n !== after) fail(`${table}: antall stemmer ikke.`);
}

async function readFileRows(table) {
  const file = join(outDir, `${table}.jsonl.gz`);
  if (!existsSync(file)) fail(`Finner ikke ${file}.`);
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  const rows = [];
  for await (const line of rl) if (line) rows.push(JSON.parse(line));
  return rows;
}

function sameRow(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = [];
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diff.push(k);
  return diff;
}

async function verifyTable(table) {
  const rows = await readFileRows(table);
  const ids = new Set(rows.map((r) => r.id ?? r.isbn));
  const perAction = {};
  let min = null, max = null;
  for (const r of rows) {
    if (table === "sync_log") perAction[r.action] = (perAction[r.action] || 0) + 1;
    if (r.created_at && (!min || r.created_at < min)) min = r.created_at;
    if (r.created_at && (!max || r.created_at > max)) max = r.created_at;
  }
  console.log(`${table}: ${rows.length} rader i fila, ${ids.size} unike, i basen nå ${await countRows(table)}`);
  console.log(`  eldste ${min}  nyeste ${max}`);
  if (table === "sync_log") console.log("  per action:", JSON.stringify(perAction));

  // Fem tilfeldige rader (pluss rader med linjeskift og norske tegn) sammenlignes felt for felt med basen.
  const picks = new Set();
  while (picks.size < Math.min(5, rows.length)) picks.add(rows[Math.floor(Math.random() * rows.length)]);
  const special = rows.find((r) => /\n/.test(r.message ?? "") && /[æøåÆØÅ]/.test(r.message ?? ""))
    || rows.find((r) => /[æøåÆØÅ]/.test(JSON.stringify(r)));
  if (special) picks.add(special);
  let ok = true;
  for (const r of picks) {
    const pk = r.id !== undefined ? "id" : "isbn";
    const res = await rest(`${table}?select=*&${pk}=eq.${encodeURIComponent(r[pk])}`);
    const [db] = await res.json();
    const diff = db ? sameRow(r, db) : ["(finnes ikke i basen)"];
    console.log(`  ${pk}=${r[pk]}: ${diff.length ? "ULIK: " + diff.join(", ") : "lik"}${r === special ? " (linjeskift/æøå)" : ""}`);
    if (diff.length) ok = false;
  }
  if (!ok) fail(`${table}: kontrollen er ikke grønn.`);
}

mkdirSync(outDir, { recursive: true });
for (const t of tables) await (verify ? verifyTable(t) : backup(t));
console.log(verify ? "Kontroll ferdig." : `Ferdig. Kopien ligger i ${outDir}`);
