#!/usr/bin/env node
// scripts/live-tilbakerull.mjs  (pakke I del B)
// Lager en PLAN for å rulle tilbake endringer fra to eksporter (scripts/live-eksport.mjs):
// FØR (sikkerhetskopien tatt før piloten/overgangen) og ETTER (eksport tatt nå).
// Scriptet leser bare filer lokalt. Det gjør INGEN API-kall og endrer ingenting i noen butikk.
//
// KJØRING (fra prosjektmappa):
//   node scripts/live-tilbakerull.mjs <foer-mappe> <etter-mappe> [--ikke-isbn <fil>]
//
// Resultat i scripts/data/tilbakerulling-<tid>/ (git-ignorert):
//   oppsummering.json        tellinger per type endring
//   endringer.csv            én rad per produkt og felt: før, etter, og hva som gjøres
//   gjenopprett-produkter.jsonl   én linje per produkt: { product: ProductUpdateInput } med KUN feltene som er endret
//                            (tittel, status, leverandør, produkttype, tagger, beskrivelse, SEO, tema, metafelt som skal settes)
//   gjenopprett-metafelt-slett.jsonl  metafelt som ikke fantes før og som skal slettes: { ownerId, namespace, key }
//   gjenopprett-varianter.jsonl  pris, sammenligningspris, lagerpolicy: { productId, variants: [{ id, ... }] }
//   gjenopprett-bilder-alt.jsonl alt-tekst på bilder: { id, alt }
//   gjenopprett-handle.csv   produkter der handle er endret. IKKE med i produktfilen: handle rulles tilbake med
//                            /shopify/handles/rollback eller for hånd, fordi videresendingen fra gammel handle må slettes først
//   nye-produkter.csv        produkter som finnes ETTER men ikke FØR (id, handle, status, ISBN). Slettes aldri automatisk
//   slettede-produkter.csv   produkter som fantes FØR og er borte ETTER (må lages på nytt fra products.jsonl i FØR)
//   redirects-nye.csv / redirects-borte.csv   videresendinger som er lagt til / forsvunnet
//   samlinger.csv            samlinger som er nye, borte eller har endret regel
//
// Filene brukes av et eget utførelsestrinn (skal godkjennes av Eirik og Cowork først, se oppgaver/pakke-i-del-b-live.md).
// Støyfelt (updatedAt, publishedAt, lagerantall, kanalantall) tas ikke med.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshot, flatten } from "./snapshot-diff.mjs";
import { extractIsbn } from "../supabase/functions/_shared/isbn.js";

const NOISE = new Set(["updatedAt", "publishedAt", "totalInventory", "publications", "media.count", "variant.inventoryQuantity", "variant.count"]);
const PRODUCT_FIELDS = { title: "title", status: "status", vendor: "vendor", productType: "productType", descriptionHtml: "descriptionHtml", templateSuffix: "templateSuffix" };

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, "\\n")}"`;
const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\n") + "\n";

/**
 * Ren funksjon: to innleste bilder (loadSnapshot) → plan. Ingen filer, ingen API-kall.
 * @returns {{ summary, changes, restoreProducts, deleteMetafields, restoreVariants, restoreAlt, handleChanges,
 *   newProducts, deletedProducts, newRedirects, goneRedirects, collections }}
 */
export function planRollback(before, after) {
  const out = {
    changes: [], restoreProducts: [], deleteMetafields: [], restoreVariants: [], restoreAlt: [], handleChanges: [],
    newProducts: [], deletedProducts: [], newRedirects: [], goneRedirects: [], collections: [],
  };
  const fieldCount = {};

  for (const [id, b] of before.products) {
    const a = after.products.get(id);
    if (!a) { out.deletedProducts.push({ id, handle: b.handle, title: b.title, status: b.status, isbn: extractIsbn(b) }); continue; }
    const fb = flatten(b), fa = flatten(a);
    const product = { id };
    const mfSet = [];
    const variantChange = {};
    let touched = false;
    for (const k of new Set([...Object.keys(fb), ...Object.keys(fa)])) {
      if (NOISE.has(k)) continue;
      const x = fb[k] ?? null, y = fa[k] ?? null;
      if (String(x) === String(y)) continue;
      fieldCount[k] = (fieldCount[k] ?? 0) + 1;
      let action = "manuelt";
      if (PRODUCT_FIELDS[k]) { product[PRODUCT_FIELDS[k]] = x ?? ""; action = "gjenopprettes"; touched = true; }
      else if (k === "tags") { product.tags = [...(b.tags ?? [])]; action = "gjenopprettes"; touched = true; }
      else if (k === "seo.title" || k === "seo.description") { (product.seo ??= {})[k.slice(4)] = x; action = "gjenopprettes"; touched = true; }
      else if (k === "category") { if (b.category?.id) { product.category = b.category.id; action = "gjenopprettes"; touched = true; } }
      else if (k === "handle") { out.handleChanges.push({ id, before: x, after: y }); action = "se gjenopprett-handle.csv"; }
      else if (k.startsWith("mf.")) {
        const old = b.metafields.find((m) => `mf.${m.namespace}.${m.key}` === k);
        if (old) { mfSet.push({ namespace: old.namespace, key: old.key, type: old.type, value: old.value }); action = "gjenopprettes"; touched = true; }
        else {
          const nu = a.metafields.find((m) => `mf.${m.namespace}.${m.key}` === k);
          if (nu) { out.deleteMetafields.push({ ownerId: id, namespace: nu.namespace, key: nu.key }); action = "slettes (fantes ikke før)"; }
        }
      } else if (k.startsWith("variant.") && ["variant.price", "variant.compareAtPrice", "variant.inventoryPolicy"].includes(k)) {
        variantChange[k.slice(8)] = x; action = "gjenopprettes";
      } else if (/^media\.\d+\.alt$/.test(k)) {
        const idx = Number(k.split(".")[1]);
        const mb = b.media[idx];
        if (mb?.id && x !== null) { out.restoreAlt.push({ id: mb.id, alt: x }); action = "gjenopprettes"; }
      }
      out.changes.push({ id, handle: a.handle, field: k, before: x, after: y, action });
    }
    if (mfSet.length) product.metafields = mfSet;
    if (touched) out.restoreProducts.push({ product });
    if (Object.keys(variantChange).length && b.variants[0]) {
      out.restoreVariants.push({ productId: id, variants: [{ id: b.variants[0].id, ...variantChange }] });
    }
  }
  for (const [id, a] of after.products) {
    if (!before.products.has(id)) out.newProducts.push({ id, handle: a.handle, title: a.title, status: a.status, isbn: extractIsbn(a) });
  }

  const key = (r) => `${r.path}\u0000${r.target}`;
  const bR = new Map(before.redirects.map((r) => [key(r), r])), aR = new Map(after.redirects.map((r) => [key(r), r]));
  for (const [k, r] of aR) if (!bR.has(k)) out.newRedirects.push(r);
  for (const [k, r] of bR) if (!aR.has(k)) out.goneRedirects.push(r);

  for (const [id, c] of before.collections) {
    const n = after.collections.get(id);
    if (!n) out.collections.push({ id, handle: c.handle, change: "borte" });
    else if (JSON.stringify(c.ruleSet ?? null) !== JSON.stringify(n.ruleSet ?? null) || c.title !== n.title) out.collections.push({ id, handle: c.handle, change: "regel eller tittel endret" });
  }
  for (const [id, n] of after.collections) if (!before.collections.has(id)) out.collections.push({ id, handle: n.handle, change: "ny" });

  out.summary = {
    produkterFoer: before.products.size, produkterEtter: after.products.size,
    produkterMedEndring: new Set(out.changes.map((c) => c.id)).size,
    nye: out.newProducts.length, slettede: out.deletedProducts.length,
    gjenopprettesProdukt: out.restoreProducts.length, metafeltSlettes: out.deleteMetafields.length,
    varianter: out.restoreVariants.length, bildeAlt: out.restoreAlt.length, handleEndret: out.handleChanges.length,
    redirectsNye: out.newRedirects.length, redirectsBorte: out.goneRedirects.length, samlinger: out.collections.length,
    perFelt: Object.fromEntries(Object.entries(fieldCount).sort((x, y) => y[1] - x[1])),
  };
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const [beforeDir, afterDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!beforeDir || !afterDir) { console.error("Bruk: node scripts/live-tilbakerull.mjs <foer-mappe> <etter-mappe>"); process.exit(1); }
  for (const d of [beforeDir, afterDir]) if (!existsSync(d)) { console.error(`Finner ikke ${d}`); process.exit(1); }
  const plan = planRollback(loadSnapshot(beforeDir), loadSnapshot(afterDir));
  const dir = join(dirname(fileURLToPath(import.meta.url)), "data", `tilbakerulling-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(join(dir, "oppsummering.json"), JSON.stringify(plan.summary, null, 2));
  writeFileSync(join(dir, "endringer.csv"), csv([["produkt", "handle", "felt", "før", "etter", "handling"], ...plan.changes.map((c) => [c.id, c.handle, c.field, c.before, c.after, c.action])]));
  writeFileSync(join(dir, "gjenopprett-produkter.jsonl"), jsonl(plan.restoreProducts));
  writeFileSync(join(dir, "gjenopprett-metafelt-slett.jsonl"), jsonl(plan.deleteMetafields));
  writeFileSync(join(dir, "gjenopprett-varianter.jsonl"), jsonl(plan.restoreVariants));
  writeFileSync(join(dir, "gjenopprett-bilder-alt.jsonl"), jsonl(plan.restoreAlt));
  writeFileSync(join(dir, "gjenopprett-handle.csv"), csv([["produkt", "handle før", "handle etter"], ...plan.handleChanges.map((h) => [h.id, h.before, h.after])]));
  writeFileSync(join(dir, "nye-produkter.csv"), csv([["produkt", "handle", "tittel", "status", "isbn"], ...plan.newProducts.map((p) => [p.id, p.handle, p.title, p.status, p.isbn])]));
  writeFileSync(join(dir, "slettede-produkter.csv"), csv([["produkt", "handle", "tittel", "status", "isbn"], ...plan.deletedProducts.map((p) => [p.id, p.handle, p.title, p.status, p.isbn])]));
  writeFileSync(join(dir, "redirects-nye.csv"), csv([["id", "path", "target"], ...plan.newRedirects.map((r) => [r.id, r.path, r.target])]));
  writeFileSync(join(dir, "redirects-borte.csv"), csv([["id", "path", "target"], ...plan.goneRedirects.map((r) => [r.id, r.path, r.target])]));
  writeFileSync(join(dir, "samlinger.csv"), csv([["samling", "handle", "endring"], ...plan.collections.map((c) => [c.id, c.handle, c.change])]));
  console.log(JSON.stringify(plan.summary, null, 2));
  console.log(`\n✔ Plan lagret i ${dir}\n(ingen API-kall er gjort, ingenting er endret i noen butikk)`);
}
