#!/usr/bin/env node
// scripts/snapshot-diff.mjs — sammenligner to øyeblikksbilder fra scripts/snapshot.mjs felt
// for felt (pakke F del 3.3 og 5). Bare lesing av filene i scripts/out/, ingen API-kall.
//
// KJØRING (fra prosjektmappa):
//   node scripts/snapshot-diff.mjs scripts/out/snapshot-testbutikk-9434-foer scripts/out/snapshot-testbutikk-9434-etter
//
// Resultat i scripts/out/snapshot-diff-<før>-<etter>.json og .csv (én rad per produkt og felt).
// Gruppene: beskyttet (tagg, leverandør Wrendale eller samling wrendale i før-bildet),
// uten ISBN, og med ISBN. Forventet: 0 endringer i de to første (også updatedAt).
// Ikke-bøker med ISBN skilles ut med --ikke-boker <fil> (én ISBN per linje, f.eks. fra
// jobbloggens CSV med årsak «ikke bok»).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { extractIsbn } from "../supabase/functions/_shared/isbn.js";
import { PROTECTED_COLLECTION_HANDLES, isProtectedCollection, protectedProduct } from "../supabase/functions/_shared/protected.ts";

const fail = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1); };

const typeOf = (gid) => String(gid ?? "").split("/")[3] ?? "";

/** Leser et øyeblikksbilde: produkter (med varianter, metafelt, bilder), samlinger og videresendinger. */
export function loadSnapshot(dir) {
  const read = (name) => {
    const f = join(dir, `${name}.jsonl`);
    if (!existsSync(f)) fail(`Mangler ${f}`);
    return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  };
  const products = new Map();
  for (const o of read("products")) {
    if (!o.__parentId) { products.set(o.id, { ...o, variants: [], metafields: [], media: [] }); continue; }
    const p = products.get(o.__parentId);
    if (!p) continue;
    const t = typeOf(o.id);
    if (t === "ProductVariant") p.variants.push(o);
    else if (t === "Metafield") p.metafields.push(o);
    else p.media.push(o);
  }
  const collections = new Map();
  for (const o of read("collections")) {
    if (!o.__parentId) { collections.set(o.id, { ...o, products: new Set() }); continue; }
    collections.get(o.__parentId)?.products.add(o.id);
  }
  const redirects = read("redirects");
  return { products, collections, redirects };
}

/** Produktet som flate felt («variant.price», «mf.bok.format», «media.alt» …). */
export function flatten(p) {
  const f = {
    handle: p.handle, title: p.title, status: p.status, vendor: p.vendor, productType: p.productType,
    tags: [...(p.tags ?? [])].sort().join(", "), descriptionHtml: p.descriptionHtml, templateSuffix: p.templateSuffix,
    category: p.category?.fullName ?? null, "seo.title": p.seo?.title ?? null, "seo.description": p.seo?.description ?? null,
    updatedAt: p.updatedAt, publishedAt: p.publishedAt, totalInventory: p.totalInventory,
    publications: p.resourcePublicationsCount?.count ?? null,
    "media.count": p.media.length,
  };
  const v = p.variants[0];
  if (v) {
    Object.assign(f, {
      "variant.count": p.variants.length, "variant.sku": v.sku, "variant.barcode": v.barcode, "variant.price": v.price,
      "variant.compareAtPrice": v.compareAtPrice, "variant.inventoryPolicy": v.inventoryPolicy,
      "variant.inventoryQuantity": v.inventoryQuantity, "variant.taxable": v.taxable,
      "variant.tracked": v.inventoryItem?.tracked, "variant.weight": v.inventoryItem?.measurement?.weight?.value ?? null,
    });
  }
  p.media.forEach((m, i) => { f[`media.${i}.alt`] = m.alt; f[`media.${i}.url`] = m.image?.url?.split("?")[0] ?? null; });
  for (const m of p.metafields) f[`mf.${m.namespace}.${m.key}`] = m.value;
  return f;
}

export function diffProduct(a, b) {
  const fa = flatten(a), fb = flatten(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const out = [];
  for (const k of keys) {
    const x = fa[k] ?? null, y = fb[k] ?? null;
    if (String(x) !== String(y)) out.push({ field: k, before: x, after: y });
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const option = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const [beforeDir, afterDir] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--ikke-boker");
  if (!beforeDir || !afterDir) fail("Bruk: node scripts/snapshot-diff.mjs <før-mappe> <etter-mappe> [--ikke-boker fil]");
  const before = loadSnapshot(beforeDir);
  const after = loadSnapshot(afterDir);
  const nonBooks = new Set(option("ikke-boker") ? readFileSync(option("ikke-boker"), "utf8").split(/\s+/).filter(Boolean) : []);

  // Medlemmer i beskyttede manuelle samlinger, fra før-bildet
  const members = new Map();
  for (const c of before.collections.values()) {
    if (PROTECTED_COLLECTION_HANDLES.includes(c.handle)) for (const id of c.products) members.set(id, c.handle);
  }
  const isbnOf = (p) => extractIsbn({ handle: p.handle, bokIsbn: p.metafields.find((m) => m.namespace === "bok" && m.key === "isbn"), variants: { nodes: p.variants } });
  const groupOf = (p) => protectedProduct(p, members) ? "beskyttet" : !isbnOf(p) ? "uten ISBN" : nonBooks.has(isbnOf(p)) ? "ikke bok" : "med ISBN";

  const groups = {};
  const fieldCount = {};
  const rows = [];
  for (const [id, a] of before.products) {
    const g = groupOf(a);
    groups[g] ??= { produkter: 0, endret: 0, uendret: 0, borte: 0 };
    groups[g].produkter++;
    const b = after.products.get(id);
    if (!b) { groups[g].borte++; rows.push([g, isbnOf(a) ?? "", a.handle, "(produktet er borte)", "", ""]); continue; }
    const d = diffProduct(a, b);
    if (!d.length) { groups[g].uendret++; continue; }
    groups[g].endret++;
    for (const c of d) {
      fieldCount[`${g}: ${c.field}`] = (fieldCount[`${g}: ${c.field}`] ?? 0) + 1;
      rows.push([g, isbnOf(a) ?? "", a.handle, c.field, c.before, c.after]);
    }
  }
  const newProducts = [...after.products.keys()].filter((id) => !before.products.has(id)).length;

  // Tagger og smarte samlinger (del 5.3)
  const tagSet = (snap) => new Set([...snap.products.values()].flatMap((p) => (p.tags ?? []).map((t) => t.toLowerCase())));
  const tagsBefore = tagSet(before), tagsAfter = tagSet(after);
  const collectionCounts = [];
  for (const [id, c] of before.collections) {
    const n = after.collections.get(id)?.products.size ?? null;
    if (n !== c.products.size) {
      collectionCounts.push({ handle: c.handle, title: c.title, smart: !!c.ruleSet, beskyttet: isProtectedCollection(c), foer: c.products.size, etter: n });
    }
  }
  const changedProtectedCollections = [...before.collections.values()].filter((c) => isProtectedCollection(c)).filter((c) => {
    const x = after.collections.get(c.id);
    return !x || x.updatedAt !== c.updatedAt || x.title !== c.title || x.sortOrder !== c.sortOrder || x.products.size !== c.products.size;
  }).map((c) => c.handle);

  const report = {
    foer: beforeDir, etter: afterDir,
    grupper: groups, nyeProdukter: newProducts,
    feltEndringer: Object.fromEntries(Object.entries(fieldCount).sort((a, b) => b[1] - a[1])),
    tagger: { unikeFoer: tagsBefore.size, unikeEtter: tagsAfter.size, fjernet: tagsBefore.size - [...tagsBefore].filter((t) => tagsAfter.has(t)).length },
    samlingerMedEndretAntall: collectionCounts.sort((a, b) => (a.etter ?? 0) - a.foer - ((b.etter ?? 0) - b.foer)),
    beskyttedeSamlingerEndret: changedProtectedCollections,
    videresendinger: { foer: before.redirects.length, etter: after.redirects.length },
  };
  const slug = `${basename(beforeDir)}-${basename(afterDir)}`.replace(/snapshot-/g, "");
  const out = join("scripts", "out", `snapshot-diff-${slug}`);
  writeFileSync(`${out}.json`, JSON.stringify(report, null, 2));
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""').slice(0, 2000)}"`;
  writeFileSync(`${out}.csv`, "﻿" + [["Gruppe", "ISBN", "Handle", "Felt", "Før", "Etter"], ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n");

  console.log("\nGrupper:");
  for (const [g, c] of Object.entries(groups)) console.log(`  ${g.padEnd(10)} ${c.produkter} produkter: ${c.endret} endret, ${c.uendret} uendret, ${c.borte} borte`);
  console.log(`  nye produkter: ${newProducts}`);
  const bad = ["beskyttet", "uten ISBN", "ikke bok"].filter((g) => groups[g]?.endret || groups[g]?.borte);
  console.log(bad.length ? `\n✖ Endringer der det skulle vært 0: ${bad.join(", ")}` : "\n✔ Beskyttede, uten ISBN og ikke-bøker: 0 endringer");
  if (changedProtectedCollections.length) console.log(`✖ Beskyttede samlinger endret: ${changedProtectedCollections.join(", ")}`);
  console.log(`Tagger: ${report.tagger.unikeFoer} → ${report.tagger.unikeEtter} unike`);
  const lost = collectionCounts.filter((c) => c.etter === null || c.etter < c.foer);
  if (lost.length) console.log(`Samlinger som mistet produkter: ${lost.slice(0, 20).map((c) => `${c.handle} ${c.foer}→${c.etter ?? "borte"}`).join(", ")}`);
  console.log(`\nRapport: ${out}.json og .csv\n`);
}
