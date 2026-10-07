// Kontroll av pushede bøker mot standarden. node kontroll.mjs <meta.json> <ut.json> [utelat-isbn]
import { shopifyGql, testShop } from "../lib/clients.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { buildBookHandle } from "../../supabase/functions/_shared/handle.js";
import { coverAlt, coverFilename } from "../../supabase/functions/_shared/book-cover.ts";
import { availabilityRule } from "../../supabase/functions/_shared/availability.ts";
import { CATEGORY_IDS } from "../../supabase/functions/_shared/book-format.ts";
testShop();
const [metaf, outf, skip = ""] = process.argv.slice(2);
const metas = JSON.parse(readFileSync(metaf, "utf8")).map(x => x.meta).filter(m => m?.isbn && !skip.split(",").includes(m.isbn));
const pubs = (await shopifyGql(`{ publications(first:50){ nodes{ id name } } }`)).publications.nodes;
const Q = `query($q:String!){ productVariants(first:5, query:$q){ nodes{ barcode sku price inventoryPolicy inventoryItem{ tracked } product{
  id handle title status productType vendor tags descriptionHtml category{ id fullName } seo{ title description }
  resourcePublicationsCount{ count } onlineStoreUrl
  metafields(first:30){ nodes{ namespace key type value } }
  media(first:5){ nodes{ ... on MediaImage { alt image{ url } } } }
  variants(first:5){ nodes{ id } } } } } }`;
const rows = [], snap = {};
for (const m of metas) {
  const d = await shopifyGql(Q, { q: `barcode:${m.isbn}` });
  const nodes = d.productVariants.nodes;
  const p = nodes[0]?.product; const v = nodes[0];
  const checks = {};
  if (!p) { rows.push({ isbn: m.isbn, checks: { finnes: false } }); continue; }
  const mf = Object.fromEntries(p.metafields.nodes.map(x => [`${x.namespace}.${x.key}`, x.value]));
  const authors = m.authors ?? [];
  const wantHandle = buildBookHandle({ title: m.title, authors, isbn: m.isbn });
  const rule = availabilityRule(m.availability);
  const img = p.media.nodes[0];
  const fname = (img?.image?.url ?? "").split("?")[0].split("/").pop();
  checks.finnes = nodes.length === 1;
  checks.handle = p.handle === wantHandle;
  checks.seoTittel = !!p.seo.title && p.seo.title.length <= 70 && !/\n/.test(p.seo.title);
  checks.seoBeskr = !!p.seo.description && p.seo.description.length <= 320;
  checks.altTekst = img?.alt === coverAlt(m.title, authors);
  checks.filnavn = fname === coverFilename(p.handle, img?.image?.url) ;
  checks.productType = p.productType === "Bok";
  checks.kategori = p.category?.id === CATEGORY_IDS.Bok;
  checks.bokFelt = ["bok.isbn","bok.forfatter","bok.format","bok.sider","bok.utgivelsesaar","bok.spraak","bok.bokgruppe","bok.tilgjengelighet"].every(k => mf[k]);
  checks.isbnFelt = mf["bok.isbn"] === m.isbn;
  checks.tilgjengelighet = mf["bok.tilgjengelighet"] === rule.tilgjengelighet;
  checks.tagger = p.tags.length > 0 && p.tags.every(t => /^bkg-\d{1,3}$/.test(t));
  checks.bkgTagger = p.tags.some(t => t === `bkg-${m.bokgruppekode}`);
  checks.status = p.status === rule.status;
  checks.kanaler = p.resourcePublicationsCount.count === pubs.length;
  checks.strekSku = v.barcode === m.isbn && v.sku === m.isbn;
  checks.beskrivelse = p.descriptionHtml.includes("<p>");
  checks.untrack = v.inventoryItem.tracked === false;
  rows.push({ isbn: m.isbn, handle: p.handle, authors, checks, kanaler: `${p.resourcePublicationsCount.count}/${pubs.length}`, year: `${m.year}|${m.publishingDate} → ${mf["bok.utgivelsesaar"]}|${mf["bok.utgivelsesdato"] ?? "-"}`, seo: p.seo, tags: p.tags, alt: img?.alt, fname, price: v.price, status: p.status });
  snap[m.isbn] = { id: p.id, handle: p.handle, title: p.title, status: p.status, productType: p.productType, vendor: p.vendor, tags: [...p.tags].sort(), desc: p.descriptionHtml, cat: p.category?.id, seo: p.seo, mf, alt: img?.alt, fname, price: v.price, pol: v.inventoryPolicy, pubs: p.resourcePublicationsCount.count };
}
writeFileSync(outf, JSON.stringify({ rows, snap }, null, 1));
const keys = Object.keys(rows[0]?.checks ?? {});
console.log("isbn".padEnd(14) + keys.map(k => k.slice(0, 5).padEnd(6)).join(""));
for (const r of rows) console.log(r.isbn.padEnd(14) + keys.map(k => (r.checks[k] ? "ok" : "FEIL").padEnd(6)).join(""));
console.log("\nFeil:"); for (const r of rows) for (const [k, v] of Object.entries(r.checks)) if (!v) console.log(r.isbn, k);
for (const r of rows) console.log(r.isbn, "|", r.year, "|", r.kanaler, "|", r.status, "|", r.price, "|", r.seo?.title, "|", r.tags?.join(","), "|", r.alt, "|", r.fname);
