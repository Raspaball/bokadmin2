#!/usr/bin/env node
// scripts/skjulte-boker.mjs — kartlegging av aktive bøker som ikke er publisert i Online Store.
// BARE LESING: én bulk-spørring (kanalene til aktive produkter) mot live, ONIX fra Bokbasen
// (bokbasen/isbn/<isbn>?raw=true) og de samme delte reglene som jobbene bruker
// (channelsToPublish, availabilityRule, bookFormat, protectedProduct, chooseValidPrice).
// Skriver ingenting til Shopify eller Supabase.
//
//   node --experimental-strip-types scripts/skjulte-boker.mjs --live --bekreft-butikk <domenet> --mappe <eksport-mappe>
//   (--lokalt --mappe <eksport-mappe> bruker kanalfila fra forrige kjøring uten å kontakte live)
//
// Utfiler (scripts/out/, git-ignorert, inneholder live-data): skjulte-kanaler.jsonl,
// skjulte-detaljer.json (én rad per bok + sammendrag). Excel lages av scripts/skjulte-boker-xlsx.py.

import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { enableLive, shopifyGql, fail, sleep, outDir } from "./lib/clients.mjs";

globalThis.Deno ??= { env: { get: (k) => process.env[k] } };
const { availabilityRule } = await import("../supabase/functions/_shared/availability.ts");
const { bookFormat, isBookForm } = await import("../supabase/functions/_shared/book-format.ts");
const { chooseValidPrice } = await import("../supabase/functions/_shared/price.ts");
const { channelsToPublish, PUBLISHED_ON_BULK_FIELD } = await import("../supabase/functions/_shared/publish.ts");
const { protectedProduct, setProtectedMembers, PROTECTED_COLLECTION_HANDLES } = await import("../supabase/functions/_shared/protected.ts");
const { extractAvailabilityCode, extractProductForm, extractPublishingDate } = await import("../supabase/functions/_shared/onix.js");
const { extractIsbn } = await import("../supabase/functions/_shared/isbn.js");

const args = process.argv.slice(2);
const lokalt = args.includes("--lokalt");
const exportDir = args.includes("--mappe") ? args[args.indexOf("--mappe") + 1] : null;
if (!exportDir || !existsSync(exportDir)) fail("Oppgi eksportmappen: --mappe scripts/data/live-eksport-…");
mkdirSync(outDir, { recursive: true });
const kanalFil = join(outDir, "skjulte-kanaler.jsonl");

// ── 1. Kanalene til aktive produkter (bare lesing, bulk) ─────────────────────
if (!lokalt) {
  enableLive();
  const q = `{ products(query: "status:active") { edges { node { id ${PUBLISHED_ON_BULK_FIELD} } } } }`;
  for (;;) {
    const cur = (await shopifyGql(`{ currentBulkOperation(type: QUERY) { id status } }`)).currentBulkOperation;
    if (!cur || !["CREATED", "RUNNING", "CANCELING"].includes(cur.status)) break;
    await sleep(10_000);
  }
  const start = (await shopifyGql(`mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id } userErrors { message } } }`, { q })).bulkOperationRunQuery;
  if (!start.bulkOperation?.id) fail(`Bulk-spørring: ${JSON.stringify(start.userErrors)}`);
  let op;
  for (;;) {
    await sleep(5000);
    op = (await shopifyGql(`query($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode url objectCount } } }`, { id: start.bulkOperation.id })).node;
    if (op.status === "COMPLETED") break;
    if (!["CREATED", "RUNNING"].includes(op.status)) fail(`Bulk-spørringen endte med ${op.status}.`);
  }
  const out = createWriteStream(kanalFil);
  if (op.url) {
    const res = await fetch(op.url);
    if (!res.ok) fail(`Nedlasting feilet (HTTP ${res.status}).`);
    for await (const chunk of res.body) out.write(chunk);
  }
  await new Promise((r) => out.end(r));
  console.log(`Kanaler hentet (${op.objectCount} objekter).`);
}
const publicationsAll = JSON.parse(readFileSync(join(exportDir, "butikk.json"), "utf8")).publications;
const allChannels = publicationsAll.map((p) => p.id);
const channelName = Object.fromEntries(publicationsAll.map((p) => [p.id, p.name]));
const have = new Map();
for (const l of readFileSync(kanalFil, "utf8").split("\n").filter(Boolean)) {
  const o = JSON.parse(l);
  if (!o.__parentId) { have.set(o.id, []); continue; }
  if (o.publication?.id && have.has(o.__parentId)) have.get(o.__parentId).push(o.publication.id);
}

// ── 2. Eksporten ────────────────────────────────────────────────────────────
const lines = (f) => readFileSync(join(exportDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
{
  const handles = new Map(), members = new Map();
  for (const o of lines("collections.jsonl")) {
    if (!o.__parentId && o.handle && PROTECTED_COLLECTION_HANDLES.includes(o.handle)) handles.set(o.id, o.handle);
    else if (o.__parentId && handles.has(o.__parentId) && o.id.includes("/Product/")) members.set(o.id, handles.get(o.__parentId));
  }
  setProtectedMembers(members);
}
const byId = new Map();
for (const o of lines("products.jsonl")) {
  if (!o.__parentId) byId.set(o.id, { ...o, variants: [] });
  else if (o.id.includes("/ProductVariant/") && byId.get(o.__parentId)) byId.get(o.__parentId).variants.push(o);
}
const all = [...byId.values()];
const isbnOf = (p) => extractIsbn({ handle: p.handle, variants: { nodes: p.variants.slice(0, 1) } });
const isbnCount = new Map();
for (const p of all) { const i = isbnOf(p); if (i) isbnCount.set(i, (isbnCount.get(i) ?? 0) + 1); }
const hidden = all.filter((p) => p.status === "ACTIVE" && !p.publishedAt);

// ── 3. ONIX (bare lesing, hurtigbuffer lokalt) ──────────────────────────────
const cacheDir = join(outDir, "onix-gjennomgang");
mkdirSync(cacheDir, { recursive: true });
async function onixFor(isbn, attempt = 0) {
  const file = join(cacheDir, `${isbn}.xml`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const key = process.env.SUPABASE_ANON_KEY;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/bokbasen/isbn/${isbn}?raw=true`, { headers: { Authorization: `Bearer ${key}`, apikey: key } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    writeFileSync(file, xml);
    return xml;
  } catch {
    if (attempt < 3) { await sleep(1500 * (attempt + 1)); return onixFor(isbn, attempt + 1); }
    return undefined; // oppslaget feilet (ikke det samme som «finnes ikke»)
  }
}
const isbns = [...new Set(hidden.map(isbnOf).filter(Boolean))];
const xmlOf = new Map();
{
  let i = 0, done = 0;
  const worker = async () => { while (i < isbns.length) { const isbn = isbns[i++]; xmlOf.set(isbn, await onixFor(isbn)); if (++done % 500 === 0) console.log(`ONIX ${done}/${isbns.length}`); } };
  await Promise.all(Array.from({ length: 5 }, worker));
}

// ── 4. Rad per bok, og trinnene fra 3 280 til de som ville blitt publisert ───
const NOW = new Date().toISOString().slice(0, 10);
const rows = [];
for (const p of hidden) {
  const isbn = isbnOf(p);
  const xml = isbn ? xmlOf.get(isbn) : null;
  const channels = have.get(p.id) ?? null;
  const row = {
    tittel: p.title, isbn: isbn ?? "", forlag: p.vendor ?? "", produkttype_i_dag: p.productType ?? "",
    pris_i_dag: p.variants[0]?.price != null ? Number(p.variants[0].price) : null, opprettet: String(p.createdAt ?? "").slice(0, 10),
    kanaler_i_dag: channels ? channels.map((c) => channelName[c] ?? c).join(", ") : "(ukjent)",
    antall_kanaler: channels ? channels.length : null,
    status_i_dag: "aktiv",
  };
  row.beskyttet = protectedProduct(p) ? "ja" : "nei";
  row.duplikat = isbn && (isbnCount.get(isbn) ?? 0) > 1 ? "ja" : "nei";
  row.uten_isbn = isbn ? "nei" : "ja";
  row.i_bokbasen = !isbn ? "(ingen ISBN)" : xml === undefined ? "(oppslag feilet)" : xml === null ? "nei" : "ja";
  let form = null, bf = null;
  if (xml) {
    const code = extractAvailabilityCode(xml) || "";
    const rule = availabilityRule(code);
    row.onix_kode = code || "(tom)";
    row.ny_status = { ACTIVE: "aktiv", DRAFT: "utkast", ARCHIVED: "arkivert" }[rule.status] ?? rule.status;
    const pf = extractProductForm(xml);
    form = pf.form; bf = bookFormat(pf.form, pf.details);
    row.produktform = pf.form ?? "";
    row.fysisk_bok = isBookForm(pf.form) && bf.productType === "Bok" ? "ja" : "nei";
    row.boktype_fra_onix = bf.productType;
    const pr = chooseValidPrice(xml);
    row.pris_bokbasen = pr.price; row.pris_merknad = pr.price == null ? (pr.reason ?? "ingen gyldig pris") : "";
    row.utgivelsesdato = extractPublishingDate(xml) ?? "";
    row.kommende = ["10", "11", "12"].includes(code) ? "ja" : "nei";
    row.pris_null_eller_mangler = (row.pris_i_dag ?? 0) === 0 || pr.price == null ? "ja" : "nei";
    row._rule = rule;
  } else {
    row.onix_kode = ""; row.ny_status = ""; row.fysisk_bok = "(ukjent)"; row.boktype_fra_onix = ""; row.produktform = "";
    row.pris_bokbasen = null; row.pris_merknad = ""; row.utgivelsesdato = ""; row.kommende = ""; row.pris_null_eller_mangler = (row.pris_i_dag ?? 0) === 0 ? "ja" : "nei";
  }
  // Slik jobbene ville vurdert boka (channelsToPublish er samme funksjon som book-update og availability-check)
  const cand = { id: p.id, status: p.status, productType: p.productType, tags: p.tags, vendor: p.vendor, publicationIds: channels };
  const willBeActive = row.ny_status === "aktiv";
  const type = xml ? bf.productType : null;
  // Jobbene hopper over beskyttede, uten ISBN, duplikater, ikke i Bokbasen og ikke-bøker FØR kanalregelen
  const gatesOk = row.beskyttet === "nei" && row.uten_isbn === "nei" && row.duplikat === "nei" && row.i_bokbasen === "ja" && row.fysisk_bok === "ja";
  const real = gatesOk ? channelsToPublish(allChannels, cand, type, willBeActive) : [];
  // Samme vurdering, men som om produkttypen var «Bok» eller tom (ANTAKELSE: bokdata-jobben har satt den først)
  const asBok = gatesOk ? channelsToPublish(allChannels, { ...cand, productType: "Bok" }, type, willBeActive) : [];
  row.publiseres_av_regelen_i_dag = real.length ? "ja" : "nei";
  row.publiseres_hvis_produkttype_bok = asBok.length ? "ja" : "nei";
  // Hvorfor ikke (første grunn, i rekkefølgen jobbene sjekker)
  let why = "";
  if (row.beskyttet === "ja") why = "beskyttet (røres aldri)";
  else if (row.uten_isbn === "ja") why = "uten ISBN";
  else if (row.duplikat === "ja") why = "duplikat-ISBN (hoppes over)";
  else if (row.i_bokbasen !== "ja") why = "finnes ikke hos Bokbasen / oppslag feilet";
  else if (row.fysisk_bok !== "ja") why = "ikke fysisk bok (lydbok, e-bok eller annet)";
  else if (!willBeActive) why = `blir ${row.ny_status} etter regelen (ONIX ${row.onix_kode})`;
  else if (!channels) why = "kanaler ukjent";
  else if (!real.length && asBok.length) why = "produkttypen er ikke «Bok» i dag (står forfatter e.l.), regelen rører den ikke";
  else if (!real.length) why = "mangler ingen kanaler";
  row.hvorfor_ikke = real.length ? "" : why;
  row.synlig_i_nettbutikken = real.length ? "ja (regelen publiserer også Online Store)" : `nei: ${why}`;
  // Anbefaling (bare sjekkmodus-regelen; antakelser merket)
  if (real.length) row.anbefaling = "publiser";
  else if (asBok.length && row.pris_null_eller_mangler !== "ja") row.anbefaling = "sjekk manuelt (publiseres først når produkttypen er «Bok» – antakelse)";
  else if (asBok.length) row.anbefaling = "sjekk manuelt (pris 0 eller mangler gyldig pris)";
  else row.anbefaling = "hold utenfor";
  delete row._rule;
  row._steg = { harIsbn: !!isbn, ikkeBeskyttet: row.beskyttet === "nei", ikkeDuplikat: row.duplikat === "nei", iBokbasen: row.i_bokbasen === "ja", fysisk: row.fysisk_bok === "ja", aktivEtterRegel: willBeActive, produkttypeOk: !p.productType || p.productType === "Bok", mangler: !!channels && channels.length < allChannels.length, publiseres: real.length > 0 };
  rows.push(row);
}
// Trinnene (kumulativt)
const funnel = [["Aktive, ikke publisert i Online Store", () => true], ["har ISBN", (s) => s.harIsbn], ["ikke beskyttet", (s) => s.ikkeBeskyttet], ["ikke duplikat", (s) => s.ikkeDuplikat],
  ["finnes hos Bokbasen", (s) => s.iBokbasen], ["fysisk bok", (s) => s.fysisk], ["blir/forblir aktiv etter regelen", (s) => s.aktivEtterRegel],
  ["produkttype tom eller «Bok» i dag", (s) => s.produkttypeOk], ["mangler kanaler → publiseres", (s) => s.mangler && s.publiseres]];
const trinn = []; let cur = rows;
for (const [navn, f] of funnel) { cur = cur.filter((r) => f(r._steg)); trinn.push([navn, cur.length]); }
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x) || "(tom)"; m[k] = (m[k] || 0) + 1; return m; }, {});
const sammendrag = {
  generert: NOW, antall: rows.length, trinn,
  onixKode: count(rows, (r) => r.onix_kode), nyStatus: count(rows, (r) => r.ny_status),
  kanalerIdag: count(rows, (r) => r.kanaler_i_dag), fysisk: count(rows, (r) => r.fysisk_bok), iBokbasen: count(rows, (r) => r.i_bokbasen),
  produkttypeIdag: { bok: rows.filter((r) => r.produkttype_i_dag === "Bok").length, tom: rows.filter((r) => !r.produkttype_i_dag).length, annet: rows.filter((r) => r.produkttype_i_dag && r.produkttype_i_dag !== "Bok").length },
  anbefaling: count(rows, (r) => r.anbefaling), hvorfor: count(rows, (r) => r.hvorfor_ikke),
  kommende: rows.filter((r) => r.kommende === "ja").length, prisNullEllerMangler: rows.filter((r) => r.pris_null_eller_mangler === "ja").length,
  publiseresHvisBok: rows.filter((r) => r.publiseres_hvis_produkttype_bok === "ja").length, publiseresIDag: rows.filter((r) => r.publiseres_av_regelen_i_dag === "ja").length,
  topForlag: Object.entries(count(rows, (r) => r.forlag)).sort((a, b) => b[1] - a[1]).slice(0, 8),
  opprettet: count(rows, (r) => r.opprettet.slice(0, 7)),
  // Alle aktive bøker som regelen ville gitt kanaler (også de som ikke er skjulte): til å forklare 306
  aktiveMedManglendeKanaler: [...have.entries()].filter(([, c]) => c.length < allChannels.length).length,
};
for (const r of rows) delete r._steg;
writeFileSync(join(outDir, "skjulte-detaljer.json"), JSON.stringify({ sammendrag, rows }, null, 1));
console.log(JSON.stringify(sammendrag, null, 1));
