// scripts/bokbasen-ny/probe-liste.mjs
// Prøver listeoppslaget i Bokbasen fra egen maskin (bare lesing, ingen enkeltoppslag).
// Krever BOKBASEN_CLIENT_ID og BOKBASEN_CLIENT_SECRET i scripts/.env.local (ikke i git).
// Bruk: node scripts/bokbasen-ny/probe-liste.mjs [v3|v2] [after=yyyyMMddHHmmss] [bunker=2] [pagesize=50]
// Rå XML fra første bunke lagres i scripts/out/bokbasen-ny/ (ikke i git).
import { writeFileSync, mkdirSync } from "node:fs";
import { fail } from "../lib/clients.mjs"; // laster scripts/.env.local

const version = process.argv[2] ?? "v3";
const after = process.argv[3] ?? new Date(Date.now() - 864e5).toISOString().replace(/\D/g, "").slice(0, 14);
const maxPages = Number(process.argv[4] ?? 2);
const pagesize = process.argv[5] ?? "50";
if (!process.env.BOKBASEN_CLIENT_ID || !process.env.BOKBASEN_CLIENT_SECRET) fail("Mangler BOKBASEN_CLIENT_ID / BOKBASEN_CLIENT_SECRET i scripts/.env.local.");

const auth = await fetch("https://auth.bokbasen.io/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_id: process.env.BOKBASEN_CLIENT_ID, client_secret: process.env.BOKBASEN_CLIENT_SECRET, audience: "https://api.bokbasen.io/metadata/", grant_type: "client_credentials" }),
});
if (!auth.ok) fail(`Bokbasen-innlogging feilet (HTTP ${auth.status}).`);
const token = (await auth.json()).access_token;
mkdirSync("scripts/out/bokbasen-ny", { recursive: true });

let next = null, total = 0;
for (let p = 0; p < maxPages; p++) {
  const params = new URLSearchParams({ subscription: process.env.BOKBASEN_SUBSCRIPTION || "extended", pagesize });
  if (next) params.set("next", next); else params.set("after", after);
  const t0 = Date.now();
  const r = await fetch(`https://api.bokbasen.io/metadata/export/onix/${version}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const xml = await r.text();
  const n = (xml.match(/<Product[\s>]/g) || []).length;
  total += n;
  const types = {};
  for (const m of xml.matchAll(/<NotificationType>(\d+)</g)) types[m[1]] = (types[m[1]] || 0) + 1;
  console.log(`bunke ${p + 1}: HTTP ${r.status}, ${Date.now() - t0} ms, ${(xml.length / 1024).toFixed(0)} kB, ${n} poster, typer ${JSON.stringify(types)}`);
  if (p === 0) {
    console.log("  svar-headere:", [...r.headers.keys()].join(", "));
    writeFileSync(`scripts/out/bokbasen-ny/probe-${version}.xml`, xml);
  }
  if (!r.ok) { console.log(xml.slice(0, 300)); break; }
  next = r.headers.get("next");
  console.log("  Next-header:", next ? `ja (${next.length} tegn)` : "nei", "| Link-header:", r.headers.get("link") ? "ja" : "nei");
  if (!next || n === 0) break;
}
console.log("sum poster:", total);
