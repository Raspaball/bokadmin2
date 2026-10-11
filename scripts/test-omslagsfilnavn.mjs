#!/usr/bin/env node
// scripts/test-omslagsfilnavn.mjs — test av nytt filnavn på omslagsbilder (oppgaver/test-omslagsfilnavn-5.md).
// Live-data: utvalg og målinger ligger i scripts/out/ (git-ignorert). Aldri i git.
//
//   node scripts/test-omslagsfilnavn.mjs --velg <eksport-mappe> --id <produkt-GID> [--id …]   # lager utvalget (lokalt)
//   node scripts/test-omslagsfilnavn.mjs --mal foer  --live --bekreft-butikk <domene>         # bare lesing + sikkerhetskopi
//   node scripts/test-omslagsfilnavn.mjs --mal etter [--merke 1t] --live --bekreft-butikk <domene>
//   node scripts/test-omslagsfilnavn.mjs --mal tilbake --live --bekreft-butikk <domene>
//   node scripts/test-omslagsfilnavn.mjs --live --bekreft-butikk <domene>                      # tørrkjøring av endring (sender ingenting)
//   node scripts/test-omslagsfilnavn.mjs --utfor --live --bekreft-butikk <domene>              # fileUpdate: nytt filnavn
//   node scripts/test-omslagsfilnavn.mjs --tilbake --utfor --live --bekreft-butikk <domene>    # fileUpdate: opprinnelig filnavn
//
// Eneste mutasjon er fileUpdate med bare id og filename (aldri alt). Bare med --utfor; ellers bare lesing.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { enableLive, shopifyGql, outDir, fail, sleep } from "./lib/clients.mjs";

globalThis.Deno ??= { env: { get: (k) => process.env[k] } };
const { coverFilename, fileNameFromUrl } = await import("../supabase/functions/_shared/book-cover.ts");

const args = process.argv.slice(2);
const option = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const flag = (n) => args.includes(`--${n}`);
const file = (n) => join(outDir, n);
const UTVALG = file("test-filnavn-utvalg.json");

// ── Utvalg (lokalt, bare lesing av eksporten) ───────────────────────────────
if (flag("velg")) {
  const dir = option("velg");
  const ids = args.flatMap((a, i) => (a === "--id" ? [args[i + 1]] : []));
  if (!dir || !ids.length) fail("Bruk: --velg <eksport-mappe> --id <GID> [--id …]");
  const want = new Set(ids), media = new Map(), prods = new Map();
  for (const l of readFileSync(join(dir, "products.jsonl"), "utf8").split("\n")) {
    if (!l) continue;
    const o = JSON.parse(l);
    if (!o.__parentId && want.has(o.id)) prods.set(o.id, o);
    else if (o.__parentId && want.has(o.__parentId) && o.id.includes("/MediaImage/") && !media.has(o.__parentId)) media.set(o.__parentId, o);
  }
  const out = ids.map((id) => ({ productId: id, title: prods.get(id)?.title, handle: prods.get(id)?.handle, mediaId: media.get(id)?.id, url: media.get(id)?.image?.url }));
  if (out.some((x) => !x.mediaId)) fail("Fant ikke produkt eller bilde for alle id-ene.");
  writeFileSync(UTVALG, JSON.stringify(out, null, 1));
  console.log(`Utvalg lagret: ${out.length} bøker (${UTVALG})`);
  process.exit(0);
}

if (!existsSync(UTVALG)) fail("Mangler utvalget. Kjør først --velg.");
const utvalg = JSON.parse(readFileSync(UTVALG, "utf8"));
const writing = flag("utfor");
enableLive({ allowedMutations: writing ? ["fileUpdate"] : [] });

const PRODUCT_QUERY = `query($id: ID!) { product(id: $id) {
  id handle title status descriptionHtml productType tags onlineStoreUrl
  seo { title description }
  resourcePublicationsCount { count }
  resourcePublicationsV2(first: 20) { nodes { publication { name } isPublished } }
  metafields(first: 50) { nodes { namespace key type value } }
  media(first: 20) { nodes { id alt status mediaContentType ... on MediaImage { image { url width height } } } }
} }`;

const butikk = (await shopifyGql(`{ shop { primaryDomain { url } } }`)).shop.primaryDomain.url;

async function head(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "manual" });
    return { status: r.status, contentLength: r.headers.get("content-length"), contentType: r.headers.get("content-type"), location: r.headers.get("location") };
  } catch (e) { return { feil: String(e.message ?? e) }; }
}

async function side(handle, filnavn) {
  try {
    const r = await fetch(`${butikk}/products/${handle}`, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (test-omslagsfilnavn)" } });
    const html = await r.text();
    const og = html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)/i)?.[1] ?? null;
    const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).filter((s) => s.includes("/files/") || s.includes("cdn.shopify.com"));
    const norm = (s) => (s ? (s.startsWith("//") ? "https:" + s : s) : s);
    return {
      status: r.status, finalUrl: r.url, passordSide: /\/password/.test(r.url),
      ogImage: norm(og), ogFilnavn: og ? fileNameFromUrl(norm(og)) : null,
      imgSrc: [...new Set(imgs.map(norm))].slice(0, 6), imgFilnavn: [...new Set(imgs.map((s) => fileNameFromUrl(norm(s))))].slice(0, 6),
      harGammeltFilnavn: filnavn ? html.includes(filnavn) : null,
    };
  } catch (e) { return { feil: String(e.message ?? e) }; }
}

async function mal(fase) {
  const foer = existsSync(file("test-filnavn-foer.json")) ? JSON.parse(readFileSync(file("test-filnavn-foer.json"), "utf8")) : null;
  const res = [], backup = [];
  for (const u of utvalg) {
    const p = (await shopifyGql(PRODUCT_QUERY, { id: u.productId })).product;
    if (!p) { res.push({ productId: u.productId, feil: "Produktet finnes ikke" }); continue; }
    const m = p.media.nodes.find((n) => n.id === u.mediaId);
    const url = m?.image?.url ?? null, filnavn = fileNameFromUrl(url);
    const gammel = foer?.find((x) => x.productId === u.productId);
    res.push({
      productId: u.productId, handle: p.handle, status: p.status, antallBilder: p.media.nodes.length, mediaId: u.mediaId, mediaStatus: m?.status ?? null,
      filnavn, url, urlHead: await head(url), side: await side(p.handle, filnavn),
      kanaler: p.resourcePublicationsV2.nodes.map((n) => `${n.publication.name}:${n.isPublished}`),
      ...(gammel && gammel.url !== url ? { gammelUrl: gammel.url, gammelUrlHead: await head(gammel.url), urlEndret: true, gammelSide: await side(p.handle, gammel.filnavn) } : { urlEndret: gammel ? false : null }),
    });
    if (fase === "foer") backup.push(p);
  }
  const navn = fase === "etter" && option("merke") ? `etter-${option("merke")}` : fase;
  writeFileSync(file(`test-filnavn-${navn}.json`), JSON.stringify(res, null, 1));
  if (fase === "foer") writeFileSync(file("test-filnavn-sikkerhetskopi.json"), JSON.stringify(backup, null, 1));
  console.log(`test-filnavn-${navn}.json: ${res.length} bøker${fase === "foer" ? " + sikkerhetskopi" : ""}`);
  res.forEach((r, i) => console.log(`${i + 1}. ${r.feil ?? `${r.status}, ${r.antallBilder} bilde(r), bilde ${r.mediaStatus}, HEAD ${r.urlHead?.status}, og:image ${r.side?.ogFilnavn}${r.urlEndret ? ", URL ENDRET (gammel: HEAD " + r.gammelUrlHead?.status + ")" : ""}`}`));
}

if (option("mal")) { await mal(option("mal")); process.exit(0); }

// ── Endring: fileUpdate med bare filename ───────────────────────────────────
const tilbake = flag("tilbake");
const foer = JSON.parse(readFileSync(file("test-filnavn-foer.json"), "utf8"));
const plan = utvalg.map((u) => {
  const f = foer.find((x) => x.productId === u.productId);
  if (!f?.url) fail("Mangler måling før for alle. Kjør --mal foer først.");
  return { ...u, filnavnFoer: f.filnavn, filnavnNytt: tilbake ? f.filnavn : coverFilename(f.handle, f.url) };
});
console.log(writing ? (tilbake ? "TILBAKEFØRING:" : "ENDRING:") : "TØRRKJØRING (sender ingenting):");
plan.forEach((p, i) => console.log(`${i + 1}. ${p.mediaId.split("/").pop()}: ${tilbake ? p.filnavnNytt + " (opprinnelig)" : p.filnavnFoer + " → " + p.filnavnNytt}`));
if (!writing) process.exit(0);

const MUT = `mutation($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id fileStatus ... on MediaImage { image { url } } } userErrors { field message code } } }`;
const logg = [];
for (const p of plan) {
  const r = (await shopifyGql(MUT, { files: [{ id: p.mediaId, filename: p.filnavnNytt }] })).fileUpdate;
  logg.push({ mediaId: p.mediaId, ny: p.filnavnNytt, svar: r });
  console.log(`${p.mediaId.split("/").pop()}: ${r.userErrors.length ? "FEIL " + JSON.stringify(r.userErrors) : r.files.map((f) => f.fileStatus).join(",")}`);
  if (r.userErrors.length) { writeFileSync(file(`test-filnavn-${tilbake ? "tilbake" : "endring"}-logg.json`), JSON.stringify(logg, null, 1)); fail("Stopper ved første feil."); }
}
// Vent på at bildeverktøyet er ferdig (fileStatus READY)
for (let i = 0; i < 60; i++) {
  const st = await Promise.all(plan.map(async (p) => (await shopifyGql(`query($id: ID!) { node(id: $id) { ... on MediaImage { status } } }`, { id: p.mediaId })).node?.status));
  if (st.every((s) => s === "READY")) { console.log("Alle READY."); break; }
  if (i === 59) console.log("Ikke alle READY etter 5 min:", st.join(","));
  await sleep(5000);
}
writeFileSync(file(`test-filnavn-${tilbake ? "tilbake" : "endring"}-logg.json`), JSON.stringify(logg, null, 1));
