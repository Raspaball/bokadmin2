// supabase/functions/_shared/publish-books.ts
// Publiseringsfasen (09.10.2026): synliggjøre aktive bøker i Online Store, og INGENTING annet.
// Rene regler (testes i scripts/publish-books.test.mjs). Funksjonen publish-books/index.ts henter
// dataene og sender den ene mutasjonen; her avgjøres bare om en bok skal publiseres.
//
// Kravene per bok, rett før publisering (samme som kartleggingen «De 3 280 skjulte bøkene»):
// finnes og er ACTIVE, ISBN stemmer med lista, ikke beskyttet, ikke duplikat, finnes hos Bokbasen
// (fersk ONIX), fysisk bok (ProductForm B*, boktype «Bok»), og ONIX-regelen sier at boka forblir aktiv.
// Produkttype, status, handle, SEO, tagger, pris og metafelt røres aldri.

import { extractIsbn } from "./isbn.js";
import { extractAvailabilityCode, extractProductForm } from "./onix.js";
import { availabilityRule } from "./availability.ts";
import { bookFormat, isBookForm, notBookMessage } from "./book-format.ts";
import { protectedProduct, protectedProductMessage, type ProtectableProduct } from "./protected.ts";
import type { SkipReason } from "./job-log.ts";

export const ONLINE_STORE_NAME = "Online Store";
export const PUBLISH_ONLY_MUTATION = "publishablePublish";
export const UNPUBLISH_ONLY_MUTATION = "publishableUnpublish";

export const PUBLISH_PRODUCTS_QUERY = `query publishCheck($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id title handle status vendor productType tags publishedAt
      bokIsbn: metafield(namespace: "bok", key: "isbn") { value }
      variants(first: 1) { nodes { barcode sku } }
      resourcePublicationsV2(first: 25, onlyPublished: true) { nodes { publication { id } } }
    }
  }
}`;

export const PUBLICATIONS_NAMED_QUERY = `query publicationNames { publications(first: 25) { nodes { id name } } }`;

export const DUPLICATE_LOOKUP_QUERY = `query duplicateLookup($q: String!) { products(first: 5, query: $q) { nodes { id } } }`;

export const PUBLISH_MUTATION = `mutation publishOnlineStore($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { userErrors { field message } }
}`;

export const UNPUBLISH_MUTATION = `mutation unpublishOnlineStore($id: ID!, $input: [PublicationInput!]!) {
  publishableUnpublish(id: $id, input: $input) { userErrors { field message } }
}`;

export interface PublishProduct extends ProtectableProduct {
  id: string;
  title?: string | null;
  handle?: string | null;
  status?: string | null;
  productType?: string | null;
  publishedAt?: string | null;
  bokIsbn?: { value?: string | null } | null;
  variants?: { nodes?: Array<{ barcode?: string | null; sku?: string | null }> } | null;
  /** Kanalene boka er publisert på nå (publication-ID-er) */
  publishedOn: string[];
}

export interface PublishInput {
  /** ISBN fra den lokale lista */
  expectedIsbn: string;
  /** null = fant ikke produktet */
  product: PublishProduct | null;
  /** Antall produkter i butikken med samme ISBN (strekkode eller SKU), inkludert dette */
  sameIsbnCount: number;
  /** undefined = oppslaget feilet, null = Bokbasen har ikke boka, ellers rå ONIX (fersk) */
  onixXml: string | null | undefined;
  /** ID-en til kanalen «Online Store», null hvis den ikke finnes */
  onlineStoreId: string | null;
}

export type PublishDecision =
  | { action: "publish"; message: string }
  | { action: "unchanged"; message: string }
  | { action: "skip"; reason: SkipReason | null; message: string }
  | { action: "error"; message: string };

const skip = (message: string, reason: SkipReason | null = null): PublishDecision => ({ action: "skip", reason, message });

export function decidePublish(i: PublishInput): PublishDecision {
  const p = i.product;
  if (!p) return skip("Hoppet over: fant ikke produktet i butikken");
  if (p.status !== "ACTIVE") return skip(`Hoppet over: produktet er ikke aktivt (${String(p.status ?? "ukjent").toLowerCase()})`);
  if (protectedProduct(p)) return skip(protectedProductMessage(p), "beskyttet");
  const isbn = extractIsbn(p);
  if (!isbn) return skip("Hoppet over: ingen ISBN", "ingen_isbn");
  if (isbn !== i.expectedIsbn) return skip(`Hoppet over: ISBN i butikken stemmer ikke med lista`);
  if (i.sameIsbnCount > 1) return skip(`Hoppet over: DUPLIKAT (samme ISBN på ${i.sameIsbnCount} produkter)`, "duplikat");
  if (i.onixXml === undefined) return { action: "error", message: "Bokbasen svarte ikke (ONIX kunne ikke hentes). Prøv igjen." };
  if (i.onixXml === null) return skip("Hoppet over: fant ikke boka i Bokbasen", "ikke_i_bokbasen");
  const { form, details } = extractProductForm(i.onixXml);
  if (!isBookForm(form) || bookFormat(form, details).productType !== "Bok") return skip(notBookMessage(form), "ikke_bok");
  const rule = availabilityRule(extractAvailabilityCode(i.onixXml));
  if (rule.status !== "ACTIVE") {
    return skip(`Hoppet over: ONIX-regelen gjør boka til ${rule.status === "DRAFT" ? "utkast" : "arkivert"} (kode ${rule.code || "tom"})`);
  }
  if (!i.onlineStoreId) return { action: "error", message: "Fant ikke salgskanalen «Online Store» i butikken." };
  if (p.publishedOn.includes(i.onlineStoreId)) return { action: "unchanged", message: "Uendret: allerede publisert i Online Store" };
  return { action: "publish", message: "Publiseres i Online Store (ingen andre felt røres)" };
}

/** Rollback: avpubliseres bare hvis boka faktisk er publisert i Online Store nå. */
export function decideUnpublish(p: PublishProduct | null, onlineStoreId: string | null): PublishDecision {
  if (!p) return skip("Hoppet over: fant ikke produktet i butikken");
  if (!onlineStoreId) return { action: "error", message: "Fant ikke salgskanalen «Online Store» i butikken." };
  if (protectedProduct(p)) return skip(protectedProductMessage(p), "beskyttet");
  if (!p.publishedOn.includes(onlineStoreId)) return { action: "unchanged", message: "Uendret: ikke publisert i Online Store" };
  return { action: "publish", message: "Avpubliseres fra Online Store (tilbakerulling)" };
}

/** Kanalene fra svaret på PUBLISH_PRODUCTS_QUERY */
// deno-lint-ignore no-explicit-any
export function toPublishProduct(node: any): PublishProduct | null {
  if (!node?.id) return null;
  return {
    id: node.id, title: node.title, handle: node.handle, status: node.status, vendor: node.vendor,
    productType: node.productType, tags: node.tags ?? [], publishedAt: node.publishedAt ?? null,
    bokIsbn: node.bokIsbn ?? null, variants: node.variants ?? null,
    publishedOn: (node.resourcePublicationsV2?.nodes ?? []).map((n: { publication?: { id?: string } }) => n.publication?.id).filter(Boolean) as string[],
  };
}
