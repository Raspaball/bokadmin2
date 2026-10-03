// supabase/functions/_shared/book-update.ts
// Jobben «Oppdater eksisterende bøker» (pakke B del 8): ren funksjon som gir
// hva som må endres på ett produkt for at det skal følge standarden fra del 1–7.
// Brukes av book-update (per produkt) og kan senere brukes av bulk-eksport uten
// å skrive om reglene. Ren TypeScript uten Deno-API-er (testes i scripts/).
//
// Endrer aldri pris, status, tilgjengelighet, handle eller produkttittel.

import { extractDescription, extractInvertedNames, extractPublisher, extractTitle } from "./onix.js";
import { shownFormat } from "./book-format.ts";
import { bookDescription, bookFieldsFromOnix, bookMetafields, canReplaceDescription, sameMetafieldValue } from "./book-standard.ts";
import { bookSeo, decideSeo, legacySeo, parseSeoAuto, seoMetafields } from "./book-seo.ts";
import { coverAlt, coverChanges, coverFilename, fileNameFromUrl, type CoverChange } from "./book-cover.ts";
import { cleanBookTags } from "./book-tags.ts";
import { isInstitutionName } from "./contributors.js";
import { protectedProduct, protectedProductMessage } from "./protected.ts";

/** Metafeltnøklene i bok som jobben setter (aliasene i produktspørringen er mf_<nøkkel>). */
export const BOOK_METAFIELD_KEYS = ["forfatter", "format", "sider", "utgivelsesaar", "spraak", "serie", "alder", "thema", "bokgruppe"] as const;

/** GraphQL-felt jobben trenger på hvert produkt (i tillegg til ISBN-feltene). */
export const BOOK_UPDATE_PRODUCT_FIELDS = `
  id handle title vendor productType tags descriptionHtml
  category { id }
  ${BOOK_METAFIELD_KEYS.map((k) => `mf_${k}: metafield(namespace: "bok", key: "${k}") { value }`).join("\n  ")}
  seoTitleMf: metafield(namespace: "global", key: "title_tag") { value }
  seoDescMf: metafield(namespace: "global", key: "description_tag") { value }
  seoAuto: metafield(namespace: "bokadmin", key: "seo_auto") { value }
  media(first: 1) { nodes { id alt ... on MediaImage { image { url } } } }
`;

export interface ShopifyBookProduct {
  id: string;
  handle: string;
  title: string;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[];
  descriptionHtml?: string | null;
  category?: { id: string } | null;
  seoTitleMf?: { value: string } | null;
  seoDescMf?: { value: string } | null;
  seoAuto?: { value: string } | null;
  media?: { nodes: Array<{ id: string; alt?: string | null; image?: { url: string } | null }> };
  [key: string]: unknown;
}

/** Feltene i sammendraget (én telling per felt). */
export type BookUpdateField =
  | "productType" | "category" | `bok.${(typeof BOOK_METAFIELD_KEYS)[number]}`
  | "seoTitle" | "seoDescription" | "coverAlt" | "coverFilename" | "description" | "tags";

export interface FieldChange {
  field: BookUpdateField;
  from: string;
  to: string;
}

export interface BookUpdatePlan {
  /** Til productUpdate (uten id). Tomt = ingen endring på produktet */
  product: Record<string, unknown>;
  /** Til metafieldsSet (bok.* og SEO) */
  metafields: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }>;
  /** Metafelt som skal slettes (metafieldsDelete): verdier ONIX ikke lenger gir, f.eks. «Norge» som forfatter */
  metafieldDeletes: Array<{ ownerId: string; namespace: string; key: string }>;
  /** Til fileUpdate på omslaget, eller null */
  cover: { mediaId: string; change: CoverChange } | null;
  changes: FieldChange[];
  /** Bidragsyterne ONIX har som institusjon (ikke forfattere, pakke G del 3): til kontroll-CSV-en */
  institutions: Array<{ name: string; role: string | null; reason: string }>;
  /** Ting som ikke ble endret med vilje, f.eks. «SEO-tittel endret manuelt, ikke overskrevet» */
  notes: string[];
}

/** Metafeltverdi for en liste (JSON) → tekster, ellers tom liste. */
function parseList(value: string | null | undefined): string[] {
  try {
    const v = JSON.parse(String(value ?? ""));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const short = (s: string | null | undefined, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/**
 * Hva som må endres på produktet. `xml` er rå ONIX for boka.
 */
export function planBookUpdate(product: ShopifyBookProduct, xml: string): BookUpdatePlan {
  // Beskyttet produkt (tagg, leverandør, samling): ingen endringer, uansett hva ONIX sier (kallerne sjekker også selv)
  if (protectedProduct(product)) {
    return { product: {}, metafields: [], metafieldDeletes: [], cover: null, changes: [], institutions: [], notes: [protectedProductMessage(product)] };
  }
  const f = bookFieldsFromOnix(xml);
  const onixTitle = extractTitle(xml);
  const title = product.title || onixTitle;
  const changes: FieldChange[] = [];
  const notes: string[] = [];
  const productInput: Record<string, unknown> = {};
  const metafields: BookUpdatePlan["metafields"] = [];
  const metafieldDeletes: BookUpdatePlan["metafieldDeletes"] = [];

  // productType og kategori (del 2 og 3)
  if ((product.productType ?? "") !== f.productType) {
    productInput.productType = f.productType;
    changes.push({ field: "productType", from: product.productType ?? "", to: f.productType });
  }
  if ((product.category?.id ?? "") !== f.category) {
    productInput.category = f.category;
    changes.push({ field: "category", from: product.category?.id ?? "", to: f.category });
  }

  // Bokfeltene (del 1 og 2). Felt uten verdi i ONIX røres ikke.
  for (const m of bookMetafields(f)) {
    const current = (product[`mf_${m.key}`] as { value?: string } | null | undefined)?.value ?? null;
    if (!sameMetafieldValue(current, m.value, m.type)) {
      metafields.push({ ownerId: product.id, ...m });
      changes.push({ field: `bok.${m.key}` as BookUpdateField, from: short(current), to: short(m.value) });
    }
  }

  // Verdier som ikke lenger skal stå (pakke G): bok.forfatter som bare har institusjoner
  // («Norge») når ONIX ikke har noen person, og bok.format «Annet». Manuelt satte verdier røres ikke.
  const currentForfatter = parseList((product.mf_forfatter as { value?: string } | null | undefined)?.value);
  if (!f.authors.length && currentForfatter.length && currentForfatter.every(isInstitutionName)) {
    metafieldDeletes.push({ ownerId: product.id, namespace: "bok", key: "forfatter" });
    changes.push({ field: "bok.forfatter", from: short(currentForfatter.join(", ")), to: "(fjernet: institusjon)" });
  }
  if (!shownFormat(f.format) && (product.mf_format as { value?: string } | null | undefined)?.value === "Annet") {
    metafieldDeletes.push({ ownerId: product.id, namespace: "bok", key: "format" });
    changes.push({ field: "bok.format", from: "Annet", to: "(fjernet)" });
  }

  // SEO (del 4). Manuelle endringer står.
  const description = extractDescription(xml);
  const wantedSeo = bookSeo({ title, authors: f.authors, format: f.format, year: f.year, description });
  const decision = decideSeo(
    { title: product.seoTitleMf?.value, description: product.seoDescMf?.value },
    wantedSeo,
    parseSeoAuto(product.seoAuto?.value),
    legacySeo(title, description),
  );
  notes.push(...decision.notes);
  metafields.push(...seoMetafields(product.id, decision, wantedSeo));
  if (decision.title !== null) changes.push({ field: "seoTitle", from: short(product.seoTitleMf?.value), to: decision.title });
  if (decision.description !== null) changes.push({ field: "seoDescription", from: short(product.seoDescMf?.value), to: short(decision.description) });

  // Omslag (del 5): alt-tekst og filnavn, uten ny opplasting
  let cover: BookUpdatePlan["cover"] = null;
  const media = product.media?.nodes?.[0];
  if (media?.image?.url) {
    const change = coverChanges(
      { alt: media.alt, url: media.image.url },
      { alt: coverAlt(title, f.authors), filename: coverFilename(product.handle, media.image.url) },
    );
    if (Object.keys(change).length) {
      cover = { mediaId: media.id, change };
      if (change.alt) changes.push({ field: "coverAlt", from: short(media.alt), to: change.alt });
      if (change.filename) changes.push({ field: "coverFilename", from: fileNameFromUrl(media.image.url), to: change.filename });
    }
  }

  // Beskrivelse (del 6): bare når den er tom, eller samme tekst med annen formatering
  const wantedDesc = bookDescription(description, title, f, extractPublisher(xml));
  const currentDesc = product.descriptionHtml ?? "";
  if (currentDesc.trim() !== wantedDesc.html.trim()) {
    if (canReplaceDescription(currentDesc, wantedDesc, wantedDesc.fallback ? wantedDesc.html : null)) {
      productInput.descriptionHtml = wantedDesc.html;
      changes.push({ field: "description", from: short(currentDesc.replace(/<[^>]+>/g, " ")), to: short(wantedDesc.html.replace(/<[^>]+>/g, " ")) });
    } else {
      notes.push("Beskrivelsen er en annen tekst enn forlagsteksten, ikke overskrevet");
    }
  }

  // Tagger (del 7): fjern forfatter og tittel, rør ikke andre
  // authorTexts: navnene slik ONIX skriver dem («Hove Christensen, Mia») og gammel
  // productType (live hadde forfatteren der), så sammensatte etternavn også kjennes igjen
  const oldType = product.productType && !["Bok", "Lydbok", "E-bok"].includes(product.productType) ? [product.productType] : [];
  const tags = cleanBookTags(product.tags ?? [], { title, authors: f.authors, authorTexts: [...extractInvertedNames(xml), ...oldType] });
  if (tags.removed.length) {
    productInput.tags = tags.tags;
    changes.push({ field: "tags", from: tags.removed.join(", "), to: "(fjernet)" });
  }

  return { product: productInput, metafields, metafieldDeletes, cover, changes, institutions: f.institutions, notes };
}

// ── Sammendrag ───────────────────────────────────────────────────────────────

export interface BookUpdateCounts {
  changed: number;
  unchanged: number;
  skippedNoIsbn: number;
  skippedNoOnix: number;
  /** ONIX-posten er ikke en bok (ProductForm, pakke F del 2.2) */
  skippedNotBook: number;
  /** Beskyttet tagg (_shared/protected.ts): aldri rørt */
  skippedProtected: number;
  /** Samme ISBN på flere produkter (_shared/duplicates.ts): hoppes over til de er ryddet */
  skippedDuplicate: number;
  errors: number;
  /** Per felt: antall bøker, og opptil tre eksempler «handle: fra → til» */
  fields: Record<string, { count: number; examples: string[] }>;
  /** Notater (f.eks. manuelt endret SEO-tittel) med antall */
  notes: Record<string, number>;
  /** Institusjoner blant bidragsyterne (pakke G del 3): navn → årsak, roller, antall bøker og noen ISBN. CSV: institutionsCsv() */
  institutions: Record<string, InstitutionCount>;
}

export interface InstitutionCount { reason: string; roles: string[]; count: number; isbns: string[] }

export function emptyBookUpdateCounts(): BookUpdateCounts {
  return { changed: 0, unchanged: 0, skippedNoIsbn: 0, skippedNoOnix: 0, skippedNotBook: 0, skippedProtected: 0, skippedDuplicate: 0, errors: 0, fields: {}, notes: {}, institutions: {} };
}

export function loadBookUpdateCounts(v: unknown): BookUpdateCounts {
  const c = emptyBookUpdateCounts();
  if (!v || typeof v !== "object") return c;
  const o = v as Partial<BookUpdateCounts>;
  for (const k of ["changed", "unchanged", "skippedNoIsbn", "skippedNoOnix", "skippedNotBook", "skippedProtected", "skippedDuplicate", "errors"] as const) {
    if (typeof o[k] === "number") c[k] = o[k] as number;
  }
  if (o.fields && typeof o.fields === "object") c.fields = JSON.parse(JSON.stringify(o.fields));
  if (o.notes && typeof o.notes === "object") c.notes = { ...o.notes };
  if (o.institutions && typeof o.institutions === "object") c.institutions = JSON.parse(JSON.stringify(o.institutions));
  return c;
}

/** Legger planen for én bok inn i tellingene. */
export function countPlan(c: BookUpdateCounts, handle: string, plan: BookUpdatePlan, isbn?: string | null): void {
  if (plan.changes.length) c.changed++;
  else c.unchanged++;
  for (const ch of plan.changes) {
    const entry = (c.fields[ch.field] ??= { count: 0, examples: [] });
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push(`${handle}: ${ch.from || "(tom)"} → ${ch.to}`);
  }
  for (const n of plan.notes) c.notes[n] = (c.notes[n] ?? 0) + 1;
  for (const inst of plan.institutions) {
    const e = (c.institutions[inst.name] ??= { reason: inst.reason, roles: [], count: 0, isbns: [] });
    e.count++;
    if (inst.role && !e.roles.includes(inst.role)) e.roles.push(inst.role);
    if (isbn && e.isbns.length < 5 && !e.isbns.includes(isbn)) e.isbns.push(isbn);
  }
}

/** «12 endret, 30 uendret, hoppet over 22 (22 uten ISBN, 0 uten ONIX, 0 beskyttet, 0 DUPLIKAT), 0 feil. Felt: productType 12, …» */
export function summarizeBookUpdate(c: BookUpdateCounts, mode: "analyze" | "update"): string {
  const fields = Object.entries(c.fields).sort((a, b) => b[1].count - a[1].count).map(([k, v]) => `${k} ${v.count}`).join(", ");
  const notes = Object.entries(c.notes).map(([k, v]) => `${k}: ${v}`).join("; ");
  const inst = Object.values(c.institutions);
  const instText = inst.length ? `Institusjoner (ikke forfatter): ${inst.length} navn på ${inst.reduce((n, i) => n + i.count, 0)} bøker` : "";
  return `${c.changed} ${mode === "analyze" ? "ville blitt endret" : "endret"}, ${c.unchanged} uendret, ` +
    `hoppet over ${c.skippedNoIsbn + c.skippedNoOnix + c.skippedNotBook + c.skippedProtected + c.skippedDuplicate} (${c.skippedNoIsbn} uten ISBN, ${c.skippedNoOnix} uten ONIX, ${c.skippedNotBook} ikke bok, ${c.skippedProtected} beskyttet, ${c.skippedDuplicate} DUPLIKAT), ${c.errors} feil` +
    (fields ? `. Felt: ${fields}` : "") + (notes ? `. ${notes}` : "") + (instText ? `. ${instText}` : "");
}
